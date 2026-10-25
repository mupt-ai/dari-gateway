import { randomUUID } from "node:crypto";

import {
  isRecord,
  sameRoutingCandidate,
  type PreviousDecision,
  type RouterPrefixHit,
  type RoutingDecision,
} from "@mupt-ai/dari-router/policy-engine";

import { buildRoutingContext } from "../context/routing_context";
import type { InteractionRequest } from "../interaction/types";
import {
  completeNonStreaming,
  executeNonStreaming,
  executeStreaming,
  prepareStreamingExecution,
  type CompletedNonStreamingExecution,
  type ProviderChoice,
} from "../providers/execution";
import {
  prepareProviderExecution,
  startProviderCompletion,
  startProviderStream,
  type ProviderExecution,
  type StartedCompletion,
  type StartedStream,
} from "../providers/provider_call";
import type { SelectorBackend } from "../strategies/routing";
import { routeDecision, type RoutedDecision } from "../strategies/route_decision";
import { executionProviderForModel } from "../models/execution_provider";
import { trackBackgroundTelemetry } from "../telemetry/background";
import { estimateBenchmarkReplay } from "../telemetry/benchmark_replay";
import { buildCompletedPrefixHit } from "../telemetry/prefix_state";
import { scrubSecrets } from "../telemetry/scrub";
import type { ResolvedRouter } from "../types";
import type { PreparedRoutedCompletion } from "./prepare_routed_completion";
import { auxiliaryDecision } from "./claude_code/auxiliary_routing.js";
import { explicitModelDecision, strictModelDecision } from "./explicit_model.js";
import {
  clearPendingLease,
  committedLeaseDecision,
  leaseHoldDecision,
  leasePrefetchDue,
  leasedDecision,
  pendingLeaseDecision,
  prefetchNextLease,
  selectorNegotiatesLeases,
} from "./routing_lease.js";
import type { RoutedProtocol } from "./routed_protocol";
import {
  createExperimentRoutedRuntimeReporter,
  type RoutedRuntimeReporter,
} from "./runtime_reporter";
import { HttpError } from "../http/errors";

type SpeculativeExecution = {
  decision: RoutingDecision;
  execution: ProviderExecution;
} & (
  | { transport: "completion"; started: StartedCompletion }
  | {
      transport: "stream";
      started?: StartedStream;
      initialError?: unknown;
    }
);

type RuntimeExecutionPlan = {
  primary: ProviderChoice;
  primaryRetries: number;
  resolveFallback: () => Promise<ProviderChoice | null>;
  reportBarrier?: Promise<unknown>;
  startedCompletion?: StartedCompletion;
  startedStream?: StartedStream;
  initialStreamError?: unknown;
};

export type RoutedRuntimeResult = {
  routing: RoutingDecision;
  output: CompletedNonStreamingExecution["output"];
  prefixHit?: RouterPrefixHit;
};

export class RoutedRuntimeProviderSettledError extends Error {
  readonly name = "RoutedRuntimeProviderSettledError";
  readonly runtimeResult: RoutedRuntimeResult;
  readonly cause: unknown;

  constructor(
    message: string,
    runtimeResult: RoutedRuntimeResult,
    cause: unknown,
  ) {
    super(message);
    this.runtimeResult = runtimeResult;
    this.cause = cause;
  }
}

export type ExplicitRoutedInteractionArgs = {
  routerId: string;
  interaction: InteractionRequest;
  credentials: ResolvedRouter;
  selectorBackend: SelectorBackend;
  previousDecision?: PreviousDecision;
  billable?: boolean;
  reporter?: RoutedRuntimeReporter;
};

export type {
  SelectorAdapter,
  SelectorAdapterArgs,
  SelectorBackend,
  SelectorRun,
} from "../strategies/routing";
export type {
  ExperimentRoutedRuntimeReporter,
  RoutedRuntimeReporter,
} from "./runtime_reporter";
export { createExperimentRoutedRuntimeReporter } from "./runtime_reporter";

