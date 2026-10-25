// Bun-only entry points: the Bun.serve HTTP server and the self-hosted
// gateway, whose state lives in bun:sqlite.
export { installShutdownHandlers, startServer } from "./http/serve";
export { startSelfHostedGateway } from "./self_host/main";
