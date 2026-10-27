import { subscriptionUsageLimitFromFailure } from "./subscription_limits.js";

export type ProviderAttemptFailure =
  | {
      kind: "provider_failed";
      message: Record<string, unknown>;
      latencyMs: number;
      retryable: boolean;
    }
  | {
      kind: "customer_canceled";
      message: Record<string, unknown>;
      latencyMs: number;
      retryable: false;
    };

export type ProviderAttemptResult<T> =
  | { kind: "succeeded"; value: T; latencyMs: number }
  | ProviderAttemptFailure;

export type ProviderAttemptPlanResult<TChoice, TValue> = {
  choice: TChoice;
  attempt: number;
  latencyMs: number;
} & (
  | { kind: "succeeded"; value: TValue }
  | { kind: "provider_failed"; failure: Record<string, unknown> }
  | { kind: "customer_canceled"; failure: Record<string, unknown> }
);

type RunProviderAttemptPlanArgs<TChoice, TValue, TInitial> = {
  primary: TChoice;
  retries: number;
  resolveFallback: () => Promise<TChoice | null>;
  primaryInitial?: TInitial;
  isCustomerCanceled: (choice: TChoice) => boolean;
  canceledFailure: () => Record<string, unknown>;
  runAttempt: (args: {
    choice: TChoice;
    attempt: number;
    initial: TInitial | undefined;
  }) => Promise<ProviderAttemptResult<TValue>>;
  recordFailedAttempt: (args: {
    choice: TChoice;
    attempt: number;
    result: ProviderAttemptFailure;
  }) => void;
};

type ChoiceResult<TChoice, TValue> = ProviderAttemptPlanResult<TChoice, TValue>;

/**
 * Owns the order-sensitive provider plan shared by completion and stream setup:
 * retries within one choice, cancellation fences around asynchronous fallback
 * resolution, and one contiguous attempt record for every failed dispatch.
 */
export async function runProviderAttemptPlan<TChoice, TValue, TInitial>(
  args: RunProviderAttemptPlanArgs<TChoice, TValue, TInitial>,
): Promise<ProviderAttemptPlanResult<TChoice, TValue>> {
  if (!Number.isSafeInteger(args.retries) || args.retries < 0) {
    throw new Error("Provider retries must be a nonnegative integer.");
  }
  const primary = await runChoice(args, args.primary, args.primaryInitial);
  if (primary.kind !== "provider_failed") return primary;
  // The user's next subscription serves a retry of this same choice, which
  // beats a fallback model billed elsewhere.
  if (subscriptionUsageLimitFromFailure(primary.failure)?.switched === true) return primary;
  // A disconnect before or during fallback resolution stays attributed to the
  // primary: it is the only choice that was dispatched, and a resolved but
  // undispatched fallback must not appear as the serving model.
  const canceledAfterPrimary = () =>
    syntheticCancellation(args, {
      choice: args.primary,
      attempt: primary.attempt + 1,
      latencyMs: primary.latencyMs,
    });
  if (args.isCustomerCanceled(args.primary)) return canceledAfterPrimary();

  const fallback = await args.resolveFallback();
  if (args.isCustomerCanceled(args.primary)) return canceledAfterPrimary();
  if (fallback === null) return primary;

  const fallbackResult = await runChoice(args, fallback, undefined);
  return {
    ...fallbackResult,
    latencyMs: primary.latencyMs + fallbackResult.latencyMs,
  };
}

async function runChoice<TChoice, TValue, TInitial>(
  args: RunProviderAttemptPlanArgs<TChoice, TValue, TInitial>,
  choice: TChoice,
  initial: TInitial | undefined,
): Promise<ChoiceResult<TChoice, TValue>> {
  let latencyMs = 0;
  let lastFailure: Record<string, unknown> | null = null;
  let lastAttempt = 0;

  for (let attempt = 1; attempt <= args.retries + 1; attempt += 1) {
    lastAttempt = attempt;
    if (attempt !== 1 || initial === undefined) {
      if (args.isCustomerCanceled(choice)) {
        return syntheticCancellation(args, { choice, attempt, latencyMs });
      }
    }

    const result = await args.runAttempt({
      choice,
      attempt,
      initial: attempt === 1 ? initial : undefined,
    });
    latencyMs += result.latencyMs;
    if (result.kind === "succeeded") {
      return { kind: "succeeded", choice, attempt, latencyMs, value: result.value };
    }

    args.recordFailedAttempt({ choice, attempt, result });
    lastFailure = result.message;
    if (result.kind === "customer_canceled") {
      return {
        kind: "customer_canceled",
        choice,
        attempt,
        latencyMs,
        failure: result.message,
      };
    }
    if (!result.retryable) break;
  }

  if (lastFailure === null) {
    throw new Error("Provider attempt plan completed without an attempt.");
  }

  return {
    kind: "provider_failed",
    choice,
    attempt: lastAttempt,
    latencyMs,
    failure: lastFailure,
  };
}

function syntheticCancellation<TChoice, TValue, TInitial>(
  args: RunProviderAttemptPlanArgs<TChoice, TValue, TInitial>,
  state: { choice: TChoice; attempt: number; latencyMs: number },
): ProviderAttemptPlanResult<TChoice, TValue> {
  return {
    kind: "customer_canceled",
    ...state,
    failure: args.canceledFailure(),
  };
}
