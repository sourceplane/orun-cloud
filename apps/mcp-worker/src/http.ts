import type { ErrorCode } from "@saas/contracts/errors";

export function successResponse<T>(data: T, requestId: string, status = 200): Response {
  return Response.json(
    {
      data,
      meta: { requestId, cursor: null },
    },
    { status, headers: { "content-type": "application/json" } },
  );
}

export function errorResponse(
  code: ErrorCode | string,
  message: string,
  status: number,
  requestId: string,
  headers?: Record<string, string>,
): Response {
  return Response.json(
    {
      error: { code, message, details: {}, requestId },
    },
    { status, headers: { "content-type": "application/json", ...(headers ?? {}) } },
  );
}

export function notFound(requestId: string, path: string): Response {
  return errorResponse("not_found", `Route not found: ${path}`, 404, requestId);
}

/** 405 for non-POST hits on the MCP endpoint (stateless posture — see mcp.ts). */
export function methodNotAllowed(requestId: string): Response {
  return errorResponse("unsupported", "Method not allowed", 405, requestId, { Allow: "POST" });
}
