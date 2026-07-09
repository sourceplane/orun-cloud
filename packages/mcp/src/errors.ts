// SDK typed errors → MCP tool-error results (design §4 "Error mapping").
//
// Agents see the same semantic error set as every other client
// (`contracts/src/errors.ts`): the result text carries the platform `code`,
// `message`, and `requestId`; `rate_limited` adds retry-after and
// `validation_failed` adds field details. Anything unexpected is framed as
// `internal_error` — a raw exception never crosses the MCP boundary.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ERROR_CODES } from "@saas/contracts/errors";
import { OrunCloudError, RateLimitError, ValidationError } from "@saas/sdk";

/**
 * Bad tool input detected inside a handler (e.g. an `environment` argument
 * without its required `project`). Mapped to a `validation_failed` tool error
 * instead of the `internal_error` framing unexpected exceptions get.
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * MCP6 entitlement gate denial (design §8, transport seam): the platform's
 * upgrade-shaped `entitlement_required` error, mirroring what gated features
 * return elsewhere (e.g. events-worker custom ingest: code
 * `entitlement_required`, HTTP 402, `details.entitlementKey`). Thrown by the
 * transport-supplied gate — never by tool handlers — and mapped below so
 * agents see the platform code through the standard tool-error framing.
 */
export class EntitlementDeniedError extends Error {
  readonly code = "entitlement_required";
  readonly entitlementKey: string;

  constructor(entitlementKey: string) {
    super("MCP server access is not available on the current plan");
    this.name = "EntitlementDeniedError";
    this.entitlementKey = entitlementKey;
  }
}

/**
 * Resource reads have no `isError` result channel (unlike tool calls): a
 * failed read surfaces as a protocol-level error. This class frames the
 * message as `<code>: <detail>` so agents see the same semantic error set on
 * both surfaces (design §4 "Error mapping" applied to MCP4 resources).
 */
export class ResourceReadError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ResourceReadError";
    this.code = code;
  }
}

/** SDK/unexpected errors → `ResourceReadError`, mirroring `toErrorResult`. */
export function toResourceReadError(err: unknown): ResourceReadError {
  if (err instanceof ResourceReadError) return err;
  if (err instanceof OrunCloudError) {
    const retry =
      err instanceof RateLimitError && err.retryAfterSeconds !== null
        ? `, retry after ${err.retryAfterSeconds}s`
        : "";
    return new ResourceReadError(
      err.code,
      `${err.message} (requestId: ${err.requestId}${retry})`,
    );
  }
  if (err instanceof ToolInputError) {
    return new ResourceReadError(ERROR_CODES.VALIDATION_FAILED, err.message);
  }
  return new ResourceReadError(
    ERROR_CODES.INTERNAL_ERROR,
    err instanceof Error ? err.message : String(err),
  );
}

export function toErrorResult(err: unknown): CallToolResult {
  if (err instanceof OrunCloudError) {
    const detail: Record<string, unknown> = {
      code: err.code,
      message: err.message,
      requestId: err.requestId,
    };
    if (err instanceof RateLimitError && err.retryAfterSeconds !== null) {
      detail["retryAfterSeconds"] = err.retryAfterSeconds;
    }
    if (err instanceof ValidationError && Object.keys(err.fields).length > 0) {
      detail["fields"] = err.fields;
    }
    return errorResult(
      `${err.code}: ${err.message} (requestId: ${err.requestId})`,
      detail,
    );
  }
  if (err instanceof ToolInputError) {
    return errorResult(`${ERROR_CODES.VALIDATION_FAILED}: ${err.message}`, {
      code: ERROR_CODES.VALIDATION_FAILED,
      message: err.message,
    });
  }
  if (err instanceof EntitlementDeniedError) {
    return errorResult(`${err.code}: ${err.message}`, {
      code: err.code,
      message: err.message,
      entitlementKey: err.entitlementKey,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(`${ERROR_CODES.INTERNAL_ERROR}: ${message}`, {
    code: ERROR_CODES.INTERNAL_ERROR,
    message,
  });
}

function errorResult(
  summary: string,
  detail: Record<string, unknown>,
): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${summary}\n${JSON.stringify(detail)}` }],
  };
}
