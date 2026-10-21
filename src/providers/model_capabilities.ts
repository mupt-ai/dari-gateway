import { isRecord } from "@mupt-ai/dari-router/policy-engine";

type ModelCapabilityMetadata = {
  model: Record<string, unknown>;
};

export const BEDROCK_API = "bedrock-converse-stream";

export function isBedrockApi(api: unknown): boolean {
  return api === BEDROCK_API;
}

export function modelSupportsImageInput(metadata: ModelCapabilityMetadata): boolean {
  return Array.isArray(metadata.model.input) && metadata.model.input.includes("image");
}

export function providerApiCanSerializeResponseFormat(metadata: ModelCapabilityMetadata): boolean {
  return (
    metadata.model.api === "openai-responses" ||
    metadata.model.api === "azure-openai-responses" ||
    metadata.model.api === "openai-completions" ||
    metadata.model.api === "anthropic-messages"
  );
}

export function isOpenAIResponsesApi(api: unknown): boolean {
  return (
    api === "openai-responses"
    || api === "openai-codex-responses"
    || api === "azure-openai-responses"
  );
}

export function modelSupportsReasoningConfigurationUpdate(
  metadata: ModelCapabilityMetadata
): boolean {
  return isRecord(metadata.model.compat)
    && metadata.model.compat.supportsReasoningConfigurationUpdate === true;
}

export function modelSupportsHostedWebSearch(metadata: ModelCapabilityMetadata): boolean {
  return (
    (metadata.model.provider === "openai" && metadata.model.api === "openai-responses")
    || (
      metadata.model.provider === "openai-codex"
      && metadata.model.api === "openai-codex-responses"
    )
    || metadata.model.api === "azure-openai-responses"
  );
}
