import {
  providerForModel,
  type RoutingCandidate,
  type RoutingDecision,
} from "@mupt-ai/dari-router/policy-engine";

export function deriveFallbackDecision(args: {
  candidates: RoutingCandidate[];
  selected: RoutingCandidate;
  enabled?: boolean;
  requiresDifferentProvider?: boolean;
  providerForModel?: (model: string) => string;
}): RoutingDecision | undefined {
  if (!args.enabled) return undefined;
  const resolveProvider = args.providerForModel ?? providerForModel;
  const selectedProvider = resolveProvider(args.selected.model);
  const fallback = args.candidates.find(
    (candidate) =>
      candidate.model !== args.selected.model &&
      (!args.requiresDifferentProvider ||
        resolveProvider(candidate.model) !== selectedProvider),
  );
  return fallback
    ? {
        selectedModel: fallback.model,
        reasoningEffort: fallback.reasoningEffort,
        reason: "Runtime-selected fallback for the routed primary decision.",
      }
    : undefined;
}
