import { describe, expect, it } from "vitest";
import { z } from "zod";

import { allTools, getTool, readOnlyTools } from "../registry.js";

/** The locked default-tool budget (design §4; MCP8 adds the CI guard). */
const TOOL_BUDGET = 25;

const EXPECTED_READ_NAMES = [
  "whoami",
  "workspaces_list",
  "projects_list",
  "catalog_search",
  "catalog_get_entity",
  "catalog_read_doc",
  "runs_list",
  "runs_get",
  "runs_read_logs",
  "audit_search",
  "events_search",
  "security_events_list",
  "access_explain",
  "usage_summary",
  "quota_check",
  "billing_summary",
  "config_read",
  "secrets_list",
  "webhook_deliveries_list",
];

/** The MCP5 write set — the design §4 table, nothing else. */
const EXPECTED_WRITE_NAMES = [
  "project_create",
  "environment_create",
  "flag_set",
  "webhook_create",
  "webhook_delivery_replay",
  "member_invite",
];

describe("registry", () => {
  it("registers exactly the read toolset then the MCP5 write set, in order", () => {
    expect(allTools.map((t) => t.name)).toEqual([
      ...EXPECTED_READ_NAMES,
      ...EXPECTED_WRITE_NAMES,
    ]);
  });

  it("exactly consumes the locked tool budget (19 reads + 6 writes = 25)", () => {
    expect(allTools.length).toBe(TOOL_BUDGET);
    expect(allTools.length).toBeLessThanOrEqual(TOOL_BUDGET);
  });

  it("has unique names", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares every read tool readOnly + idempotent + non-destructive", () => {
    for (const name of EXPECTED_READ_NAMES) {
      const tool = getTool(name);
      expect(tool?.annotations.readOnlyHint, name).toBe(true);
      expect(tool?.annotations.idempotentHint, name).toBe(true);
      expect(tool?.annotations.destructiveHint, name).toBe(false);
    }
  });

  it("declares every write tool non-readOnly, non-destructive, idempotent (design §7)", () => {
    for (const name of EXPECTED_WRITE_NAMES) {
      const tool = getTool(name);
      expect(tool?.annotations.readOnlyHint, name).toBe(false);
      expect(tool?.annotations.destructiveHint, name).toBe(false);
      expect(tool?.annotations.idempotentHint, name).toBe(true);
    }
  });

  it("readOnlyTools excludes exactly the six write tools", () => {
    expect(readOnlyTools.map((t) => t.name)).toEqual(EXPECTED_READ_NAMES);
    for (const name of EXPECTED_WRITE_NAMES) {
      expect(readOnlyTools.some((t) => t.name === name), name).toBe(false);
    }
  });

  it("gives every write tool an optional caller-supplied idempotencyKey input", () => {
    for (const name of EXPECTED_WRITE_NAMES) {
      const tool = getTool(name);
      expect(tool && "idempotencyKey" in tool.inputSchema.shape, name).toBe(true);
    }
  });

  it("carries a title, description, and zod object input schema per tool", () => {
    for (const tool of allTools) {
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
      expect(tool.inputSchema, tool.name).toBeInstanceOf(z.ZodObject);
    }
  });

  it("looks tools up by name", () => {
    expect(getTool("runs_get")?.name).toBe("runs_get");
    expect(getTool("project_create")?.name).toBe("project_create");
    expect(getTool("nope")).toBeUndefined();
  });
});