export async function runPreparedRoutedCompletion(args: {
  prepared: PreparedRoutedCompletion;
  selectorBackend: SelectorBackend;
  clientSignal?: AbortSignal;
}): Promise<Response> {
  const plan = await prepareRuntimeExecution({
    prepared: args.prepared,
    selectorBackend: args.selectorBackend,
    clientSignal: args.clientSignal,
  });
  const { prepared } = args;
  if (!prepared.interaction.stream) {
    return executeNonStreaming({
      requestId: prepared.requestId,
      interaction: prepared.interaction,
      primary: plan.primary,
      primaryRetries: plan.primaryRetries,
      resolveFallback: plan.resolveFallback,
      reporter: prepared.reporter,
      protocol: prepared.protocol,
      startedCompletion: plan.startedCompletion,
      reportBarrier: plan.reportBarrier,
      clientSignal: args.clientSignal,
    });
  }
  const streaming = await prepareStreamingExecution({
    requestId: prepared.requestId,
    interaction: prepared.interaction,
    primary: plan.primary,
    primaryRetries: plan.primaryRetries,
    resolveFallback: plan.resolveFallback,
    reporter: prepared.reporter,
    startedStream: plan.startedStream,
    initialError: plan.initialStreamError,
    reportBarrier: plan.reportBarrier,
    clientSignal: args.clientSignal,
  });
  return executeStreaming({
    requestId: prepared.requestId,
    interaction: prepared.interaction,
    choice: streaming.choice,
    reporter: prepared.reporter,
    protocol: prepared.protocol,
    startedStream: streaming.started,
    attempt: streaming.attempt,
    failedSetupLatencyMs: streaming.failedSetupLatencyMs,
    reportBarrier: plan.reportBarrier,
    clientSignal: args.clientSignal,
  });
}

export async function runPreparedRoutedInteraction(args: {
  prepared: PreparedRoutedCompletion;
  selectorBackend: SelectorBackend;
}): Promise<RoutedRuntimeResult> {
  if (args.prepared.interaction.stream) {
    throw new HttpError(
      400,
      "In-process routed runtime results only support non-streaming interactions.",
      "streaming_not_supported",
    );
  }
  const plan = await prepareRuntimeExecution({
    ...args,
    requireSelectorDecision: true,
  });
  const result = await completeNonStreaming({
    requestId: args.prepared.requestId,
    interaction: args.prepared.interaction,
    primary: plan.primary,
    primaryRetries: plan.primaryRetries,
    resolveFallback: plan.resolveFallback,
    reporter: args.prepared.reporter,
    protocol: args.prepared.protocol,
    startedCompletion: plan.startedCompletion,
    reportBarrier: plan.reportBarrier,
  });
  const routedResult = runtimeResult(result, args.prepared);
  if (result.reportBarrierError !== undefined) {
    throw new RoutedRuntimeProviderSettledError(
      errorMessage(result.reportBarrierError),
      routedResult,
      result.reportBarrierError,
    );
  }
  return routedResult;
}

export async function runExplicitRoutedInteraction(
  args: ExplicitRoutedInteractionArgs,
): Promise<RoutedRuntimeResult> {
  const prepared = await prepareExplicitRoutedCompletion(args);
  return runPreparedRoutedInteraction({
    prepared,
    selectorBackend: args.selectorBackend,
  });
}

async function prepareExplicitRoutedCompletion(
  args: ExplicitRoutedInteractionArgs,
): Promise<PreparedRoutedCompletion> {
  const receivedAt = new Date();
  const requestId = randomUUID();
  const routing = await buildRoutingContext({
    routerId: args.routerId,
    interaction: args.interaction,
    credentials: args.credentials,
    previousDecision: args.previousDecision,
    receivedAt,
  });
  return {
    requestId,
    routerId: args.routerId,
    receivedAt,
    interaction: args.interaction,
    protocol: inProcessProtocol,
    credentials: args.credentials,
    billable: args.billable ?? false,
    tags: {},
    harnessConversationIdentity: undefined,
    routing,
    reporter: args.reporter ?? createExperimentRoutedRuntimeReporter(),
  };
}

