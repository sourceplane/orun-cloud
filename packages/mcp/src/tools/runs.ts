import type { Run, RunJob } from "@saas/contracts/state";
import { z } from "zod";

import {
  compact,
  cursorArg,
  encodeStateCursor,
  limitArg,
  projectArg,
  scopedShape,
} from "../scope.js";
import { defineTool } from "../tool.js";
import { truncateText } from "../truncate.js";

import type { StateClient } from "@saas/sdk";

// The SDK does not export its state query interfaces; derive them so the
// compact() calls stay pinned to the real method signatures.
type RunsQuery = NonNullable<Parameters<StateClient["listRuns"]>[2]>;
type OrgRunsQuery = NonNullable<Parameters<StateClient["listOrgRuns"]>[1]>;

const runStatusArg = z
  .string()
  .min(1)
  .describe("Run status filter (pending | running | succeeded | failed | canceled).");

export const runsListTool = defineTool({
  name: "runs_list",
  title: "List runs",
  description:
    "List delivery runs, newest first — org-wide when only `workspace` is given, or one project's history when `project` is set. Filter by `status`/`environment` (and `branch`/`source` org-wide). Use `runs_get` for one run's job detail.",
  inputSchema: z.object({
    ...scopedShape,
    project: projectArg.optional(),
    environment: z.string().min(1).describe("Environment slug filter.").optional(),
    status: runStatusArg.optional(),
    branch: z
      .string()
      .min(1)
      .describe("Source branch filter (org-wide list only).")
      .optional(),
    source: z.enum(["cli", "ci"]).describe("Run initiator (org-wide list only).").optional(),
    cursor: cursorArg.optional(),
    limit: limitArg.optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const page =
      input.project !== undefined
        ? await ctx.sdk.state.listRuns(
            input.workspace,
            input.project,
            compact<RunsQuery>({
              environment: input.environment,
              status: input.status,
              cursor: input.cursor,
              limit: input.limit,
            }),
          )
        : await ctx.sdk.state.listOrgRuns(
            input.workspace,
            compact<OrgRunsQuery>({
              environment: input.environment,
              status: input.status,
              branch: input.branch,
              source: input.source,
              cursor: input.cursor,
              limit: input.limit,
            }),
          );
    const data = {
      runs: page.runs,
      meta: { cursor: encodeStateCursor(page.nextCursor) },
    } satisfies { runs: Run[]; meta: { cursor: string | null } };
    return { summary: `${page.runs.length} run(s)`, data };
  },
});

export const runsGetTool = defineTool({
  name: "runs_get",
  title: "Get a run with its jobs",
  description:
    "Fetch one run's projection plus its plan-DAG job statuses — the starting point for diagnosing a failed run. For a failing job's output, follow up with `runs_read_logs`.",
  inputSchema: z.object({
    ...scopedShape,
    project: projectArg,
    runId: z.string().min(1).describe("Run id (a ULID from `runs_list`)."),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const [runRes, jobsRes] = await Promise.all([
      ctx.sdk.state.getRun(input.workspace, input.project, input.runId),
      ctx.sdk.state.listRunJobs(input.workspace, input.project, input.runId),
    ]);
    const data = { run: runRes.run, jobs: jobsRes.jobs } satisfies {
      run: Run;
      jobs: RunJob[];
    };
    return {
      summary: `run ${runRes.run.runId} is ${runRes.run.status} with ${jobsRes.jobs.length} job(s)`,
      data,
    };
  },
});

export const runsReadLogsTool = defineTool({
  name: "runs_read_logs",
  title: "Read a run job's logs",
  description:
    "Read one job's assembled logs (byte-capped) with a live-tail cursor: pass the returned `nextSeq` back as `fromSeq` to resume where you left off instead of re-reading the whole log.",
  inputSchema: z.object({
    ...scopedShape,
    project: projectArg,
    runId: z.string().min(1).describe("Run id (a ULID from `runs_list`)."),
    jobId: z.string().min(1).describe("Job id from `runs_get`."),
    fromSeq: z
      .number()
      .int()
      .min(0)
      .describe("Resume cursor: the `nextSeq` returned by a previous call. Defaults to 0 (start).")
      .optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const res = await ctx.sdk.state.readRunJobLogs(
      input.workspace,
      input.project,
      input.runId,
      input.jobId,
      input.fromSeq ?? 0,
    );
    const capped = truncateText(res.content, ctx.limits.maxTextBytes);
    const data = {
      content: capped.text,
      truncated: capped.truncated,
      truncatedBytes: capped.truncatedBytes,
      nextSeq: res.nextSeq,
      complete: res.complete,
    } satisfies {
      content: string;
      truncated: boolean;
      truncatedBytes: number;
      nextSeq: number;
      complete: boolean;
    };
    return {
      summary: `logs for job ${input.jobId} (complete: ${res.complete}, nextSeq: ${res.nextSeq})${capped.truncated ? " — truncated" : ""}`,
      data,
    };
  },
});
