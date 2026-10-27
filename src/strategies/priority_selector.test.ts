import { expect, test } from "bun:test";

import { createPrioritySelectorBackend } from "./priority_selector.js";
import { selectModel } from "./routing.js";

test("priority selection serves the first candidate and derives its fallback", async () => {
  const run = await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: [
      { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "medium" },
      { model: "openai/gpt-5.5", reasoningEffort: "high" },
    ],
    modelFallbackEnabled: true,
    fallbackRequiresDifferentProvider: false,
    selectorBackend: createPrioritySelectorBackend(),
  });
  expect(run.decision).toMatchObject({
    selectedModel: "anthropic/claude-sonnet-4-5",
    reasoningEffort: "medium",
  });
  expect(run.fallbackDecision).toMatchObject({
    selectedModel: "openai/gpt-5.5",
    reasoningEffort: "high",
  });
  expect(run.selectorRequest.messages?.some((message) => message.content === "hello")).toBe(false);
});
