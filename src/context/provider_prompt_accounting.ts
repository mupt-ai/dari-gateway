import {
  isRecord,
  stableStringify,
  type CandidatePromptAccounting,
} from "@mupt-ai/dari-router/policy-engine";

import { toolsByWireName } from "../interaction/tool_identity.js";
import type {
  InteractionContent,
  InteractionRequest,
  ProviderIdentity,
} from "../interaction/types.js";
import { buildContext } from "../providers/pi_context.js";
import { isOpenAIResponsesApi } from "../providers/model_capabilities.js";
import type { InteractionPrefixContext } from "./interaction_fingerprint.js";

type PromptMetrics = {
  blockDepth: number;
  serializedChars: number;
};

const ACCOUNTING_IMAGE_URL = "data:image/png;base64,AA==";
const IMAGE_ESTIMATED_TOKENS = {
  low: 512,
  auto: 1024,
  high: 2048,
  original: 2048,
} as const;
const CHARS_PER_ESTIMATED_TOKEN = 4;

// Cost and cache-lookback estimates are candidate-specific because compatible
// continuation state and provider serialization can change what each model
// sees.
export function providerPromptAccounting(args: {
  request: InteractionRequest;
  prefix: InteractionPrefixContext;
  targetsByModel: ReadonlyMap<string, ProviderIdentity>;
}): CandidatePromptAccounting {
  const fullByModel = new Map<string, PromptMetrics>();
  const prefixCharsByModelAndItem = new Map<string, number>();

  const targetFor = (model: string): ProviderIdentity => {
    const target = args.targetsByModel.get(model);
    if (!target) {
      throw new Error(`missing provider target for ${model}`);
    }
    return target;
  };
  const fullMetrics = (model: string): PromptMetrics => {
    const cached = fullByModel.get(model);
    if (cached) return cached;
    const target = targetFor(model);
    const metrics = promptMetrics(args.request, target);
    fullByModel.set(model, metrics);
    return metrics;
  };

  return {
    anchorSemantics: "stored_input",
    providerBlockDepthFor: (model) => fullMetrics(model).blockDepth,
    promptEstimateFor: (model, anchor) => {
      const full = fullMetrics(model);
      if (!anchor) {
        return {
          chars: full.serializedChars,
          reusesStoredPromptTokens: false,
        };
      }

      const itemIndex = args.prefix.itemIndexByHashByModel
        .get(model)
        ?.get(anchor.hash);
      if (itemIndex === undefined) {
        return {
          chars: full.serializedChars,
          reusesStoredPromptTokens: false,
        };
      }

      const key = `${model}\u0000${itemIndex}`;
      let prefixChars = prefixCharsByModelAndItem.get(key);
      if (prefixChars === undefined) {
        prefixChars = promptMetrics(
          {
            ...args.request,
            items: args.request.items.slice(0, itemIndex + 1),
          },
          targetFor(model),
        ).serializedChars;
        prefixCharsByModelAndItem.set(key, prefixChars);
      }
      return {
        chars: Math.max(0, full.serializedChars - prefixChars),
        reusesStoredPromptTokens: true,
      };
    },
  };
}

export function promptMetrics(
  request: InteractionRequest,
  target: ProviderIdentity,
): PromptMetrics {
  const accountingInput = promptAccountingInput(request);
  const context = buildContext(accountingInput.request, target);
  const messages = context.messages.flatMap((message) => {
    const visible = providerVisibleMessage(message);
    return visible ? [visible] : [];
  });
  const tools = providerVisibleTools(request, context.tools, target);
  const prompt = {
    ...(context.systemPrompt !== undefined
      ? { systemPrompt: context.systemPrompt }
      : {}),
    ...(tools.length ? { tools } : {}),
    messages,
    ...(request.responseFormat !== undefined
      ? { responseFormat: request.responseFormat }
      : {}),
    ...(request.toolChoice !== undefined
      ? { toolChoice: request.toolChoice }
      : {}),
    ...(request.parallelToolCalls !== undefined
      ? { parallelToolCalls: request.parallelToolCalls }
      : {}),
  };
  return {
    blockDepth: messages.reduce(
      (total, message) => total + providerVisibleBlockCount(message),
      0,
    ),
    serializedChars:
      stableStringify(prompt).length + accountingInput.imageEstimatedChars,
  };
}

function providerVisibleMessage(
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.role !== "string") return null;
  if (value.role === "assistant") {
    return {
      role: value.role,
      content: sanitizeProviderContent(
        Array.isArray(value.content) ? value.content : [],
      ),
    };
  }
  if (value.role === "toolResult") {
    return {
      role: value.role,
      toolCallId: value.toolCallId ?? null,
      toolName: value.toolName ?? null,
      content: sanitizeProviderContent(
        Array.isArray(value.content) ? value.content : [],
      ),
      isError: value.isError === true,
    };
  }
  return {
    role: value.role,
    content: sanitizeProviderContent(value.content ?? ""),
  };
}

function sanitizeProviderContent(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((part) => {
    if (!isRecord(part)) return part;
    if (part.type === "providerItem" && isRecord(part.item)) {
      return part.item;
    }
    if (
      part.type === "image"
      && typeof part.mimeType === "string"
      && typeof part.data === "string"
    ) {
      return { ...part, data: "<image-data>" };
    }
    return part;
  });
}

function providerVisibleBlockCount(
  message: Record<string, unknown>,
): number {
  if (message.role === "toolResult") return 1;
  const content = message.content;
  return Math.max(1, Array.isArray(content) ? content.length : 1);
}

function providerVisibleTools(
  request: InteractionRequest,
  contextTools: Array<Record<string, unknown>> | undefined,
  target: ProviderIdentity,
): unknown[] {
  const definitions = toolsByWireName(request.tools);
  const tools = (contextTools ?? []).map((tool) => {
    if (typeof tool.name !== "string") return tool;
    const definition = definitions.get(tool.name);
    return definition?.kind !== "function"
      || definition.strict === undefined
      ? tool
      : { ...tool, strict: definition.strict };
  });
  if (!isOpenAIResponsesApi(target.api)) return tools;
  return [
    ...tools,
    ...request.tools.flatMap((tool) =>
      tool.kind === "hosted" ? [tool.config] : []
    ),
  ];
}

function promptAccountingInput(request: InteractionRequest): {
  request: InteractionRequest;
  imageEstimatedChars: number;
} {
  let imageEstimatedChars = 0;
  const sanitizeContent = (parts: InteractionContent[]) =>
    parts.map((part) => {
      if (part.type !== "image") return part;
      const detail = part.detail ?? "auto";
      imageEstimatedChars +=
        IMAGE_ESTIMATED_TOKENS[detail] * CHARS_PER_ESTIMATED_TOKEN;
      return { ...part, url: ACCOUNTING_IMAGE_URL };
    });
  const items = request.items.map((item) => {
    if (item.type === "message") {
      return { ...item, content: sanitizeContent(item.content) };
    }
    if (item.type === "tool_result" && Array.isArray(item.output)) {
      return { ...item, output: sanitizeContent(item.output) };
    }
    return item;
  });
  return {
    request: { ...request, items },
    imageEstimatedChars,
  };
}
