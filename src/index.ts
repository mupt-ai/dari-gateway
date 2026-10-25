// Public entry points. Every module is also importable by path
// (`@mupt-ai/dari-gateway/<dir>/<module>`) for deployments that compose the
// gateway with their own platform. This entry needs no Bun APIs; the Bun
// server and the SQLite-backed self-hosted gateway live in `./bun`.
export { createRequestHandler, type GatewayHandlerOptions } from "./http/handler";
export type {
  GatewayPlatform,
  OperationalErrorContext,
  PendingLeaseWrite,
  PrefixStateWrite,
  ProviderCredentialRequest,
  RequestErrorContext,
  RequestRecord,
  RequestSummary,
  RequestTags,
  ResolveRouterRequest,
  SubscriptionHold,
} from "./platform/platform";
export { createAutoRoutingSelectorBackend } from "./strategies/auto_routing_selector";
export { createPrioritySelectorBackend } from "./strategies/priority_selector";
export { createLlmSelectorBackend, type SelectorBackend } from "./strategies/routing";
export type { ProviderCredential, ResolvedRouter } from "./types";
