#!/usr/bin/env bun
import { chmodSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { builtinModels } from "@mupt-ai/pi-ai/providers/all";

import { bearerToken } from "../http/auth";
import { errorResponse, HttpError } from "../http/errors";
import { createRequestHandler } from "../http/handler";
import { installShutdownHandlers, startServer } from "../http/serve";
import { createAutoRoutingSelectorBackend } from "../strategies/auto_routing_selector";
import { createPrioritySelectorBackend } from "../strategies/priority_selector";
import type { SelectorBackend } from "../strategies/routing";
import { loadGatewayConfig } from "./config";
import { createSelfHostedPlatform } from "./platform";
import { gatewayKeyIndex } from "./resolve";
import { PrefixStore } from "./prefix_store";
import { handleSubscriptionRequest, SubscriptionStore } from "./subscriptions";

const SUBSCRIPTION_ROUTES = "/v1/organizations/current/credentials";

/**
 * Start a self-hosted Dari Gateway from environment variables:
 *
 * - `DARI_GATEWAY_KEYS` (required): comma-separated bearer keys clients use.
 * - `DARI_GATEWAY_CONFIG`: router config file (default `dari-gateway.yaml`).
 * - `DARI_GATEWAY_DB`: SQLite database for subscriptions and prefix-cache
 *   state (default `dari-gateway.db`). It holds subscription tokens.
 * - `DARI_AUTO_ROUTING_API_KEY`: choose among a router's models with Dari
 *   Auto Routing; without it, `dari/routing` serves the first listed model.
 * - `PORT` (default 8080), and each provider's standard API key variable.
 */
export async function startSelfHostedGateway(env: Record<string, string> = process.env as Record<string, string>) {
  const gatewayKeys = (env.DARI_GATEWAY_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (gatewayKeys.length === 0) {
    throw new Error("Set DARI_GATEWAY_KEYS to the comma-separated keys clients authenticate with.");
  }
  const config = await loadGatewayConfig(env.DARI_GATEWAY_CONFIG ?? "dari-gateway.yaml");
  const databasePath = env.DARI_GATEWAY_DB ?? "dari-gateway.db";
  const created = databasePath !== ":memory:" && !existsSync(databasePath);
  const db = new Database(databasePath, { create: true });
  if (created) chmodSync(databasePath, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  const subscriptions = new SubscriptionStore(db);
  const prefixes = new PrefixStore(db);
  // Pi's provider auth reads each provider's standard key variable, such as
  // OPENAI_API_KEY, from this environment only.
  const piModels = builtinModels({
    authContext: { env: async (name) => env[name], fileExists: async () => false },
  });

  const platform = createSelfHostedPlatform({
    config,
    gatewayKeys,
    subscriptions,
    prefixes,
    providerApiKey: async (provider) => (await piModels.getAuth(provider))?.auth.apiKey,
    env,
    fetch,
  });
  const autoRoutingKey = env.DARI_AUTO_ROUTING_API_KEY?.trim();
  const selectorBackend: SelectorBackend = autoRoutingKey
    ? createAutoRoutingSelectorBackend({
        apiKey: autoRoutingKey,
        ...(env.DARI_AUTO_ROUTING_URL ? { endpoint: env.DARI_AUTO_ROUTING_URL } : {}),
      })
    : createPrioritySelectorBackend();
  const gateway = createRequestHandler({ platform, selectorBackend });

  const handler = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname !== SUBSCRIPTION_ROUTES && !pathname.startsWith(`${SUBSCRIPTION_ROUTES}/`)) {
      return await gateway(request);
    }
    try {
      if (gatewayKeyIndex(gatewayKeys, bearerToken(request.headers)) === null) {
        throw new HttpError(401, "Missing or invalid gateway key.", "authentication_error");
      }
    } catch (error) {
      return errorResponse(error);
    }
    return (await handleSubscriptionRequest(request, { store: subscriptions, fetch }))
      ?? errorResponse(new HttpError(404, "Not found", "not_found"));
  };

  const port = Number(env.PORT ?? "8080");
  const server = startServer(port, handler);
  console.info(
    "dari-gateway listening",
    JSON.stringify({
      port,
      routers: Object.keys(config.routers),
      auto_routing: autoRoutingKey ? "dari" : "priority",
    }),
  );
  return { server, close: () => db.close() };
}

if (import.meta.main) {
  const { server, close } = await startSelfHostedGateway();
  installShutdownHandlers(server, async () => close());
}
