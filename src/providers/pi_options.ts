import type { BedrockOptions } from "@mupt-ai/pi-ai/api/bedrock-converse-stream";
import { isReasoningEffort, isRecord, type ReasoningEffort } from "@mupt-ai/dari-router/policy-engine";
import type { InteractionRequest, InteractionResponseFormat, InteractionToolChoice } from "../interaction/types";
import { requiredCapabilitiesFor } from "../interaction/capabilities";
import { toolWireName, toolsByWireName } from "../interaction/tool_identity";
import { gatewayFor, payloadWithGatewayFields } from "../models/gateways";
import { offRequiresWireNone } from "../models/runtime_overrides";
import { effectiveReasoningForModel, validateReasoningEffortForModel } from "./reasoning";
import { isBedrockApi, isOpenAIResponsesApi } from "./model_capabilities";
import type { ResolvedProviderAuth } from "../types";
import type { ProviderFetch } from "./response_capture";
import { forwardsAnthropicSafeguards, payloadWithSafeguards } from "./anthropic_safeguards";

type PiOptionsSupport = {
  getSupportedThinkingLevels?: (model: Record<string, unknown>) => string[];
};

const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";
// Anthropic rejects newer models from older Claude Code versions, so forward
// the client's own user agent and keep this fallback current for other clients.
const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.280";

