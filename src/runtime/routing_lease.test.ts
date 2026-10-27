import { expect, test } from "bun:test";

import type {
  ChatMessage,
  PreviousDecision,
  ReasoningEffort,
} from "@mupt-ai/dari-router/policy-engine";

import type { ResolvedRouter } from "../types.js";
import { anthropicMessagesToInteraction } from "../protocol/input/anthropic_messages.js";
import { chatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { openAIResponsesToInteraction } from "../protocol/input/openai_responses.js";
import { selectorMessagesForInteraction } from "../strategies/selector_projection.js";
import { leasedRoutingDecision, leaseFallbackDecision } from "./routing_lease.js";

function msg(role: string): ChatMessage {
  return { role, content: "test" };
}

const DEFAULT_EFFORT: ReasoningEffort = "off";

function prev(overrides?: Partial<PreviousDecision>): PreviousDecision {
  return {
    model: overrides?.model ?? "openai/gpt-5.6-sol",
    reasoningEffort: overrides?.reasoningEffort ?? DEFAULT_EFFORT,
    reason: overrides?.reason ?? "prior turn",
  };
}

test("leasedRoutingDecision returns null without a previous decision", () => {
  expect(
    leasedRoutingDecision({
      messages: [msg("user")],
    }),
  ).toBeNull();
});

test("leasedRoutingDecision returns null on every 10th completed turn", () => {
  const assistants = Array.from({ length: 20 }, () => msg("assistant"));
  for (const count of [0, 10]) {
    expect(
      leasedRoutingDecision({
        messages: [msg("system"), ...assistants.slice(0, count)],
        previousDecision: prev(),
      }),
    ).toBeNull();
  }
});

test("leasedRoutingDecision returns the previous model on intervening turns", () => {
  const assistants = Array.from({ length: 19 }, () => msg("assistant"));
  for (const count of [1, 5, 9, 11, 15, 19]) {
    const result = leasedRoutingDecision({
      messages: [msg("system"), ...assistants.slice(0, count)],
      previousDecision: prev(),
    });
    expect(result).not.toBeNull();
    expect(result!.decision.selectedModel).toBe("openai/gpt-5.6-sol");
    expect(result!.decision.reasoningEffort).toBe("off");
    expect(result!.completedTurns).toBe(count);
    expect(result!.turnInLease).toBe((count % 10) + 1);
  }
});

test("leasedRoutingDecision preserves the previous decision reason", () => {
  const result = leasedRoutingDecision({
    messages: [msg("user"), msg("assistant")],
    previousDecision: prev({ reason: "staying warm" }),
  });
  expect(result!.decision.reason).toBe("staying warm");
});

test("leasedRoutingDecision fills in a lease reason when none is stored", () => {
  const result = leasedRoutingDecision({
    messages: [msg("user"), msg("assistant")],
    previousDecision: { model: "model/test", reasoningEffort: "off", reason: "" },
  });
  expect(result!.decision.reason).toContain("Continuing");
  expect(result!.decision.reason).toContain("10-turn");
});

test("leasedRoutingDecision ignores tool-result turns and non-assistant roles", () => {
  const result = leasedRoutingDecision({
    messages: [
      msg("system"),
      msg("user"),
      msg("assistant"),
      { role: "tool", tool_call_id: "call_1", content: "result" },
      msg("developer"),
      msg("user"),
    ],
    previousDecision: prev(),
  });
  expect(result!.completedTurns).toBe(1);
  expect(result!.turnInLease).toBe(2);
});

test("leasedRoutingDecision counts assistant messages with named tool calls", () => {
  const result = leasedRoutingDecision({
    messages: [
      msg("user"),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "result" },
    ],
    previousDecision: prev(),
  });
  expect(result!.completedTurns).toBe(1);
  expect(result!.turnInLease).toBe(2);
});

test.each([
  [
    "Chat Completions",
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [
        { role: "user", content: "First." },
        { role: "assistant", content: "Reply." },
        { role: "user", content: "Second." },
      ],
    }),
  ],
  [
    "OpenAI Responses",
    openAIResponsesToInteraction({
      model: "dari/routing",
      input: [
        { role: "user", content: "First." },
        { role: "assistant", content: "Reply." },
        { role: "user", content: "Second." },
      ],
    }),
  ],
  [
    "Anthropic Messages",
    anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 512,
      messages: [
        { role: "user", content: "First." },
        { role: "assistant", content: "Reply." },
        { role: "user", content: "Second." },
      ],
    }),
  ],
] as const)("%s retains fixed-turn lease position", (_name, interaction) => {
  const result = leasedRoutingDecision({
    messages: selectorMessagesForInteraction(interaction).messages,
    previousDecision: prev(),
  });

  expect(result?.completedTurns).toBe(1);
  expect(result?.turnInLease).toBe(2);
});

const credentials: ResolvedRouter = {
  router_id: "rtr_lease",
  organization_id: "org_1",
  api_key_id: "key_1",
  attributed_user_id: null,
  enabled_models: [
    "xai/grok-4.6",
    "openai/gpt-5.6-sol",
    "anthropic/claude-opus-5",
  ],
  provider_keys: { openrouter: "or-key", anthropic: "an-key" },
  model_fallback_enabled: true,
  fallback_requires_different_provider: true,
  model_configs: {
    "xai/grok-4.6": {
      provider: "openrouter",
      native_model_id: "x-ai/grok-4.6",
      api: "openai-completions",
      cost: { input: 2, output: 6 },
    },
    "openai/gpt-5.6-sol": {
      provider: "openrouter",
      native_model_id: "openai/gpt-5.6-sol",
      api: "openai-responses",
      cost: { input: 1.75, output: 14 },
    },
    "anthropic/claude-opus-5": {
      provider: "anthropic",
      native_model_id: "claude-opus-5",
      api: "anthropic-messages",
      cost: { input: 5, output: 25 },
    },
  },
};

test("lease fallback compares resolved providers instead of canonical prefixes", () => {
  const fallback = leaseFallbackDecision({
    candidates: [
      { model: "xai/grok-4.6", reasoningEffort: "high" },
      { model: "openai/gpt-5.6-sol", reasoningEffort: "off" },
      { model: "anthropic/claude-opus-5", reasoningEffort: "high" },
    ],
    decision: {
      selectedModel: "xai/grok-4.6",
      reasoningEffort: "high",
      reason: "leased",
    },
    credentials,
  });

  expect(fallback?.selectedModel).toBe("anthropic/claude-opus-5");
});

test("lease fallback inherits the primary lease countdown", () => {
  const fallback = leaseFallbackDecision({
    candidates: [
      { model: "xai/grok-4.6", reasoningEffort: "high" },
      { model: "anthropic/claude-opus-5", reasoningEffort: "high" },
    ],
    decision: {
      selectedModel: "xai/grok-4.6",
      reasoningEffort: "high",
      reason: "lease hold",
      leaseTurnsRemaining: 7,
    },
    credentials,
  });

  expect(fallback).toMatchObject({
    selectedModel: "anthropic/claude-opus-5",
    leaseTurnsRemaining: 7,
  });
});
