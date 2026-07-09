// Shared test scaffolding: tools only ever touch the SDK methods they call,
// so a plain object of spies stands in for the full `OrunCloud` client.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OrunCloud } from "@saas/sdk";
import { ForbiddenError } from "@saas/sdk";

import { DEFAULT_LIMITS, executeTool, getTool } from "../registry.js";
import type { ToolLimits } from "../registry.js";

export function stubSdk(stub: Record<string, unknown>): OrunCloud {
  return stub as unknown as OrunCloud;
}

export function forbidden(): ForbiddenError {
  return new ForbiddenError({
    envelope: { code: "forbidden", message: "Forbidden", details: {} },
    status: 403,
    requestId: "req_test",
  });
}

/** Execute a registered tool by name against a stubbed SDK. Never throws. */
export async function runTool(
  name: string,
  input: unknown,
  stub: Record<string, unknown>,
  limits: ToolLimits = DEFAULT_LIMITS,
): Promise<CallToolResult> {
  const tool = getTool(name);
  if (tool === undefined) throw new Error(`tool ${name} is not registered`);
  return executeTool(tool, input, { sdk: stubSdk(stub), limits });
}

export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected a text content block");
  }
  return first.text;
}

/** The structured JSON payload (also embedded in the text block). */
export function dataOf(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent === undefined) {
    throw new Error("expected structuredContent on the result");
  }
  return result.structuredContent as Record<string, unknown>;
}

/** Assert an error result and return its parsed JSON detail line. */
export function errorDetailOf(result: CallToolResult): Record<string, unknown> {
  if (result.isError !== true) throw new Error("expected an isError result");
  const text = textOf(result);
  const idx = text.indexOf("\n");
  return JSON.parse(text.slice(idx + 1)) as Record<string, unknown>;
}
