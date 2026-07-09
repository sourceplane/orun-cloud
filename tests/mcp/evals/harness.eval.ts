// Agent-task eval harness (saas-mcp-server MCP8). ON-DEMAND, not per-commit:
// run with `pnpm --filter @saas/mcp-tests evals` (the default jest testMatch
// only covers src/**/*.test.ts; this file rides a separate --testMatch).
//
// For each scenario in `scenarios.ts` the harness executes the scripted
// tool-call trace through the REAL registry (`executeTool`, the same seam
// both transports call) against the seeded-org stub SDK, records the full
// trace to evals/traces/<scenario>.json (+ summary.json), and scores it:
//   1. every `requiredSequence` tool was called, in order (subsequence);
//   2. no `forbiddenTools` tool was called;
//   3. every `expectedMarkers` substring appears in the tool outputs.
// Traces are gitignored run artifacts (this repo commits no test artifacts).

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_LIMITS, executeTool, getTool } from "@saas/mcp";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { seededSdk } from "../src/fixtures.js";

import { scenarios } from "./scenarios.js";
import type { Scenario } from "./scenarios.js";

const TRACES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "traces");

interface TraceStep {
  tool: string;
  input: Record<string, unknown>;
  isError: boolean;
  output: string;
}

interface Trace {
  scenario: string;
  task: string;
  recordedAt: string;
  steps: TraceStep[];
  score: {
    requiredSequenceSatisfied: boolean;
    forbiddenToolsAvoided: boolean;
    markersFound: string[];
    markersMissing: string[];
    pass: boolean;
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

/** True when `needles` appear in `haystack` as an ordered subsequence. */
function isSubsequence(needles: string[], haystack: string[]): boolean {
  let i = 0;
  for (const item of haystack) {
    if (i < needles.length && item === needles[i]) i++;
  }
  return i === needles.length;
}

async function runScenario(scenario: Scenario): Promise<Trace> {
  const sdk = seededSdk();
  const steps: TraceStep[] = [];
  for (const step of scenario.steps) {
    const tool = getTool(step.tool);
    if (tool === undefined) {
      throw new Error(
        `scenario ${scenario.name} scripts unregistered tool ${step.tool}`,
      );
    }
    const result = await executeTool(tool, step.input, {
      sdk,
      limits: DEFAULT_LIMITS,
    });
    steps.push({
      tool: step.tool,
      input: step.input,
      isError: result.isError === true,
      output: textOf(result),
    });
  }

  const calledTools = steps.map((step) => step.tool);
  const allOutput = steps.map((step) => step.output).join("\n");
  const markersFound = scenario.expectedMarkers.filter((m) => allOutput.includes(m));
  const markersMissing = scenario.expectedMarkers.filter(
    (m) => !allOutput.includes(m),
  );
  const requiredSequenceSatisfied = isSubsequence(
    scenario.requiredSequence,
    calledTools,
  );
  const forbiddenToolsAvoided = !calledTools.some((tool) =>
    scenario.forbiddenTools.includes(tool),
  );
  const noStepErrored = steps.every((step) => !step.isError);

  return {
    scenario: scenario.name,
    task: scenario.task,
    recordedAt: new Date().toISOString(),
    steps,
    score: {
      requiredSequenceSatisfied,
      forbiddenToolsAvoided,
      markersFound,
      markersMissing,
      pass:
        requiredSequenceSatisfied &&
        forbiddenToolsAvoided &&
        markersMissing.length === 0 &&
        noStepErrored,
    },
  };
}

describe("agent-task evals (scored tool-call traces on the seeded org)", () => {
  const traces: Trace[] = [];

  beforeAll(() => {
    mkdirSync(TRACES_DIR, { recursive: true });
  });

  afterAll(() => {
    writeFileSync(
      path.join(TRACES_DIR, "summary.json"),
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          scenarios: traces.map((t) => ({ scenario: t.scenario, pass: t.score.pass })),
        },
        null,
        2,
      ),
    );
  });

  for (const scenario of scenarios) {
    it(`${scenario.name}: ${scenario.task}`, async () => {
      const trace = await runScenario(scenario);
      traces.push(trace);
      writeFileSync(
        path.join(TRACES_DIR, `${scenario.name}.json`),
        JSON.stringify(trace, null, 2),
      );
      expect(trace.steps.every((step) => !step.isError)).toBe(true);
      expect(trace.score.requiredSequenceSatisfied).toBe(true);
      expect(trace.score.forbiddenToolsAvoided).toBe(true);
      expect(trace.score.markersMissing).toEqual([]);
      expect(trace.score.pass).toBe(true);
    });
  }
});
