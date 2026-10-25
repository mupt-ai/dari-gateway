/* Shared GET /models discovery route. One URL serves two client protocols:
   Codex reads the Codex catalog; Anthropic-SDK clients (Claude Desktop /
   Cowork gateway probes, Claude Code) read the Anthropic list shape. The
   handler detects the caller, authenticates in that protocol's auth shape,
   and selects the matching catalog adapter. */

import { anthropicToken, bearerToken } from "../http/auth";
import { errorResponse } from "../http/errors";
import { captureRequestError } from "../observability/errors";
import { anthropicErrorResponse } from "./anthropic_messages";
import { modelSupportsImageInput } from "../providers/model_capabilities";
import { modelMetadataLookup } from "../providers/pi";
import { resolveRouter } from "../strategies/routing";
import { anthropicModelsResponse } from "./anthropic_models";
import { codexModelsResponse } from "./codex_models";

export async function handleModels(request: Request, routerId: string): Promise<Response> {
  // Anthropic SDK clients always send anthropic-version, and API-key probes
  // authenticate via x-api-key instead of a bearer Authorization header.
  // Codex sends neither.
  const anthropicClient =
    request.headers.has("anthropic-version") ||
    (!request.headers.get("authorization") && request.headers.has("x-api-key"));
  try {
    const apiKey = anthropicClient ? anthropicToken(request.headers) : bearerToken(request.headers);
    // Resolution authenticates the key and confirms the router exists even
    // when the response body (Anthropic shape) does not depend on it.
    const router = await resolveRouter({ routerId, apiKey });
    if (anthropicClient) {
      return Response.json(anthropicModelsResponse(), {
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }
    const metadataLookup = modelMetadataLookup(router.model_configs);
    const imageInputFor = (model: string) => modelSupportsImageInput(metadataLookup(model));
    return Response.json(codexModelsResponse(router, imageInputFor), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    // Each protocol's clients parse their own error envelope: Anthropic's
    // {type:"error",error:{type,message}} vs the OpenAI {error:{...}} shape.
    const response = anthropicClient ? anthropicErrorResponse(error) : errorResponse(error);
    captureRequestError(error, {
      request,
      routerId,
      sourceProtocol: anthropicClient ? "anthropic_models" : "openai_models",
      status: response.status,
    });
    return response;
  }
}
