// MCP4 prompts: the four design §6 golden paths + the prompt→tool drift guard.

import { describe, expect, it } from "vitest";

import { allPrompts } from "../prompts.js";
import { allTools } from "../registry.js";
import { createMcpServer } from "../server.js";

import { connectedClient, stubSdk } from "./helpers.js";

const PROMPT_NAMES = [
  "investigate_failed_run",
  "access_review",
  "usage_review",
  "service_snapshot",
];

/**
 * Sample argument sets that exercise every text branch of every prompt
 * (`investigate_failed_run` renders differently with/without runId/project).
 * Values deliberately avoid snake_case so the drift guard below only sees
 * tool-name-shaped tokens the prompt text itself introduces.
 */
const SAMPLE_ARGS: Record<string, Array<Record<string, string>>> = {
  investigate_failed_run: [
    { workspace: "acme" },
    { workspace: "acme", project: "prj1" },
    { workspace: "acme", runId: "01RUN" },
    { workspace: "acme", project: "prj1", runId: "01RUN" },
  ],
  access_review: [{ workspace: "acme" }],
  usage_review: [{ workspace: "acme" }],
  service_snapshot: [{ workspace: "acme", entityRef: "component:default/api" }],
};

/** Narrow a prompts/get result to its single user message's text. */
function promptText(result: { messages: Array<{ role: string; content: unknown }> }): string {
  const message = result.messages[0];
  const content = message?.content as { type?: string; text?: string } | undefined;
  if (message?.role !== "user" || content?.type !== "text" || typeof content.text !== "string") {
    throw new Error("expected a single user text message");
  }
  return content.text;
}

function renderings(name: string): string[] {
  const prompt = allPrompts.find((p) => p.name === name);
  const argSets = SAMPLE_ARGS[name];
  if (prompt === undefined || argSets === undefined) {
    throw new Error(`no prompt/sample args for ${name}`);
  }
  return argSets.map((args) => prompt.build(args));
}

describe("prompt registry", () => {
  it("registers exactly the four design §6 prompts", () => {
    expect(allPrompts.map((p) => p.name)).toEqual(PROMPT_NAMES);
  });

  it("drift guard: every tool-name-shaped token in prompt text is a registered tool", () => {
    // Tool names are `<domain>_<verb>` snake_case; anything matching that
    // shape in rendered prompt text must resolve in the registry, so a tool
    // rename breaks this test instead of silently orphaning a prompt.
    const toolNames = new Set(allTools.map((t) => t.name));
    for (const name of PROMPT_NAMES) {
      for (const text of renderings(name)) {
        const referenced = text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
        expect(referenced.length, `${name} references no tools`).toBeGreaterThan(0);
        for (const token of referenced) {
          expect(toolNames.has(token), `${name} references unknown tool \`${token}\``).toBe(true);
        }
      }
    }
  });

  it("every prompt names at least two tools (a workflow, not a single call)", () => {
    for (const name of PROMPT_NAMES) {
      const tools = new Set(
        renderings(name).flatMap((text) => text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []),
      );
      expect(tools.size, name).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("prompts over the protocol", () => {
  it("lists all four prompts with their argument declarations", async () => {
    const client = await connectedClient(createMcpServer({ sdk: stubSdk({}) }));
    const listed = await client.listPrompts();
    expect(listed.prompts.map((p) => p.name).sort()).toEqual([...PROMPT_NAMES].sort());
    const investigate = listed.prompts.find((p) => p.name === "investigate_failed_run");
    const byName = new Map(investigate?.arguments?.map((a) => [a.name, a.required]));
    expect(byName.get("workspace")).toBe(true);
    expect(byName.get("project")).toBe(false);
    expect(byName.get("runId")).toBe(false);
    const snapshot = listed.prompts.find((p) => p.name === "service_snapshot");
    expect(
      snapshot?.arguments?.find((a) => a.name === "entityRef")?.required,
    ).toBe(true);
    await client.close();
  });

  it("keeps prompts registered under readOnly (they are text templates)", async () => {
    const client = await connectedClient(
      createMcpServer({ sdk: stubSdk({}), readOnly: true }),
    );
    const listed = await client.listPrompts();
    expect(listed.prompts.length).toBe(PROMPT_NAMES.length);
    await client.close();
  });

  it("investigate_failed_run orients via runs_list when no runId is given", async () => {
    const client = await connectedClient(createMcpServer({ sdk: stubSdk({}) }));
    const result = await client.getPrompt({
      name: "investigate_failed_run",
      arguments: { workspace: "acme" },
    });
    const text = promptText(result);
    expect(text).toContain('runs_list with { workspace: "acme", status: "failed" }');
    expect(text).toContain("runs_get");
    expect(text).toContain("runs_read_logs");
    expect(text).toContain("root cause");
    await client.close();
  });

  it("investigate_failed_run targets the given runId directly", async () => {
    const client = await connectedClient(createMcpServer({ sdk: stubSdk({}) }));
    const result = await client.getPrompt({
      name: "investigate_failed_run",
      arguments: { workspace: "acme", project: "prj1", runId: "01RUN" },
    });
    const text = promptText(result);
    expect(text).toContain("Investigate run 01RUN");
    expect(text).toContain("Project: prj1");
    await client.close();
  });

  it("access_review walks access_explain + security_events_list + audit_search", async () => {
    const client = await connectedClient(createMcpServer({ sdk: stubSdk({}) }));
    const result = await client.getPrompt({
      name: "access_review",
      arguments: { workspace: "acme" },
    });
    const text = promptText(result);
    for (const tool of ["access_explain", "security_events_list", "audit_search"]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain("provenance");
    await client.close();
  });

  it("usage_review walks usage_summary + quota_check + billing_summary", async () => {
    const client = await connectedClient(createMcpServer({ sdk: stubSdk({}) }));
    const result = await client.getPrompt({
      name: "usage_review",
      arguments: { workspace: "acme" },
    });
    const text = promptText(result);
    for (const tool of ["usage_summary", "quota_check", "billing_summary"]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain("80%");
    await client.close();
  });

  it("service_snapshot walks catalog_get_entity + catalog_read_doc + runs_list", async () => {
    const client = await connectedClient(createMcpServer({ sdk: stubSdk({}) }));
    const result = await client.getPrompt({
      name: "service_snapshot",
      arguments: { workspace: "acme", entityRef: "component:default/api" },
    });
    const text = promptText(result);
    for (const tool of ["catalog_get_entity", "catalog_read_doc", "runs_list"]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain('entityRef: "component:default/api"');
    await client.close();
  });

  it("rejects a prompt call missing a required argument", async () => {
    const client = await connectedClient(createMcpServer({ sdk: stubSdk({}) }));
    await expect(
      client.getPrompt({ name: "service_snapshot", arguments: { workspace: "acme" } }),
    ).rejects.toThrowError(/entityRef/);
    await client.close();
  });
});
