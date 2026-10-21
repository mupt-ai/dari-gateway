import type { ChatCompletionRequest } from "@mupt-ai/dari-router/policy-engine";
import { bearerToken } from "../http/auth";
import { errorResponse } from "../http/errors";
import { captureRequestError } from "../observability/errors";
import { chatCompletionResponse, chatCompletionsSseStream } from "../protocol/output/chat_completions";
import { chatCompletionsToInteraction } from "../protocol/input/chat_completions";
import { handleRoutedCompletion } from "../runtime/routed_completion";
import type { SelectorBackend } from "../strategies/routing";
import {
  chatCompletionsConversationIdentity,
  openCodeRequestContext,
} from "../runtime/harness_identity";
import { parseJsonRequest } from "./json";

export async function handleChatCompletions(
  request: Request,
  routerId: string,
  selectorBackend: SelectorBackend,
): Promise<Response> {
  try {
    const apiKey = bearerToken(request.headers);
    const payload = await parseJsonRequest<ChatCompletionRequest>(request);
    const interaction = chatCompletionsToInteraction({ ...payload, source_protocol: "openai_chat" });
    const agentContext = openCodeRequestContext(request.headers);
    return await handleRoutedCompletion({
      request,
      routerId,
      apiKey,
      payload: agentContext === undefined ? interaction : { ...interaction, agentContext },
      responseBody: chatCompletionResponse,
      streamBody: chatCompletionsSseStream,
      errorResponse,
      selectorBackend,
      harnessConversationIdentity: chatCompletionsConversationIdentity(
        request.headers,
        payload.prompt_cache_key,
      ),
    });
  } catch (error) {
    const response = errorResponse(error);
    captureRequestError(error, {
      request,
      routerId,
      sourceProtocol: "openai_chat",
      status: response.status,
    });
    return response;
  }
}