async function prepareRuntimeExecution(args: {
  prepared: PreparedRoutedCompletion;
  selectorBackend: SelectorBackend;
  requireSelectorDecision?: boolean;
  clientSignal?: AbortSignal;
}): Promise<RuntimeExecutionPlan> {
  const { prepared } = args;

  // A strict router never selects, leases, or falls back: the pinned pair or
  // an error.
  if (prepared.credentials.strict === true) {
    const pinned = strictModelDecision(prepared);
    prepared.reporter.attachServingDecision(pinned.decision);
    prepared.reporter.attachDecisionDetails({
      decision_source: "strict_model",
      explicit_model: {
        model: pinned.decision.selectedModel,
        reasoning_effort: pinned.decision.reasoningEffort,
      },
    });
    return selectedExecutionPlan(prepared, pinned);
  }

  // A requested `dari/model/<id>` is served as chosen, before any lease.
  const explicit = args.requireSelectorDecision ? null : explicitModelDecision(prepared);
  if (explicit) {
    prepared.reporter.attachServingDecision(explicit.decision);
    prepared.reporter.attachDecisionDetails({
      decision_source: "explicit_model",
      explicit_model: {
        model: explicit.decision.selectedModel,
        reasoning_effort: explicit.decision.reasoningEffort,
      },
    });
    return selectedExecutionPlan(prepared, explicit);
  }

  // Live background work bypasses task selection; explicit experiments
  // still require a selector observation and never consume live leases.
  const auxiliary = args.requireSelectorDecision ? null : auxiliaryDecision(prepared);
  if (auxiliary) {
    prepared.reporter.attachServingDecision(auxiliary.decision);
    prepared.reporter.attachDecisionDetails({
      decision_source: "auxiliary_request",
      auxiliary_request: {
        request_class: prepared.interaction.agentContext?.requestClass,
        model: auxiliary.decision.selectedModel,
        reasoning_effort: auxiliary.decision.reasoningEffort,
      },
    });
    return selectedExecutionPlan(prepared, auxiliary);
  }

  // Persisted policy leases (negotiated {action, turns}) take precedence.
  // Explicit in-process runs are selector experiments: they must observe the
  // selector and must not consume or prefetch live conversations' leases.
  const held = args.requireSelectorDecision ? null : leaseHoldDecision(prepared);
  if (held) {
    // Serving-only attach: nextDecision stays unset so if a fallback serves
    // this turn, execution's attachServingDecision moves both the prefix's
    // next_model and inherited countdown onto the healthy serving pair.
    prepared.reporter.attachServingDecision(held);
    prepared.reporter.attachDecisionDetails({
      decision_source: "lease_hold",
      lease_hold: {
        model: held.selectedModel,
        reasoning_effort: held.reasoningEffort,
        turns_remaining_after: held.leaseTurnsRemaining ?? 0,
      },
    });
    // Prefetch fires on the turn that leaves lag turns of lease including
    // itself — training stashes at turnIndex === endTurn - lag, and this
    // turn's pre-decrement countdown equals the lag exactly then. Firing
    // unconditionally (rather than skipping when a pending lease exists)
    // means a stale pending from a failed consume is overwritten with a
    // fresh decision before the next expiry can re-adopt it.
    if (leasePrefetchDue(prepared)) {
      trackBackgroundTelemetry(prefetchNextLease(prepared, args.selectorBackend));
    }
    return selectedExecutionPlan(prepared, committedLeaseDecision(prepared, held));
  }
  const adopted = args.requireSelectorDecision ? null : pendingLeaseDecision(prepared);
  if (adopted) {
    prepared.reporter.attachServingDecision(adopted);
    prepared.reporter.attachDecisionDetails({
      decision_source: "prefetched_lease",
      selector_lease_turns: prepared.routing.pendingLease?.turns ?? null,
      lease_prefetch_adopted: {
        model: adopted.selectedModel,
        reasoning_effort: adopted.reasoningEffort,
        turns_remaining_after: adopted.leaseTurnsRemaining ?? 0,
      },
    });
    prepared.reporter.attachAdoptedSelectorOutput({
      outputText: prepared.routing.pendingLease?.outputText ?? null,
      reason: adopted.reason,
      candidates: prepared.routing.candidateResolution.candidates,
    });
    // Consume the prefetched decision so a later expiry cannot re-adopt it.
    // Awaited with a cap: the clear is one small internal write, and losing
    // it silently would leave the stale lease adoptable. Even if the capped
    // wait elapses, the next lease's own prefetch overwrites the stale rows
    // before its expiry (the menu's shortest lease exceeds the lag).
    await clearPendingLease(prepared);
    return selectedExecutionPlan(prepared, committedLeaseDecision(prepared, adopted));
  }

  // The stateless ten-turn hold covers per-turn policies. A lease-negotiating
  // backend must reach the selector at expiry — the modulo hold would mask it
  // — so the negotiated protocol bypasses it entirely.
  const leased = args.requireSelectorDecision || (await selectorNegotiatesLeases(args.selectorBackend))
    ? null
    : leasedDecision(prepared);
  const speculative = leased
    ? null
    : await startSpeculativeExecution(prepared, args.selectorBackend, args.clientSignal);
  if (!speculative) {
    const selected = leased
      ?? await selectDecision(prepared, null, args.selectorBackend);
    if (!leased) {
      prepared.reporter.attachDecisionDetails({
        decision_source: "selector",
        selector_lease_turns:
          selected.decision.leaseTurnsRemaining === undefined
            ? null
            : selected.decision.leaseTurnsRemaining + 1,
      });
    }
    return selectedExecutionPlan(prepared, selected);
  }

  prepared.reporter.attachDecision(speculative.decision);
  const primary: ProviderChoice = {
    decision: speculative.decision,
    execution: speculative.execution,
    role: "primary",
  };
  const selectionPromise = selectDecision(
    prepared,
    speculative.decision,
    args.selectorBackend,
    args.requireSelectorDecision === true,
  );
  // The execution layer awaits selection as its report barrier only after the
  // provider settles, which can be long after a rejection. Mark the promise
  // handled now; fallback still consumes the original and its rejection.
  selectionPromise.catch(() => undefined);
  let fallbackPromise: Promise<ProviderChoice | null> | null = null;
  const resolveFallback = (): Promise<ProviderChoice | null> => {
    fallbackPromise ??= selectionPromise.then((selected) => {
      const decision = fallbackForPrimary(prepared, primary.decision, selected);
      if (decision) prepared.reporter.attachFallbackDecision(decision);
      return decision ? providerChoice(prepared, decision, "fallback") : null;
    });
    return fallbackPromise;
  };
  return {
    primary,
    primaryRetries: configuredPrimaryRetries(
      prepared.credentials.primary_retries,
    ),
    resolveFallback,
    reportBarrier: selectionPromise,
    startedCompletion:
      speculative.transport === "completion" ? speculative.started : undefined,
    startedStream:
      speculative.transport === "stream" ? speculative.started : undefined,
    initialStreamError:
      speculative.transport === "stream"
        ? speculative.initialError
        : undefined,
  };
}

