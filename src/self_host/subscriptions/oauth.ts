import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth protocols for personal subscriptions: Claude Code (PKCE, the user
 * pastes back the `code#state` Anthropic shows) and ChatGPT/Codex (device
 * code, the gateway polls for approval). Every network call goes through the
 * injected `fetch`.
 */

export type SubscriptionProvider = "anthropic_claude_code" | "openai_codex";

export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = [
  "anthropic_claude_code",
  "openai_codex",
];

export type OAuthFetch = (url: string, init: RequestInit) => Promise<Response>;

export type OAuthOptions = { fetch: OAuthFetch; now?: Date };

/** The provider refused or could not be reached (HTTP 502 at the edge). */
export class SubscriptionOAuthProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SubscriptionOAuthProviderError";
  }
}

/** The user's input or flow state is wrong (HTTP 400 at the edge). */
export class SubscriptionOAuthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionOAuthInputError";
  }
}

export type OAuthAuthorization = {
  authorizationUrl: string;
  expiresAt: Date;
  // Shown to the user for the device-code flow only.
  userCode: string | null;
  // Secret per-flow state the completion step needs.
  flow: Record<string, string>;
};

export type OAuthTokens = {
  provider: SubscriptionProvider;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  // The ChatGPT account the token acts for; null for Claude Code.
  accountId: string | null;
  accountEmail: string | null;
};

const FLOW_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const INCOMPLETE = "Subscription OAuth provider returned an incomplete response.";

export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Anthropic shows `code#state` on its own callback page for the user to paste back.
const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_CODE_SCOPES =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const CODEX_AUTHORIZE_URL = `${OPENAI_AUTH_BASE_URL}/codex/device`;
const CODEX_DEVICE_AUTH_URL = `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth`;
const CODEX_TOKEN_URL = `${OPENAI_AUTH_BASE_URL}/oauth/token`;
const CODEX_REDIRECT_URI = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

export const CODEX_APPROVAL_PENDING =
  "OpenAI approval is still pending. Enter the code at OpenAI, finish approval, then try again.";

