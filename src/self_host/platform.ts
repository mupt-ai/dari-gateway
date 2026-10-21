import { errorCode } from "../http/errors";
import type { GatewayPlatform } from "../platform/platform";
import type { PrefixStore } from "./prefix_store";
import { resolveSelfHostedRouter, type SelfHostedResolverDeps } from "./resolve";
import type { SubscriptionStore } from "./subscriptions";

/**
 * The self-hosted platform: routers from the config file, subscriptions and
 * prefix-cache state in the gateway's SQLite database, and one content-free
 * log line per request.
 */
export function createSelfHostedPlatform(deps: Omit<SelfHostedResolverDeps, "prefixHits"> & {
  prefixes: PrefixStore;
  subscriptions: SubscriptionStore;
}): GatewayPlatform {
  const resolver: SelfHostedResolverDeps = {
    ...deps,
    prefixHits: (args) => deps.prefixes.hits(args),
  };
  return {
    resolveRouter: (request) => resolveSelfHostedRouter(resolver, request),
    writePrefixState: async (write) => {
      deps.prefixes.write(write);
    },
    writePendingLease: async (write) => {
      deps.prefixes.writePendingLease(write, deps.config.routers[write.router_id]?.zdr ?? false);
    },
    markSubscriptionUnavailable: async (hold) =>
      hold.credentialId !== undefined &&
      deps.subscriptions.markUnavailable(hold.credentialId, hold.limit.resetsAt, hold.limit.reason),
    async recordUsage() {
      // Resolution never reports a "managed" key source here.
      throw new Error("The self-hosted gateway has no managed provider keys to account.");
    },
    recordRequest(record) {
      console.info("routing request", JSON.stringify(record.summary));
    },
    captureRequestError(error, context) {
      if (context.status < 500) return;
      console.error(
        "routing request error",
        JSON.stringify({
          router_id: context.routerId,
          request_id: context.requestId ?? null,
          source_protocol: context.sourceProtocol,
          status: context.status,
          error_code: errorCode(error, "internal_error"),
        }),
      );
    },
    captureOperationalError(error, context) {
      console.error(
        "gateway operational error",
        JSON.stringify({
          code: context.code,
          request_id: context.requestId ?? null,
          router_id: context.routerId ?? null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  };
}
