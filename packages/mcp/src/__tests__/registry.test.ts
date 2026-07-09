import { describe, expect, it } from "vitest";
import { z } from "zod";

import { allTools, getTool } from "../registry.js";

/** The locked default-tool budget (design §4; MCP8 adds the CI guard). */
const TOOL_BUDGET = 25;

const EXPECTED_NAMES = [
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

describe("registry", () => {
  it("registers exactly the MCP0 read toolset, in order", () => {
    expect(allTools.map((t) => t.name)).toEqual(EXPECTED_NAMES);
  });

  it("stays within the locked tool budget", () => {
    expect(allTools.length).toBeLessThanOrEqual(TOOL_BUDGET);
  });

  it("has unique names", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares every MCP0 tool read-only", () => {
    for (const tool of allTools) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
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
    expect(getTool("nope")).toBeUndefined();
  });
});
