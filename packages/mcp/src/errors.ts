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
