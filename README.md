<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dari-logo-dark.svg">
    <img src="assets/dari-logo-light.svg" alt="Dari" width="72">
  </picture>
</p>

<h1 align="center">Dari Gateway</h1>

<p align="center">
  <b>One endpoint for your coding agents, on your own keys and subscriptions.</b><br>
  Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses, served on the model your router picks.
</p>

<p align="center">
  <a href="https://docs.dari.dev/gateway/self-hosting"><img src="https://img.shields.io/badge/Self--Host_Guide-docs.dari.dev-111111?style=for-the-badge" alt="Self-host guide at docs.dari.dev"></a>
  <a href="#run"><img src="https://img.shields.io/badge/Quick_Start-Run_It_Locally-16A34A?style=for-the-badge" alt="Quick start: run it locally"></a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-111111" alt="Apache-2.0 license"></a>
  <img src="https://img.shields.io/badge/runtime-Bun_1.3%2B-111111" alt="Requires Bun 1.3 or later">
</p>

The gateway is the runtime behind Dari's hosted routing service, packaged to run on your own machine. Point a client at it, and each request is served on the model your router picks, using your provider API keys or your connected Claude Code and ChatGPT subscriptions. It needs no Dari account.

## Features

- **One endpoint, three protocols.** `/v1/messages`, `/v1/chat/completions`, and `/v1/responses` (plus `/v1/models`) reach API-key providers in the [Pi AI](https://www.npmjs.com/package/@mupt-ai/pi-ai) catalog, such as Anthropic, OpenAI, and OpenRouter, or any OpenAI-compatible server.
- **Subscription pooling.** Connect several Claude Code (Max/Pro) or ChatGPT plans. The gateway stays on one until it reports a usage limit, holds it until its reset, and moves to the next. When every plan is held, the provider's API key serves if you set one.
- **Failover.** A provider failure retries the router's next model.
- **Prompt-cache aware.** Conversations keep their identity and serving model across turns, so provider caches stay warm. Responses carry `X-Dari-Selected-Model`, `X-Dari-Thinking-Level`, and `X-Dari-Conversation-Id` headers for status lines.
- **Coding agents.** `dari claude`, `dari codex`, `dari opencode`, and `dari pi` from the [Dari CLI](https://github.com/mupt-ai/dari-cli) launch straight against your gateway.

The gateway is the same runtime that serves Dari's hosted routing service. Choosing among a router's models with Dari's trained routing policy (Dari Auto Routing) is optional and uses a Dari API key; without it, `dari/routing` serves the router's first available model.

## Run

Requires [Bun](https://bun.sh) 1.3 or later.

```bash
cp dari-gateway.example.yaml dari-gateway.yaml   # edit routers and models
export DARI_GATEWAY_KEYS="$(openssl rand -hex 24)" # keys your clients send
export ANTHROPIC_API_KEY=... OPENAI_API_KEY=...    # optional with subscriptions
bun install
bun run start
```

Or with Docker, from the repository root:

```bash
docker build -f dari-gateway/Dockerfile -t dari-gateway .
docker run -p 8080:8080 \
  -e DARI_GATEWAY_KEYS -e ANTHROPIC_API_KEY \
  -v "$PWD/dari-gateway.yaml:/config/dari-gateway.yaml" \
  -v dari-gateway-data:/data \
  dari-gateway
```

| Variable | Meaning |
| --- | --- |
| `DARI_GATEWAY_KEYS` | Required. Comma-separated bearer keys clients authenticate with. |
| `DARI_GATEWAY_CONFIG` | Router config file. Default `dari-gateway.yaml`. |
| `DARI_GATEWAY_DB` | SQLite database for subscriptions and conversation state. Default `dari-gateway.db`. It stores subscription tokens in plaintext; protect it like a secret. |
| `DARI_AUTO_ROUTING_API_KEY` | Optional. Select among a router's models with Dari Auto Routing. |
| `PORT` | Listen port. Default `8080`. |
| Provider keys | Each provider's standard variable, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`. |

## Configure

```yaml
routers:
  default:                 # serves /v1/...
    models:
      - anthropic/claude-sonnet-5-5
      - id: openai/gpt-5.5
        thinking: [medium, high]
    fallback: true         # retry the next model when a provider fails
    subscriptions: true    # prefer connected subscriptions over API keys
  local:                   # serves /local/v1/...
    models: [local/qwen3-coder]

providers:                 # endpoints outside the built-in catalog
  local:
    baseUrl: http://localhost:8000/v1
    apiKeyEnv: LOCAL_API_KEY
```

Model ids are `provider/model`. Clients send `model: "dari/routing"` to let the router choose, or `model: "dari/model/<id>"` to pin one of its models. A Claude Code subscription serves Anthropic models only for Claude Code itself; a ChatGPT subscription serves OpenAI models for every client.

### Model catalog

`GET /v1/models?detail=1` (any gateway key; optionally `&provider=openrouter,meta`) and `listModelCatalog({ providers?, fetch?, signal? })` list each provider's tool-capable models as `dari/model/<id>`-ready ids with context window, max output tokens, input modalities, accepted thinking levels, and list prices in USD per million tokens (input, output, cache read, cache write, long-context tiers) with `price_as_of`. OpenRouter and Vercel AI Gateway are read live from their public models endpoints; other providers (default: OpenAI, Anthropic, Meta, xAI, Fireworks) come from the bundled Pi catalog.

## Coding agents

```bash
export DARI_GATEWAY_URL=http://localhost:8080
export DARI_GATEWAY_KEY=<one of DARI_GATEWAY_KEYS>

dari credentials subscription connect claude-code   # or codex; repeat to pool plans
dari claude
```

In gateway mode the CLI makes no calls to Dari's hosted API. `dari credentials subscription list`, `rename`, `mark-available`, and `disconnect` manage the gateway's subscriptions.

## Embed

Deployments with their own storage and accounting compose the runtime with a `GatewayPlatform` (router resolution, conversation state, subscription holds, request records, error reporting) and a selector backend:

```ts
import { createPrioritySelectorBackend, createRequestHandler } from "@mupt-ai/dari-gateway";

const handler = createRequestHandler({ platform, selectorBackend: createPrioritySelectorBackend() });
Bun.serve({ port: 8080, fetch: handler, idleTimeout: 0 });
```

The root entry needs no Bun APIs, so any runtime with web-standard `fetch`, `Request`, and `Response` can serve the handler. `startServer` and `startSelfHostedGateway` (Bun.serve and bun:sqlite) are in `@mupt-ai/dari-gateway/bun`. `src/self_host/` is the reference platform.

Platforms can also:

- implement `resolveProviderCredential({ provider, model, routerId, organizationId, apiKey })` to supply a per-request `{ apiKey, baseUrl?, headers? }`, such as a tenant's own key, in place of the router's resolved key;
- resolve routers with `strict: true` to serve only the requested `dari/model/<id>` at the requested thinking level, with no selector, lease, fallback, or personal subscription;
- read exact usage from `recordRequest`: the summary carries input, output, cache-read, and cache-write tokens and `total_cost_usd`, preferring the provider's billed cost (`cost_source: "provider"`, from OpenRouter and Vercel AI Gateway). Failed and aborted requests are recorded too;
- attribute cost with `X-Dari-Tags: run=r1,trial=3`, which is parsed into `RequestRecord.tags` and the `recordUsage` payload's `tags`.

## Development

```bash
(cd ../dari-router && bun install --frozen-lockfile && bun run build)
bun install --frozen-lockfile
bun run typecheck
bun test
```

Tests make no provider or network calls.

## License

[Apache-2.0](LICENSE) © 2026 Mupt AI.