export async function startOAuth(
  provider: SubscriptionProvider,
  options: OAuthOptions,
): Promise<OAuthAuthorization> {
  const expiresAt = new Date((options.now ?? new Date()).getTime() + FLOW_TIMEOUT_MS);
  if (provider === "anthropic_claude_code") {
    const verifier = randomUrlSafe(32);
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    // The pasted `code#state` is shown to the user, so state must not be the verifier.
    const state = randomUrlSafe(32);
    const query = new URLSearchParams({
      code: "true",
      client_id: CLAUDE_CODE_CLIENT_ID,
      response_type: "code",
      redirect_uri: CLAUDE_REDIRECT_URI,
      scope: CLAUDE_CODE_SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    return {
      authorizationUrl: `${CLAUDE_AUTHORIZE_URL}?${query}`,
      expiresAt,
      userCode: null,
      flow: { code_verifier: verifier, state },
    };
  }
  const payload = await postJson(
    options.fetch,
    `${CODEX_DEVICE_AUTH_URL}/usercode`,
    { client_id: CODEX_CLIENT_ID },
    "OpenAI device code request",
  );
  const userCode = requiredString({ user_code: payload.user_code || payload.usercode }, "user_code");
  return {
    authorizationUrl: CODEX_AUTHORIZE_URL,
    expiresAt,
    userCode,
    flow: { device_auth_id: requiredString(payload, "device_auth_id"), user_code: userCode },
  };
}

/**
 * Finish a flow. Claude Code needs the pasted authorization response; the
 * device-code flow ignores it and asks OpenAI whether the user approved.
 */
export async function completeOAuth(
  provider: SubscriptionProvider,
  flow: Record<string, string>,
  authorizationResponse: string,
  options: OAuthOptions,
): Promise<OAuthTokens> {
  const now = options.now ?? new Date();
  if (provider === "anthropic_claude_code") {
    const verifier = requiredString(flow, "code_verifier");
    const expectedState = requiredString(flow, "state");
    if (!authorizationResponse.trim()) {
      throw new SubscriptionOAuthInputError("Anthropic authorization code is required.");
    }
    const { code, state } = parseAuthorizationResponse(authorizationResponse);
    if (state !== null && state !== expectedState) {
      throw new SubscriptionOAuthInputError("Anthropic authorization state does not match. Start again.");
    }
    const token = await postJson(
      options.fetch,
      CLAUDE_TOKEN_URL,
      {
        grant_type: "authorization_code",
        client_id: CLAUDE_CODE_CLIENT_ID,
        code,
        state: state ?? expectedState,
        redirect_uri: CLAUDE_REDIRECT_URI,
        code_verifier: verifier,
      },
      "Anthropic subscription token exchange",
    );
    return claudeTokens(token, now, null);
  }

  // The provider, not user-supplied input, supplies the authorization code.
  let approval: Record<string, unknown>;
  try {
    approval = await postJson(
      options.fetch,
      `${CODEX_DEVICE_AUTH_URL}/token`,
      {
        device_auth_id: requiredString(flow, "device_auth_id"),
        user_code: requiredString(flow, "user_code"),
      },
      "OpenAI device approval check",
    );
  } catch (error) {
    if (error instanceof SubscriptionOAuthProviderError && (error.status === 403 || error.status === 404)) {
      throw new SubscriptionOAuthInputError(CODEX_APPROVAL_PENDING);
    }
    throw error;
  }
  const token = await postForm(
    options.fetch,
    CODEX_TOKEN_URL,
    {
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code: requiredString(approval, "authorization_code"),
      code_verifier: requiredString(approval, "code_verifier"),
      redirect_uri: CODEX_REDIRECT_URI,
    },
    "OpenAI subscription token exchange",
  );
  return codexTokens(token, now, null, null);
}

export async function refreshOAuth(
  credential: { provider: SubscriptionProvider; refreshToken: string; accountId: string | null },
  options: OAuthOptions,
): Promise<OAuthTokens> {
  const now = options.now ?? new Date();
  if (credential.provider === "anthropic_claude_code") {
    const token = await postJson(
      options.fetch,
      CLAUDE_TOKEN_URL,
      {
        grant_type: "refresh_token",
        client_id: CLAUDE_CODE_CLIENT_ID,
        refresh_token: credential.refreshToken,
        scope: CLAUDE_CODE_SCOPES,
      },
      "Anthropic subscription token refresh",
    );
    return claudeTokens(token, now, credential.refreshToken);
  }
  const token = await postJson(
    options.fetch,
    CODEX_TOKEN_URL,
    {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: CODEX_CLIENT_ID,
    },
    "OpenAI subscription token refresh",
  );
  return codexTokens(token, now, credential.refreshToken, credential.accountId);
}

/** Accepts the full callback URL, `code#state`, a `code=...&state=...` query, or a bare code. */
export function parseAuthorizationResponse(value: string): { code: string; state: string | null } {
  const normalized = value.trim();
  if (URL.canParse(normalized)) {
    const parsed = new URL(normalized);
    const code = parsed.searchParams.get("code");
    if (parsed.host && code) return { code, state: parsed.searchParams.get("state") || null };
  }
  const hash = normalized.indexOf("#");
  if (hash > 0) {
    return { code: normalized.slice(0, hash), state: normalized.slice(hash + 1) || null };
  }
  if (normalized.includes("code=")) {
    const query = new URLSearchParams(normalized);
    const code = query.get("code");
    if (code) return { code, state: query.get("state") || null };
  }
  if (normalized) return { code: normalized, state: null };
  throw new SubscriptionOAuthInputError("Authorization code or redirect URL is required.");
}

function claudeTokens(
  payload: Record<string, unknown>,
  now: Date,
  fallbackRefreshToken: string | null,
): OAuthTokens {
  const account = payload.account;
  const email = isRecord(account) ? account.email_address : undefined;
  return {
    provider: "anthropic_claude_code",
    accessToken: requiredString(payload, "access_token"),
    refreshToken: refreshTokenFrom(payload, fallbackRefreshToken),
    expiresAt: new Date(now.getTime() + positiveInt(payload.expires_in) * 1000),
    accountId: null,
    accountEmail: typeof email === "string" && email ? email : null,
  };
}

function codexTokens(
  payload: Record<string, unknown>,
  now: Date,
  fallbackRefreshToken: string | null,
  fallbackAccountId: string | null,
): OAuthTokens {
  const accessToken = requiredString(payload, "access_token");
  const refreshToken = refreshTokenFrom(payload, fallbackRefreshToken);
  const idToken = typeof payload.id_token === "string" ? payload.id_token : null;
  const accountId = (idToken === null ? null : codexAccountId(idToken))
    ?? codexAccountId(accessToken)
    ?? fallbackAccountId;
  if (accountId === null) {
    throw new SubscriptionOAuthProviderError("OpenAI subscription token is missing its account identifier.");
  }
  const email = idToken === null ? undefined : jwtPayload(idToken)?.email;
  return {
    provider: "openai_codex",
    accessToken,
    refreshToken,
    expiresAt: codexExpiration(payload, accessToken, now),
    accountId,
    accountEmail: typeof email === "string" && email ? email : null,
  };
}

function codexAccountId(token: string): string | null {
  const auth = jwtPayload(token)?.[CODEX_ACCOUNT_CLAIM];
  const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  return typeof accountId === "string" && accountId ? accountId : null;
}

function codexExpiration(payload: Record<string, unknown>, accessToken: string, now: Date): Date {
  if (payload.expires_in !== undefined && payload.expires_in !== null) {
    return new Date(now.getTime() + positiveInt(payload.expires_in) * 1000);
  }
  const exp = jwtPayload(accessToken)?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) return new Date(exp * 1000);
  throw new SubscriptionOAuthProviderError("OpenAI subscription token is missing its expiration.");
}

function refreshTokenFrom(payload: Record<string, unknown>, fallback: string | null): string {
  const value = payload.refresh_token;
  const refreshToken = typeof value === "string" && value ? value : fallback;
  if (!refreshToken) throw new SubscriptionOAuthProviderError(INCOMPLETE);
  return refreshToken;
}

function requiredString(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || !value) throw new SubscriptionOAuthProviderError(INCOMPLETE);
  return value;
}

