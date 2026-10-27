import {
  gatewayPlatform,
  type OperationalErrorContext,
  type RequestErrorContext,
} from "../platform/platform.js";

export type { OperationalErrorCode } from "../platform/platform.js";

export function captureRequestError(
  error: unknown,
  context: RequestErrorContext,
): void {
  gatewayPlatform().captureRequestError(error, context);
}

/**
 * Report failures deliberately caught outside the ingress exception path,
 * including work after a response has started and process shutdown.
 */
export function captureOperationalError(
  error: unknown,
  context: OperationalErrorContext,
): void {
  gatewayPlatform().captureOperationalError(error, context);
}
