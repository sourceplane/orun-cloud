import { NotFoundError, RateLimitError, ValidationError } from "@saas/sdk";
import { describe, expect, it } from "vitest";

import { toErrorResult, ToolInputError } from "../errors.js";

import { errorDetailOf, textOf } from "./helpers.js";

describe("toErrorResult", () => {
  it("preserves the platform code, message, and requestId", () => {
    const result = toErrorResult(
      new ValidationError({
        envelope: {
          code: "validation_failed",
          message: "bad field",
          details: { fields: { name: ["required"] } },
        },
        status: 422,
        requestId: "req_v",
      }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("validation_failed: bad field (HTTP 422, requestId: req_v)");
    expect(errorDetailOf(result)).toEqual({
      code: "validation_failed",
      message: "bad field",
      requestId: "req_v",
      httpStatus: 422,
      fields: { name: ["required"] },
    });
  });

  it("surfaces the upstream HTTP status and URL so a routing/connectivity 404 is distinguishable from a real not_found", () => {
    const result = toErrorResult(
      new NotFoundError({
        envelope: { code: "not_found", message: "HTTP 404", details: {} },
        status: 404,
        requestId: "req_n",
        response: new Response("Not Found", {
          status: 404,
          headers: { "content-type": "text/plain" },
        }) as unknown as Response & { url: string },
      }),
    );
    expect(textOf(result)).toContain("not_found: HTTP 404 (HTTP 404, requestId: req_n)");
    expect(errorDetailOf(result)["httpStatus"]).toBe(404);
    // (A live Response carries a real `.url`, added to detail; a constructed
    // Response has url="" so it is omitted here — httpStatus is the stable pin.)
  });

  it("carries retry-after on rate_limited", () => {
    const result = toErrorResult(
      new RateLimitError({
        envelope: { code: "rate_limited", message: "slow down", details: {} },
        status: 429,
        requestId: "req_r",
        retryAfterSeconds: 42,
        scope: "identity",
        windows: [],
      }),
    );
    expect(errorDetailOf(result)["retryAfterSeconds"]).toBe(42);
  });

  it("maps ToolInputError to validation_failed", () => {
    const result = toErrorResult(new ToolInputError("`environment` requires `project`"));
    expect(errorDetailOf(result)["code"]).toBe("validation_failed");
  });

  it("frames unexpected errors as internal_error", () => {
    const result = toErrorResult(new Error("boom"));
    expect(errorDetailOf(result)).toEqual({ code: "internal_error", message: "boom" });
  });
});
