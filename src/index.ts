// Public entry points. Every module is also importable by path
// (`@mupt-ai/dari-gateway/<dir>/<module>`) for deployments that compose the
// gateway with their own platform.
export { createRequestHandler, type GatewayHandlerOptions } from "./http/handler";
export { installShutdownHandlers, startServer } from "./http/serve";
export type {
  GatewayPlatform,
  OperationalErrorContext,
  PendingLeaseWrite,
  PrefixStateWrite,
  RequestErrorContext,
  RequestRecord,
  RequestSummary,
  ResolveRouterRequest,
  SubscriptionHold,
} from "./platform/platform";
export { createAutoRoutingSelectorBackend } from "./strategies/auto_routing_selector";
export { createPrioritySelectorBackend } from "./strategies/priority_selector";
export { createLlmSelectorBackend, type SelectorBackend } from "./strategies/routing";
export type { ResolvedRouter } from "./types";
export { startSelfHostedGateway } from "./self_host/main";