function positiveInt(value: unknown): number {
  const parsed = typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value) ? Number(value) : value;
  if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new SubscriptionOAuthProviderError(INCOMPLETE);
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function postJson(
  fetch: OAuthFetch,
  url: string,
  payload: Record<string, string>,
  operation: string,
): Promise<Record<string, unknown>> {
  return requestJson(fetch, url, JSON.stringify(payload), "application/json", operation);
}

function postForm(
  fetch: OAuthFetch,
  url: string,
  payload: Record<string, string>,
  operation: string,
): Promise<Record<string, unknown>> {
  return requestJson(fetch, url, new URLSearchParams(payload).toString(), "application/x-www-form-urlencoded", operation);
}

async function requestJson(
  fetch: OAuthFetch,
  url: string,
  body: string,
  contentType: string,
  operation: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": contentType, "User-Agent": "Dari/1.0" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SubscriptionOAuthProviderError(`${operation} could not reach the provider.`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SubscriptionOAuthProviderError(
      `${operation} failed with provider status ${response.status}.`,
      response.status,
    );
  }
  let decoded: unknown;
  try {
    decoded = await response.json();
  } catch {
    throw new SubscriptionOAuthProviderError(`${operation} returned an invalid response.`);
  }
  if (!isRecord(decoded)) throw new SubscriptionOAuthProviderError(`${operation} returned an invalid response.`);
  return decoded;
}

function randomUrlSafe(size: number): string {
  return base64Url(randomBytes(size));
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