export function buildOptions(
  request: InteractionRequest,
  auth: ResolvedProviderAuth | string,
  selectedModel: string,
  model: Record<string, unknown>,
  pi: PiOptionsSupport,
  sessionId?: string,
  selectedReasoningEffort?: ReasoningEffort,
  timeoutMs = 1800_000,
  signal?: AbortSignal,
  fetch?: ProviderFetch,
): Record<string, unknown> {
  const providerAuth = typeof auth === "string" ? { type: "bearer" as const, apiKey: auth } : auth;
  const authentication = isBedrockApi(model.api)
    ? bedrockAuthenticationOptions(providerAuth)
    : providerAuthenticationOptions(providerAuth);
  const options: Record<string, unknown> = {
    ...authentication,
    ...(isClaudeCodeOAuth(providerAuth, model) ? { headers: { "user-agent": request.claudeCodeUserAgent ?? CLAUDE_CODE_USER_AGENT } } : {}),
    maxRetries: 0,
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    ...(fetch === undefined ? {} : { fetch }),
    metadata: {
      ...(request.metadata ?? {}),
      ...(request.user ? { user: request.user } : {}),
    },
    // Feeds OpenAI prompt_cache_key + session-affinity headers inside pi-ai;
    // ignored by providers without session-based caching.
    ...(sessionId ? { sessionId } : {}),
  };
  // Pi's Anthropic transport honors compat.supportsTemperature; the OpenAI
  // transports forward temperature regardless, so drop it here for models
  // that reject it instead of failing the whole request.
  if (
    request.generation.temperature !== undefined
    && !(isRecord(model.compat) && model.compat.supportsTemperature === false)
  ) {
    options.temperature = request.generation.temperature;
  }
  if (request.generation.maxOutputTokens !== undefined) options.maxTokens = request.generation.maxOutputTokens;
  const payloadPatches: Array<(payload: Record<string, unknown>) => unknown> = [];
  if (request.generation.topP !== undefined || request.generation.stop !== undefined) {
    payloadPatches.push((payload) => payloadWithSamplingControls(payload, request, model));
  }
  const requestedReasoningBudget = request.reasoning?.budgetTokens;
  if (request.reasoning?.enabled === false && model.api === "anthropic-messages") {
    payloadPatches.push((payload) => ({
      ...payload,
      thinking: { type: "disabled" },
    }));
  } else if (requestedReasoningBudget !== undefined && model.api === "anthropic-messages") {
    payloadPatches.push((payload) => ({
      ...payload,
      thinking: {
        ...(isRecord(payload.thinking) ? payload.thinking : {}),
        type: "enabled",
        budget_tokens: requestedReasoningBudget,
      },
    }));
  }
  if (model.api === "anthropic-messages") {
    // Pi sends `thinking.block_binding: {prefix_mismatch_behavior:
    // "drop_block"}` plus the binding-controls beta on mid-conversation-effort
    // models (Fable 5.1, Opus 5). That opts every request into the preserved-
    // thinking prefix check: when a replayed thinking block's recorded prefix
    // no longer matches (client re-render, retry, or provider refusal in the
    // loop), the API silently drops the block, which mutates the prompt bytes
    // from that block onward and re-writes the rest of the conversation at
    // cache-write prices. On organizations not yet enforced (created before
    // 2026-08-31), opting out keeps the prefix stable and the cache warm; the
    // API records the mismatch without acting on it.
    payloadPatches.push((payload) => {
      const thinking = payload.thinking;
      if (!isRecord(thinking) || !isRecord(thinking.block_binding)) return undefined;
      const { block_binding: _dropped, ...thinkingRest } = thinking;
      const betas = Array.isArray(payload.betas)
        ? (payload.betas as string[]).filter((beta) => beta !== "thinking-binding-controls-2026-08-01")
        : payload.betas;
      return { ...payload, thinking: thinkingRest, betas };
    });
  }
  const gatewayFields = gatewayFor(model.provider)?.requestFields({
    zdr: model.zeroDataRetention === true,
  });
  if (gatewayFields !== undefined && Object.keys(gatewayFields).length > 0) {
    payloadPatches.push((payload) => payloadWithGatewayFields(payload, gatewayFields));
  }
  const safeguards = request.anthropicSafeguards;
  if (safeguards !== undefined && forwardsAnthropicSafeguards(request, model)) {
    payloadPatches.push((payload) => payloadWithSafeguards(payload, safeguards));
  }
  if (
    requiredCapabilitiesFor(request).includes("openai_hosted_web_search") &&
    isOpenAIResponsesApi(model.api)
  ) {
    options.emitProviderEvents = true;
    if (request.tools.some((tool) => tool.kind === "hosted")) {
      payloadPatches.push((payload) => payloadWithHostedTools(payload, request));
    }
  }
  if (
    (
      model.api === "openai-responses"
      || model.api === "azure-openai-responses"
      || model.api === "openai-completions"
    )
    && imageDetailQueues(request).size > 0
  ) {
    payloadPatches.push((payload) => payloadWithImageDetails(payload, request));
  }
  const requestedToolChoice = request.toolChoice;
  if (requestedToolChoice !== undefined) {
    if (isBedrockApi(model.api)) {
      // Bedrock builds its Converse toolConfig from options.toolChoice before
      // onPayload runs, so the choice must ride on options, not a payload patch.
      const simpleChoice = bedrockToolChoice(requestedToolChoice);
      if (simpleChoice !== undefined) options.toolChoice = simpleChoice;
    } else {
      payloadPatches.push((payload) => payloadWithToolChoice(payload, requestedToolChoice, model));
    }
  }
  if (request.tools.some((tool) =>
    tool.kind === "function" && (tool.strict !== undefined || model.api === "anthropic-messages")
  )) {
    payloadPatches.push((payload) => payloadWithStrictTools(payload, request, model));
  }
  const requestedResponseFormat = request.responseFormat;
  if (requestedResponseFormat !== undefined) {
    options.responseFormat = responseFormat(requestedResponseFormat);
    // Pi keeps responseFormat in options but does not serialize it in simple
    // OpenAI adapters, so patch the provider payload at the boundary.
    payloadPatches.push((payload) => payloadWithResponseFormat(payload, requestedResponseFormat, model));
  }
  const parallelToolCalls = request.parallelToolCalls;
  if (parallelToolCalls !== undefined) {
    payloadPatches.push((payload) => payloadWithParallelToolCalls(payload, parallelToolCalls, model));
  }
  if (model.fastMode === true) {
    if (model.provider === "openai" && model.api === "openai-responses") {
      // Pi's simple adapter currently drops serviceTier while lowering its
      // options, so patch the provider payload as well. Keep the option for
      // usage-pricing fallback once the adapter preserves it end to end.
      options.serviceTier = "priority";
      payloadPatches.push((payload) => ({ ...payload, service_tier: "priority" }));
    } else if (model.provider === "openai" && model.api === "openai-completions") {
      payloadPatches.push((payload) => ({ ...payload, service_tier: "priority" }));
    } else if (model.provider === "anthropic" && model.api === "anthropic-messages") {
      payloadPatches.push((payload) => ({ ...payload, speed: "fast" }));
      options.headers = {
        ...(isRecord(options.headers) ? options.headers : {}),
        "anthropic-beta": ANTHROPIC_FAST_MODE_BETA,
      };
    }
  }

  const supportedLevels = supportedThinkingLevels(model, pi);
  const defaultReasoningEffort = isReasoningEffort(model.defaultThinkingLevel)
    ? model.defaultThinkingLevel
    : undefined;
  const effectiveReasoning = effectiveReasoningForModel({
    request,
    selectedModel,
    supportedLevels,
    selectedReasoningEffort,
    defaultReasoningEffort,
  });
  const providerReasoning = request.reasoning?.hasConfigurationUpdate
    ? request.reasoning.baseEffort ?? defaultReasoningEffort
    : effectiveReasoning;
  if (request.reasoning?.baseEffort !== undefined) {
    validateReasoningEffortForModel(
      request.reasoning.baseEffort,
      selectedModel,
      supportedLevels,
    );
  }
  if (providerReasoning !== undefined && providerReasoning !== "off") {
    options.reasoning = providerReasoning;
  } else if (
    providerReasoning === "off" &&
    offRequiresWireNone(selectedModel) &&
    model.api === "openai-completions"
  ) {
    // These models need explicit "none" rather than the provider default.
    // Gateways use nested reasoning; direct providers use reasoning_effort.
    payloadPatches.push((payload) => {
      if (!gatewayFor(model.provider)) return { ...payload, reasoning_effort: "none" };
      const { reasoning_effort: _nativeEffort, ...rest } = payload;
      return {
        ...rest,
        reasoning: { ...(isRecord(payload.reasoning) ? payload.reasoning : {}), effort: "none" },
      };
    });
  }
  if (
    (requestedToolChoice !== undefined || parallelToolCalls !== undefined) &&
    !isBedrockApi(model.api)
  ) {
    // Some clients send the default tool_choice even after omitting tools for
    // a turn. OpenAI rejects every tool_choice value when the lowered payload
    // has no tools, so enforce that provider invariant after all tool patches.
    payloadPatches.push(payloadWithoutOrphanedToolChoice);
  }

  if (payloadPatches.length > 0) {
    options.onPayload = (payload: unknown) => applyPayloadPatches(payload, payloadPatches);
  }
  return options;
}

