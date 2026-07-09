// MCP prompts (saas-mcp-server MCP4, design §6): packaged workflows — the
// "golden paths" of agent usage. Each prompt is one tight user message that
// names the registered tools to call (by exact name — a drift guard in tests
// asserts every snake_case token in prompt text is a registered tool) and the
// expected output shape. Agents pay per token: keep these terse.

import { z } from "zod";

import { workspaceArg } from "./scope.js";

/** Prompt arguments are strings on the wire (MCP spec); optional via zod. */
type PromptArgsShape = Record<string, z.ZodString | z.ZodOptional<z.ZodString>>;

/** A registered prompt: metadata + args schema + message-text builder. */
export interface McpPrompt {
  name: string;
  title: string;
  description: string;
  argsSchema: PromptArgsShape;
  /** Renders the prompt's single user message from validated arguments. */
  build: (args: Record<string, string | undefined>) => string;
}

function definePrompt(def: McpPrompt): McpPrompt {
  return def;
}

export const investigateFailedRunPrompt = definePrompt({
  name: "investigate_failed_run",
  title: "Investigate a failed run",
  description:
    "Diagnose a failed delivery run: find it, read the failing jobs' logs, and summarize the root cause with verifiable ids.",
  argsSchema: {
    workspace: workspaceArg,
    project: z.string().min(1).describe("Project public id (`prj_…`), when known.").optional(),
    runId: z.string().min(1).describe("Run id (ULID), when known.").optional(),
  },
  build: (args) => {
    const target =
      args["runId"] !== undefined
        ? `Investigate run ${args["runId"]}.${args["project"] === undefined ? " If you don't know its project, find the run via runs_list first — each run row carries its projectId." : ` Project: ${args["project"]}.`}`
        : `Find the run: call runs_list with { workspace: "${args["workspace"]}", status: "failed"${args["project"] !== undefined ? `, project: "${args["project"]}"` : ""} } and take the newest failed run; its projectId is the project below.`;
    return [
      `Diagnose a failed delivery run in workspace ${args["workspace"]}.`,
      "",
      `1. ${target}`,
      "2. Call runs_get ({ workspace, project, runId }) for the run and its plan-DAG job statuses.",
      "3. For every job whose status is failed or timed-out, call runs_read_logs ({ workspace, project, runId, jobId }); if the output is truncated or incomplete, page with fromSeq = the returned nextSeq.",
      "4. Report: the root cause (quote the decisive log lines), the failing job ids, the run/environment/commit identifiers, and one suggested next step. Cite exact ids so a human can verify.",
    ].join("\n");
  },
});

export const accessReviewPrompt = definePrompt({
  name: "access_review",
  title: "Access review",
  description:
    "Review who can do what in a workspace, via which grant, cross-checked against recent security and audit activity.",
  argsSchema: { workspace: workspaceArg },
  build: (args) =>
    [
      `Produce an access review for workspace ${args["workspace"]}.`,
      "",
      "1. Call access_explain ({ workspace }) — effective permissions with grant provenance (direct / team / account-cascade) plus the member and team rosters.",
      "2. Call security_events_list ({ workspace }) — recent security events.",
      "3. Call audit_search ({ workspace }) — a recent slice; focus on access-shaped actions (invites, role and team changes, key issuance).",
      "4. Output a markdown table: principal | access | via (grant provenance) | recent activity. Then flag follow-ups: elevated access with no recent activity, recent grant changes, and security events needing review. Cite ids and timestamps from tool output — never infer provenance.",
    ].join("\n"),
});

export const usageReviewPrompt = definePrompt({
  name: "usage_review",
  title: "Usage and quota review",
  description:
    "Review usage against quotas and plan entitlements; flag anomalies and dimensions nearing their limits.",
  argsSchema: { workspace: workspaceArg },
  build: (args) =>
    [
      `Review usage, quota, and plan posture for workspace ${args["workspace"]}.`,
      "",
      "1. Call usage_summary ({ workspace }) — current usage by dimension.",
      "2. Call quota_check ({ workspace }) — limits and remaining headroom.",
      "3. Call billing_summary ({ workspace }) — plan, entitlements, and invoices.",
      "4. Output a table: dimension | used | limit | % of quota. Flag any dimension at or above 80%, usage that looks anomalous against the plan's entitlements, and end with one recommendation (upgrade / cleanup / no action) citing the numbers.",
    ].join("\n"),
});

export const serviceSnapshotPrompt = definePrompt({
  name: "service_snapshot",
  title: "Service snapshot",
  description:
    "One-shot service brief: catalog identity + owner + relations, its docs, and recent delivery health.",
  argsSchema: {
    workspace: workspaceArg,
    entityRef: z
      .string()
      .min(1)
      .describe("Exact catalog entity ref, e.g. `component:default/api`."),
  },
  build: (args) =>
    [
      `Brief me on service ${args["entityRef"]} in workspace ${args["workspace"]}.`,
      "",
      `1. Call catalog_get_entity ({ workspace, entityRef: "${args["entityRef"]}" }) — identity, owner, lifecycle, relations, provenance (note the sourceProjectId).`,
      "2. Call catalog_read_doc ({ workspace, entityRef }) to list its docs; read the overview by passing that row's digest back to catalog_read_doc.",
      "3. Call runs_list ({ workspace, project: <the entity's sourceProjectId>, limit: 10 }) — recent delivery history.",
      "4. Output a service brief: what it is (one paragraph), owner and lifecycle, dependencies and dependents from relations, doc highlights, and recent run health (statuses, plus the last failure if any). Cite entityRef, project, and run ids.",
    ].join("\n"),
});

/** Every registered prompt (the four design §6 golden paths). */
export const allPrompts: ReadonlyArray<McpPrompt> = [
  investigateFailedRunPrompt,
  accessReviewPrompt,
  usageReviewPrompt,
  serviceSnapshotPrompt,
];
