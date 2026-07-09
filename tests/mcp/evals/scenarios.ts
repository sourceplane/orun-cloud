// Agent-task eval scenarios (saas-mcp-server MCP8) — the regression net for
// tool descriptions and curation. Each scenario is a real agent task and the
// tool-call trace a well-oriented agent should produce against the seeded org
// (`src/fixtures.ts`). The harness executes the scripted steps
// deterministically and scores: required tools called (in order), forbidden
// tools NOT called, and expected markers present in the tool outputs.
//
// DELIBERATE SCOPE: these are deterministic AFFORDANCE evals — they pin that
// the curated toolset can express each task and that the outputs carry what
// the task needs. LLM-in-the-loop evals (does a model *choose* these tools
// from the descriptions?) are the follow-up once an eval runner exists.

import {
  billingWorkerEntity,
  FAILING_JOB_ID,
  PROJECT,
  RUN_ID,
  WORKSPACE,
} from "../src/fixtures.js";

export interface ScenarioStep {
  /** Registered tool name to call. */
  tool: string;
  /** Tool arguments, as an agent would supply them. */
  input: Record<string, unknown>;
}

export interface Scenario {
  /** Kebab-case id; also the trace file name. */
  name: string;
  /** The natural-language task the trace answers. */
  task: string;
  /** The scripted tool-call trace. */
  steps: ScenarioStep[];
  /** Tools that MUST appear in the trace, as a subsequence (order matters). */
  requiredSequence: string[];
  /** Tools that must NOT appear anywhere in the trace. */
  forbiddenTools: string[];
  /** Substrings that must appear in the concatenated tool outputs. */
  expectedMarkers: string[];
}

/** Every MCP5 write tool — forbidden in all read-shaped tasks below. */
export const WRITE_TOOLS = [
  "project_create",
  "environment_create",
  "flag_set",
  "webhook_create",
  "webhook_delivery_replay",
  "member_invite",
];

export const scenarios: Scenario[] = [
  {
    name: "find-owner-of-billing-worker",
    task: "Find the owner of billing-worker.",
    steps: [
      { tool: "whoami", input: {} },
      {
        tool: "catalog_get_entity",
        input: { workspace: WORKSPACE, entityRef: billingWorkerEntity.entityRef },
      },
    ],
    requiredSequence: ["catalog_get_entity"],
    forbiddenTools: [...WRITE_TOOLS, "secrets_list"],
    expectedMarkers: ["team-payments", billingWorkerEntity.entityRef],
  },
  {
    name: "diagnose-failed-run",
    task: `Why did run ${RUN_ID} fail?`,
    steps: [
      { tool: "runs_get", input: { workspace: WORKSPACE, project: PROJECT, runId: RUN_ID } },
      {
        tool: "runs_read_logs",
        input: {
          workspace: WORKSPACE,
          project: PROJECT,
          runId: RUN_ID,
          jobId: FAILING_JOB_ID,
        },
      },
    ],
    // The MCP4 investigate_failed_run golden path: run detail BEFORE logs.
    requiredSequence: ["runs_get", "runs_read_logs"],
    forbiddenTools: WRITE_TOOLS,
    expectedMarkers: [
      '"status":"failed"',
      "deploy step exited 1",
      "TypeError: fetch failed",
    ],
  },
  {
    name: "org-near-quota",
    task: "Is the acme org near its runs quota?",
    steps: [
      { tool: "quota_check", input: { workspace: WORKSPACE, metric: "state.runs" } },
      { tool: "usage_summary", input: { workspace: WORKSPACE, metric: "state.runs" } },
    ],
    requiredSequence: ["quota_check"],
    forbiddenTools: WRITE_TOOLS,
    expectedMarkers: ['"used":92', '"limit":100', '"remaining":8'],
  },
  {
    name: "what-changed-yesterday",
    task: "What changed in this org recently, and by whom?",
    steps: [
      {
        tool: "audit_search",
        input: { workspace: WORKSPACE, from: "2026-07-08T00:00:00Z" },
      },
    ],
    requiredSequence: ["audit_search"],
    forbiddenTools: WRITE_TOOLS,
    expectedMarkers: ["config.flag.updated", "usr_1"],
  },
];