function providerAuthenticationOptions(auth: ResolvedProviderAuth): Record<string, unknown> {
  if (auth.type === "bearer") return { apiKey: auth.apiKey };
  throw new Error("AWS SigV4 authentication requires the Bedrock API.");
}

function isClaudeCodeOAuth(auth: ResolvedProviderAuth, model: Record<string, unknown>): boolean {
  return auth.type === "bearer"
    && model.api === "anthropic-messages"
    && auth.apiKey.includes("sk-ant-oat");
}

function bedrockAuthenticationOptions(auth: ResolvedProviderAuth): BedrockOptions {
  if (auth.type === "bearer") return { apiKey: auth.apiKey };
  return {
    env: {
      AWS_ACCESS_KEY_ID: auth.access_key_id,
      AWS_SECRET_ACCESS_KEY: auth.secret_access_key,
      AWS_SESSION_TOKEN: auth.session_token ?? "",
      AWS_REGION: auth.region,
      AWS_DEFAULT_REGION: auth.region,
      AWS_BEARER_TOKEN_BEDROCK: "",
      AWS_PROFILE: "",
    },
  };
}

function bedrockToolChoice(choice: InteractionToolChoice): unknown {
  if (typeof choice === "object" && choice.kind === "hosted") return undefined;
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: toolWireName(choice.namespace, choice.name) } };
}

// Chains payload patches, preserving each patch's "undefined means leave the
// payload unchanged" contract for the combined result.
function applyPayloadPatches(
  payload: unknown,
  patches: Array<(payload: Record<string, unknown>) => unknown>
): unknown {
  if (!isRecord(payload)) return undefined;
  let current = payload;
  let changed = false;
  for (const patch of patches) {
    const next = patch(current);
    if (isRecord(next)) {
      current = next;
      changed = true;
    }
  }
  return changed ? current : undefined;
}

function payloadWithSamplingControls(
  payload: Record<string, unknown>,
  request: InteractionRequest,
  model: Record<string, unknown>,
): Record<string, unknown> {
  const api = model.api;
  const google = api === "google-generative-ai" || api === "google-vertex";
  const bedrock = isBedrockApi(api);
  const stop = request.generation.stop;
  const stopSequences = typeof stop === "string" ? [stop] : stop;
  const controls = {
    // Anthropic rejects top_p with thinking; keep the hosted path aligned
    // with the router's unsupported Anthropic top_p control.
    ...(request.generation.topP === undefined || api === "anthropic-messages" ? {} : {
      [google || bedrock ? "topP" : "top_p"]: request.generation.topP,
    }),
    ...(stop === undefined || isOpenAIResponsesApi(api) ? {} : {
      [google || bedrock ? "stopSequences" : api === "anthropic-messages" ? "stop_sequences" : "stop"]:
        api === "openai-completions" ? stop : stopSequences,
    }),
  };
  if (google) {
    return { ...payload, config: { ...(isRecord(payload.config) ? payload.config : {}), ...controls } };
  }
  if (bedrock) {
    return {
      ...payload,
      inferenceConfig: {
        ...(isRecord(payload.inferenceConfig) ? payload.inferenceConfig : {}),
        ...controls,
      },
    };
  }
  return { ...payload, ...controls };
}

