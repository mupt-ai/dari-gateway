import { expect, test } from "bun:test";

import {
  runProviderAttemptPlan,
  type ProviderAttemptFailure,
  type ProviderAttemptResult,
} from "./provider_attempt_runner";

type Choice = "primary" | "fallback";

test("owns retries, fallback order, latency, and failed-attempt recording", async () => {
  const calls: Array<{ choice: Choice; attempt: number }> = [];
  const recorded: Array<{ choice: Choice; attempt: number; kind: string }> = [];
  const results: ProviderAttemptResult<string>[] = [
    failed("primary-1", 3),
    failed("primary-2", 5),
    { kind: "succeeded", value: "served", latencyMs: 7 },
  ];

  const result = await runProviderAttemptPlan<Choice, string, never>({
    primary: "primary",
    retries: 1,
    resolveFallback: async () => "fallback",
    isCustomerCanceled: () => false,
    canceledFailure: () => ({ errorMessage: "canceled" }),
    async runAttempt({ choice, attempt }) {
      calls.push({ choice, attempt });
      const next = results.shift();
      if (next === undefined) throw new Error("Missing scripted result.");
      return next;
    },
    recordFailedAttempt({ choice, attempt, result: failure }) {
      recorded.push({ choice, attempt, kind: failure.kind });
    },
  });

  expect(result).toEqual({
    kind: "succeeded",
    choice: "fallback",
    attempt: 1,
    latencyMs: 15,
    value: "served",
  });
  expect(calls).toEqual([
    { choice: "primary", attempt: 1 },
    { choice: "primary", attempt: 2 },
    { choice: "fallback", attempt: 1 },
  ]);
  expect(recorded).toEqual([
    { choice: "primary", attempt: 1, kind: "provider_failed" },
    { choice: "primary", attempt: 2, kind: "provider_failed" },
  ]);
});

test("does not fabricate a fallback attempt when disconnect wins before dispatch", async () => {
  let canceled = false;
  let dispatched = 0;
  const recorded: Array<{ choice: Choice; attempt: number; kind: string }> = [];

  const result = await runProviderAttemptPlan<Choice, string, never>({
    primary: "primary",
    retries: 0,
    resolveFallback: async () => {
      canceled = true;
      return "fallback";
    },
    isCustomerCanceled: () => canceled,
    canceledFailure: () => ({ errorMessage: "canceled" }),
    async runAttempt() {
      dispatched += 1;
      return failed("primary failed", 4);
    },
    recordFailedAttempt({ choice, attempt, result: failure }) {
      recorded.push({ choice, attempt, kind: failure.kind });
    },
  });

  // The resolved fallback never dispatched, so the cancellation stays on the
  // primary rather than naming a model that served nothing.
  expect(result).toMatchObject({
    kind: "customer_canceled",
    choice: "primary",
    attempt: 2,
    latencyMs: 4,
  });
  expect(dispatched).toBe(1);
  expect(recorded).toEqual([
    { choice: "primary", attempt: 1, kind: "provider_failed" },
  ]);
});

test("does not fabricate a primary attempt when canceled before first dispatch", async () => {
  let dispatched = 0;
  const recorded: string[] = [];
  const result = await runProviderAttemptPlan<Choice, string, never>({
    primary: "primary",
    retries: 2,
    resolveFallback: async () => "fallback",
    isCustomerCanceled: () => true,
    canceledFailure: () => ({ errorMessage: "canceled" }),
    async runAttempt() {
      dispatched += 1;
      return { kind: "succeeded", value: "unexpected", latencyMs: 1 };
    },
    recordFailedAttempt({ result: failure }) {
      recorded.push(failure.kind);
    },
  });

  expect(result).toMatchObject({ kind: "customer_canceled", choice: "primary" });
  expect(dispatched).toBe(0);
  expect(recorded).toEqual([]);
});

test("an already-started speculative attempt settles before cancellation is checked", async () => {
  let dispatchedInitial: string | undefined;
  const result = await runProviderAttemptPlan<Choice, string, string>({
    primary: "primary",
    retries: 0,
    primaryInitial: "speculative",
    resolveFallback: async () => null,
    isCustomerCanceled: () => true,
    canceledFailure: () => ({ errorMessage: "canceled" }),
    async runAttempt({ initial }) {
      dispatchedInitial = initial;
      return { kind: "succeeded", value: "settled", latencyMs: 2 };
    },
    recordFailedAttempt() {},
  });

  expect(dispatchedInitial).toBe("speculative");
  expect(result).toMatchObject({ kind: "succeeded", value: "settled" });
});

function failed(message: string, latencyMs: number): ProviderAttemptFailure {
  return {
    kind: "provider_failed",
    message: { errorMessage: message },
    latencyMs,
    retryable: true,
  };
}
