import { timingSafeEqual } from "node:crypto";

import {
  nativeModelId,
  providerForModel,
  type ReasoningEffort,
  type RouterModelPrice,
  type RouterPrefixHit,
} from "@mupt-ai/dari-router/policy-engine";
import { HttpError } from "../http/errors";
import type { ResolveRouterRequest } from "../platform/platform";
import { registeredModelPrice } from "../providers/pi";
import type {
  ProviderKeySource,
  ResolvedRouter,
  ResolvedRouterModelConfig,
} from "../types";
import type { GatewayConfig, RouterConfig } from "./config";
import {
  freshAccessToken,
  type OAuthFetch,
  type SubscriptionCredential,
  type SubscriptionProvider,
  type SubscriptionStore,
} from "./subscriptions";

// A self-hosted gateway is one tenant; these stand in for the hosted
// organization and the user a personal subscription belongs to.
export const SELF_HOSTED_ORGANIZATION_ID = "self-hosted";
export const SELF_HOSTED_USER_ID = "self-hosted";

const CODEX_BACKEND_URL = "https://chatgpt.com/backend-api";

export type SelfHostedResolverDeps = {
  config: GatewayConfig;
  gatewayKeys: readonly string[];
  subscriptions: SubscriptionStore;
  prefixHits: (args: {
    routerId: string;
    prefixHashes: readonly string[];
    conversationId?: string;
  }) => RouterPrefixHit[];
  // The provider's API key from its standard environment variable.
  providerApiKey: (provider: string) => Promise<string | undefined>;
  env: Record<string, string | undefined>;
  fetch: OAuthFetch;
};

type ProviderCredential = {
  key: string;
  source: ProviderKeySource;
  subscription?: SubscriptionCredential;
};

/**
 * Resolve a configured router for one request. Each provider is served by a
 * connected personal subscription when the router allows it and one is
 * available, otherwise by the provider's API key; models whose provider has
 * neither are left out.
 */
export async function resolveSelfHostedRouter(
  deps: SelfHostedResolverDeps,
  request: ResolveRouterRequest,
): Promise<ResolvedRouter> {
  const keyIndex = gatewayKeyIndex(deps.gatewayKeys, request.apiKey);
  if (keyIndex === null) {
    throw new HttpError(401, "Missing or invalid router/API key.", "routing_key_resolution_failed");
  }
  const router = deps.config.routers[request.routerId];
  if (router === undefined) {
    throw new HttpError(404, `Router ${request.routerId} is not configured on this gateway.`, "router_not_found");
  }

  const now = new Date();
  const credentials = new Map<string, ProviderCredential | null>();
  const exhausted = new Set<SubscriptionProvider>();
  for (const provider of new Set(router.models.map((model) => providerForModel(model.id)))) {
    const subscription = router.subscriptions
      ? subscriptionProviderFor(provider, request.clientHarness)
      : null;
    const active = subscription === null
      ? null
      : deps.subscriptions.activeCredential(subscription, now);
    if (active !== null) {
      credentials.set(provider, {
        key: await freshAccessToken(deps.subscriptions, active, { fetch: deps.fetch }),
        source: "subscription",
        subscription: active,
      });
      continue;
    }
    if (subscription !== null && deps.subscriptions.list(subscription).length > 0) {
      exhausted.add(subscription);
    }
    const apiKey = await providerApiKey(deps, provider);
    credentials.set(provider, apiKey ? { key: apiKey, source: "user" } : null);
  }

  const models = router.models.filter((model) => credentials.get(providerForModel(model.id)) != null);
  if (models.length === 0) throw unavailableRouterError(request.routerId, exhausted);

  const resolved: ResolvedRouter = {
    router_id: request.routerId,
    organization_id: SELF_HOSTED_ORGANIZATION_ID,
    api_key_id: `gateway_key_${keyIndex + 1}`,
    attributed_user_id: SELF_HOSTED_USER_ID,
    enabled_models: models.map((model) => model.id),
    provider_keys: {},
    provider_key_sources: {},
    subscription_credential_ids: {},
    zdr: router.zdr,
    speculative_routing: false,
    primary_retries: router.retries,
    model_fallback_enabled: router.fallback,
    fallback_requires_different_provider: router.fallbackRequiresDifferentProvider,
    lease_context_enabled: false,
    routing_strategy: "dari",
    custom_config: null,
    evals: [],
    model_thinking_levels: thinkingLevels(router),
    model_prices: {},
    model_configs: {},
    prefix_hits: deps.prefixHits({
      routerId: request.routerId,
      prefixHashes: request.prefixHashes ?? [],
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
    }),
  };
  for (const [provider, credential] of credentials) {
    if (credential == null) continue;
    for (const servingProvider of servingProviders(provider, credential)) {
      resolved.provider_keys[servingProvider] = credential.key;
      resolved.provider_key_sources![servingProvider] = credential.source;
      if (credential.subscription) {
        resolved.subscription_credential_ids![servingProvider] = credential.subscription.id;
      }
    }
  }
  for (const model of models) {
    const price = registeredModelPrice(model.id);
    if (price !== null) resolved.model_prices![model.id] = price;
    const provider = providerForModel(model.id);
    const endpoint = deps.config.providers[provider];
    if (credentials.get(provider)?.subscription?.provider === "openai_codex") {
      resolved.model_configs![model.id] = codexModelConfig(model.id, price);
    } else if (endpoint !== undefined) {
      resolved.model_configs![model.id] = {
        provider,
        native_model_id: nativeModelId(model.id),
        api: endpoint.api,
        base_url: endpoint.baseUrl,
        cost: price ?? { input: 0, output: 0 },
      };
    }
  }
  return resolved;
}