function responseFormat(format: InteractionResponseFormat): Record<string, unknown> {
  if (format.type !== "json_schema") return format;
  const { type: _, ...jsonSchema } = format;
  return {
    type: "json_schema",
    jsonSchema,
  };
}

function payloadWithResponseFormat(
  payload: unknown,
  format: InteractionResponseFormat,
  model: Record<string, unknown>
): unknown {
  if (!isRecord(payload)) return undefined;
  const providerFormat = providerResponseFormat(format, model);
  if (providerFormat === null) return undefined;
  if (model.api === "openai-responses" || model.api === "azure-openai-responses") {
    return {
      ...payload,
      text: {
        ...(isRecord(payload.text) ? payload.text : {}),
        format: providerFormat,
      },
    };
  }
  if (model.api === "openai-completions") {
    return { ...payload, response_format: providerFormat };
  }
  if (model.api === "anthropic-messages") {
    return {
      ...payload,
      output_config: {
        ...(isRecord(payload.output_config) ? payload.output_config : {}),
        format: providerFormat,
      },
    };
  }
  return undefined;
}

function providerResponseFormat(
  format: InteractionResponseFormat,
  model: Record<string, unknown>
): Record<string, unknown> | null {
  if (format.type === "text") return null;
  if (model.api === "anthropic-messages") {
    return {
      type: "json_schema",
      schema: format.type === "json_schema" ? format.schema : { type: "object" },
    };
  }
  if (format.type === "json_object") return format;
  const { type: _, ...jsonSchema } = format;
  if (model.api === "openai-responses" || model.api === "azure-openai-responses") {
    return { ...jsonSchema, type: "json_schema" };
  }
  return { type: "json_schema", json_schema: jsonSchema };
}

function payloadWithToolChoice(
  payload: Record<string, unknown>,
  choice: InteractionToolChoice,
  model: Record<string, unknown>
): Record<string, unknown> {
  if (typeof choice === "object" && choice.kind === "hosted") {
    return { ...payload, tool_choice: { type: choice.type } };
  }
  if (model.api === "anthropic-messages") {
    const toolChoice = typeof choice === "string"
      ? anthropicToolChoice(choice)
      : { type: "tool", name: toolWireName(choice.namespace, choice.name) };
    return { ...payload, tool_choice: toolChoice };
  }
  if (model.api === "openai-responses" || model.api === "azure-openai-responses") {
    const toolChoice = typeof choice === "string"
      ? openAiToolChoice(choice)
      // Pi currently declares both interaction tool kinds as JSON function tools.
      : { type: "function", name: toolWireName(choice.namespace, choice.name) };
    return { ...payload, tool_choice: toolChoice };
  }
  const toolChoice = typeof choice === "string"
    ? openAiToolChoice(choice)
    : { type: "function", function: { name: toolWireName(choice.namespace, choice.name) } };
  return { ...payload, tool_choice: toolChoice };
}

function payloadWithoutOrphanedToolChoice(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    !("tool_choice" in payload) ||
    (Array.isArray(payload.tools) && payload.tools.length > 0)
  ) {
    return undefined;
  }
  const { tool_choice: _, ...withoutToolChoice } = payload;
  return withoutToolChoice;
}

function anthropicToolChoice(choice: string): { type: string } {
  switch (choice) {
    case "required":
    case "any":
      return { type: "any" };
    default:
      return { type: choice };
  }
}

function openAiToolChoice(choice: string): string {
  return choice === "any" ? "required" : choice;
}

function payloadWithHostedTools(
  payload: Record<string, unknown>,
  request: Pick<InteractionRequest, "tools">
): Record<string, unknown> {
  const hosted = request.tools.flatMap((tool) =>
    tool.kind === "hosted" ? [{ ...tool.config }] : []
  );
  if (hosted.length === 0) return payload;
  return {
    ...payload,
    tools: [...(Array.isArray(payload.tools) ? payload.tools : []), ...hosted],
  };
}