function selectedExecutionPlan(
  prepared: PreparedRoutedCompletion,
  selected: RoutedDecision,
): RuntimeExecutionPlan {
  return {
    primary: providerChoice(prepared, selected.decision, "primary"),
    primaryRetries: configuredPrimaryRetries(
      prepared.credentials.primary_retries,
    ),
    resolveFallback: async () => {
      if (!selected.fallbackDecision) return null;
      const fallbackDecision = selected.decision.leaseTurnsRemaining === undefined
        ? selected.fallbackDecision
        : {
            ...selected.fallbackDecision,
            leaseTurnsRemaining: selected.decision.leaseTurnsRemaining,
          };
      return providerChoice(prepared, fallbackDecision, "fallback");
    },
  };
}

async function startSpeculativeExecution(
  prepared: PreparedRoutedCompletion,
  selectorBackend: SelectorBackend,
  clientSignal?: AbortSignal,
): Promise<SpeculativeExecution | null> {
  // Speculation is a new dispatch. A client already gone during request
  // preparation must never cause fresh paid provider work.
  if (clientSignal?.aborted === true) return null;
  const { credentials, interaction, routing } = prepared;
  const resolution = routing.candidateResolution;
  if (
    credentials.speculative_routing !== true ||
    selectorBackend.supportsSpeculativeRouting === false ||
    credentials.credit_exhausted ||
    !routing.previousDecision
  ) {
    return null;
  }
  const previous = {
    model: routing.previousDecision.model,
    reasoningEffort: routing.previousDecision.reasoningEffort,
  };
  if (!resolution.candidates.some((candidate) => sameRoutingCandidate(candidate, previous))) {
    return null;
  }

  const decision: RoutingDecision = {
    selectedModel: previous.model,
    reasoningEffort: previous.reasoningEffort,
    reason:
      routing.previousDecision.reason ||
      "Continuing the previous model while selecting the next route.",
  };
  try {
    const execution = providerExecution(prepared, decision);
    if (interaction.stream) {
      try {
        const started = await startProviderStream({
          interaction,
          execution,
          clientSignal,
        });
        return { transport: "stream", decision, execution, started };
      } catch (initialError) {
        return { transport: "stream", decision, execution, initialError };
      }
    }
    const started = startProviderCompletion({
      interaction,
      execution,
      clientSignal,
    });
    return { transport: "completion", decision, execution, started };
  } catch (error) {
    console.error(
      "speculative provider setup failed",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}

async function selectDecision(
  prepared: PreparedRoutedCompletion,
  servingDecision: RoutingDecision | null,
  selectorBackend: SelectorBackend,
  requireSelectorDecision = false,
): Promise<RoutedDecision> {
  const { credentials, reporter, routing } = prepared;
  try {
    const routed = await routeDecision({
      selectorMessages: routing.selectorMessages,
      selectorImages: routing.selectorImages,
      resolution: routing.candidateResolution,
      credentials,
      previousDecision: routing.previousDecision,
      conversationId: routing.conversationId,
      selectorBackend,
      leaseHistory: routing.leaseHistory,
    });
    if (routed.details) reporter.attachDecisionDetails(routed.details);
    if (servingDecision) {
      if (!routed.run) {
        throw new Error("Speculative routing completed without a selector run.");
      }
      reporter.attachSpeculativeSelectorRun(routed.run, servingDecision);
      reporter.attachDecisionDetails({
        decision_source: "speculative_selector",
        selector_lease_turns:
          routed.decision.leaseTurnsRemaining === undefined
            ? null
            : routed.decision.leaseTurnsRemaining + 1,
        speculative_routing: {
          serving_model: servingDecision.selectedModel,
          serving_reasoning_effort: servingDecision.reasoningEffort,
          next_model: routed.decision.selectedModel,
          next_reasoning_effort: routed.decision.reasoningEffort,
        },
      });
    } else if (routed.run) {
      reporter.attachSelectorRun(routed.run);
    } else {
      reporter.attachDecision(routed.decision);
      reporter.attachFallbackDecision(routed.fallbackDecision);
    }
    return routed;
  } catch (error) {
    const details = isRecord(error) && isRecord(error.decisionDetails)
      ? error.decisionDetails
      : null;
    if (details) reporter.attachDecisionDetails(details);
    if (!servingDecision) {
      reporter.reportSelectorFailure(error);
      throw error;
    }
    if (requireSelectorDecision) {
      throw error;
    }

    const code = error instanceof HttpError ? error.code : "selector_execution_failed";
    console.error(
      "speculative routing selector failed",
      JSON.stringify({
        code,
        message: scrubSecrets(error instanceof Error ? error.message : String(error)),
      }),
    );
    reporter.attachDecision(servingDecision);
    reporter.attachDecisionDetails({
      decision_source: "speculative_selector",
      speculative_routing: {
        serving_model: servingDecision.selectedModel,
        serving_reasoning_effort: servingDecision.reasoningEffort,
        next_model: servingDecision.selectedModel,
        next_reasoning_effort: servingDecision.reasoningEffort,
        selector_error_code: code,
      },
    });
    return { decision: servingDecision };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configuredPrimaryRetries(value: number | undefined): number {
  const retries = value ?? 1;
  return Number.isInteger(retries) && retries >= 0 && retries <= 5 ? retries : 1;
}

function fallbackForPrimary(
  prepared: PreparedRoutedCompletion,
  primary: RoutingDecision,
  selected: RoutedDecision,
): RoutingDecision | undefined {
  if (prepared.credentials.model_fallback_enabled === false) return undefined;
  const fallback = [selected.fallbackDecision, selected.decision].find(
    (candidate): candidate is RoutingDecision =>
      candidate !== undefined &&
      candidate.selectedModel !== primary.selectedModel,
  );
  if (!fallback || selected.decision.leaseTurnsRemaining === undefined) {
    return fallback;
  }
  return {
    ...fallback,
    leaseTurnsRemaining: selected.decision.leaseTurnsRemaining,
  };
}

function providerChoice(
  prepared: PreparedRoutedCompletion,
  decision: RoutingDecision,
  role: ProviderChoice["role"],
): ProviderChoice {
  return {
    decision,
    execution: providerExecution(prepared, decision),
    role,
  };
}

function providerExecution(
  prepared: PreparedRoutedCompletion,
  decision: RoutingDecision,
): ProviderExecution {
  return prepareProviderExecution({
    decision,
    credentials: prepared.credentials,
    billable: prepared.billable,
    routerId: prepared.routerId,
    pricing: prepared.routing.pricing,
    conversationId: prepared.routing.conversationId,
    costEstimates: prepared.routing.reportingCostEstimates,
    promptCacheKey: prepared.interaction.promptCacheKey,
    tags: prepared.tags,
  });
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function runtimeResult(
  result: CompletedNonStreamingExecution,
  prepared: PreparedRoutedCompletion,
): RoutedRuntimeResult {
  const decision = result.choice.decision;
  const chain = prepared.routing.prefix.chainByModel.get(decision.selectedModel);
  const target = prepared.routing.targetsByModel.get(decision.selectedModel);
  const usage = result.output.usage;
  const inputTokens = tokenCount(usage.input);
  const cacheReadTokens = tokenCount(usage.cacheRead);
  const cacheWriteTokens = tokenCount(usage.cacheWrite);
  const outputTokens = tokenCount(usage.output);
  const benchmarkReplay = estimateBenchmarkReplay({
    enabledModels: prepared.credentials.enabled_models,
    modelPrices: prepared.credentials.model_prices ?? {},
    executionProvider: (model) => executionProviderForModel(prepared.credentials, model),
    priorHit: prepared.routing.identityHit,
    receivedAtMs: prepared.receivedAt.getTime(),
    promptTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    outputTokens,
  });
  const completedPrefix = chain === undefined || target === undefined
    ? null
    : buildCompletedPrefixHit({
        request: prepared.interaction,
        output: result.output,
        model: decision.selectedModel,
        nextModel: decision.selectedModel,
        nextReasoningEffort: decision.reasoningEffort,
        reasoningBucket: decision.reasoningEffort,
        leaseTurnsRemaining: decision.leaseTurnsRemaining ?? null,
        reason: decision.reason,
        chain,
        looseChain: prepared.routing.prefix.looseChain,
        target,
        conversationId: prepared.routing.conversationId,
        leaseDepth: prepared.routing.leaseDepth,
        providerBlockDepth:
          prepared.routing.providerBlockDepthFor(decision.selectedModel),
        fingerprints: prepared.routing.prefix.fingerprints,
        usage,
        benchmarkReplayDepth: benchmarkReplay.depth,
      });
  return {
    routing: decision,
    output: result.output,
    ...(completedPrefix === null
      ? {}
      : { prefixHit: { ...completedPrefix, updated_at: new Date().toISOString() } }),
  };
}

const inProcessProtocol: RoutedProtocol = {
  responseBody: (args) => ({
    id: args.id,
    model: args.model,
    output: args.output,
    usage: args.output.usage,
    dari_routing: {
      selected_model: args.routing.selectedModel,
      reasoning_effort: args.routing.reasoningEffort,
      reason: args.routing.reason,
      ...(args.conversationId ? { conversation_id: args.conversationId } : {}),
    },
  }),
  streamBody: () => {
    throw new HttpError(
      400,
      "In-process routed runtime results only support non-streaming interactions.",
      "streaming_not_supported",
    );
  },
};