// Configured endpoints read their own key variable, or send a placeholder
// when they take none; known providers use their standard variable.
async function providerApiKey(deps: SelfHostedResolverDeps, provider: string): Promise<string | undefined> {
  const endpoint = deps.config.providers[provider];
  if (endpoint === undefined) return (await deps.providerApiKey(provider))?.trim() || undefined;
  if (endpoint.apiKeyEnv === undefined) return "no-key";
  return deps.env[endpoint.apiKeyEnv]?.trim() || undefined;
}

export function gatewayKeyIndex(keys: readonly string[], presented: string): number | null {
  const candidate = Buffer.from(presented);
  for (const [index, key] of keys.entries()) {
    const expected = Buffer.from(key);
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      return index;
    }
  }
  return null;
}

// Claude Code plans serve only Claude Code itself; ChatGPT plans serve any
// client through the Codex backend.
function subscriptionProviderFor(
  provider: string,
  clientHarness: ResolveRouterRequest["clientHarness"],
): SubscriptionProvider | null {
  if (provider === "anthropic") {
    return clientHarness === "claude_code" ? "anthropic_claude_code" : null;
  }
  if (provider === "openai") return "openai_codex";
  return null;
}

// A ChatGPT plan serves OpenAI models as the `openai-codex` provider, and the
// runtime looks keys up by serving provider.
function servingProviders(provider: string, credential: ProviderCredential): string[] {
  return credential.subscription?.provider === "openai_codex"
    ? [provider, "openai-codex"]
    : [provider];
}

function codexModelConfig(
  modelId: string,
  price: RouterModelPrice | null,
): ResolvedRouterModelConfig {
  return {
    provider: "openai-codex",
    native_model_id: nativeModelId(modelId),
    api: "openai-codex-responses",
    base_url: CODEX_BACKEND_URL,
    // A plan bills no tokens; the catalog price only feeds cost estimates.
    cost: price ?? { input: 0, output: 0 },
    fast_mode: false,
  };
}

function thinkingLevels(router: RouterConfig): Record<string, ReasoningEffort[]> {
  return Object.fromEntries(
    router.models.flatMap((model) => model.thinking ? [[model.id, model.thinking]] : []),
  );
}

function unavailableRouterError(
  routerId: string,
  exhausted: ReadonlySet<SubscriptionProvider>,
): HttpError {
  if (exhausted.size > 0) {
    const plans = [...exhausted]
      .map((provider) => provider === "anthropic_claude_code" ? "Claude Code" : "ChatGPT")
      .join(" and ");
    return new HttpError(
      424,
      `Every connected ${plans} subscription is at its usage limit, and no API key can serve router ${routerId} instead.`,
      "personal_subscription_unavailable",
    );
  }
  return new HttpError(
    424,
    `No credentials can serve router ${routerId}: set a provider API key or connect a subscription.`,
    "provider_credentials_missing",
  );
}