function payloadWithStrictTools(
  payload: Record<string, unknown>,
  request: Pick<InteractionRequest, "tools">,
  model: Record<string, unknown>
): unknown {
  if (!Array.isArray(payload.tools)) return undefined;
  if (
    model.api !== "openai-responses" &&
    model.api !== "azure-openai-responses" &&
    model.api !== "openai-completions" &&
    model.api !== "anthropic-messages"
  ) {
    return undefined;
  }
  const definitions = toolsByWireName(request.tools);
  return {
    ...payload,
    tools: payload.tools.map((entry) => {
      if (!isRecord(entry)) return entry;
      if (model.api === "anthropic-messages") {
        const tool = typeof entry.name === "string" ? definitions.get(entry.name) : undefined;
        if (!tool || tool.kind !== "function") return entry;
        // defer_loading is intentionally not restored from the definition:
        // Pi decides placement (deferred batch vs force-loaded immediate), and
        // re-adding it here would recreate the cache_control/defer_loading
        // combination Anthropic rejects. The entry spread preserves Pi's choice.
        return {
          ...entry,
          ...(tool.parameters !== undefined ? { input_schema: tool.parameters } : {}),
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        };
      }
      const definition = model.api === "openai-completions" && isRecord(entry.function) ? entry.function : entry;
      const tool = typeof definition.name === "string" ? definitions.get(definition.name) : undefined;
      if (!tool || tool.kind !== "function" || tool.strict === undefined) return entry;
      if (model.api === "openai-completions") {
        return { ...entry, function: { ...definition, strict: tool.strict } };
      }
      return { ...entry, strict: tool.strict };
    }),
  };
}

function payloadWithParallelToolCalls(
  payload: Record<string, unknown>,
  enabled: boolean,
  model: Record<string, unknown>
): unknown {
  if (model.api === "openai-responses" || model.api === "azure-openai-responses" || model.api === "openai-completions") {
    return { ...payload, parallel_tool_calls: enabled };
  }
  if (model.api === "anthropic-messages" && !enabled) {
    const current = isRecord(payload.tool_choice) ? payload.tool_choice : {};
    if (current.type === "none") return undefined;
    return {
      ...payload,
      tool_choice: {
        type: typeof current.type === "string" ? current.type : "auto",
        ...current,
        disable_parallel_tool_use: true,
      },
    };
  }
  return undefined;
}

function payloadWithImageDetails(
  payload: Record<string, unknown>,
  request: InteractionRequest
): unknown {
  const details = imageDetailQueues(request);
  if (details.size === 0) return undefined;
  let changed = false;

  const patch = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(patch);
    if (!isRecord(value)) return value;

    const mapped = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, patch(entry)])
    );
    const responseUrl = mapped.type === "input_image" && typeof mapped.image_url === "string"
      ? mapped.image_url
      : undefined;
    const chatImage = mapped.type === "image_url" && isRecord(mapped.image_url)
      ? mapped.image_url
      : undefined;
    const chatUrl = typeof chatImage?.url === "string" ? chatImage.url : undefined;
    const url = responseUrl ?? chatUrl;
    if (!url) return mapped;

    const queue = details.get(url);
    const detail = queue?.shift();
    if (detail === undefined) return mapped;
    changed = true;
    if (responseUrl) return { ...mapped, detail };
    return { ...mapped, image_url: { ...chatImage, detail } };
  };

  const patched = patch(payload);
  return changed && isRecord(patched) ? patched : undefined;
}

function imageDetailQueues(
  request: InteractionRequest
): Map<string, Array<"auto" | "low" | "high" | "original">> {
  const details = new Map<string, Array<"auto" | "low" | "high" | "original">>();
  const add = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!isRecord(part) || part.type !== "image" || typeof part.url !== "string") continue;
      if (part.detail !== "auto" && part.detail !== "low" && part.detail !== "high" && part.detail !== "original") continue;
      const queue = details.get(part.url) ?? [];
      queue.push(part.detail);
      details.set(part.url, queue);
    }
  };
  for (const item of request.items) {
    if (item.type === "message") add(item.content);
    if (item.type === "tool_result") add(item.output);
  }
  return details;
}

export function supportedThinkingLevels(
  model: Record<string, unknown>,
  pi: PiOptionsSupport
): string[] {
  const explicitLevels = model.supportedThinkingLevels;
  if (Array.isArray(explicitLevels)) {
    return explicitLevels.filter((level) => typeof level === "string");
  }
  const levels = pi.getSupportedThinkingLevels?.(model);
  if (Array.isArray(levels)) {
    return levels.filter((level) => typeof level === "string");
  }
  return ["off"];
}
