import type {
  CheckQuotaResponse,
  GetUsageSummaryResponse,
} from "@saas/contracts/metering";
import { z } from "zod";

import { compact, projectArg, scopedShape } from "../scope.js";
import { defineTool } from "../tool.js";

import type { CheckQuotaRequest, GetUsageSummaryRequest } from "@saas/sdk";

export const usageSummaryTool = defineTool({
  name: "usage_summary",
  title: "Summarize metered usage",
  description:
    "Summarize a workspace's metered usage for one `metric` (totals plus hour/day rollups), optionally narrowed by project/environment and a time window. For limit headroom use `quota_check`.",
  inputSchema: z.object({
    ...scopedShape,
    metric: z.string().min(1).describe("Usage metric key to summarize."),
    project: projectArg.optional(),
    environment: z
      .string()
      .min(1)
      .describe("Environment public id filter (requires `project`).")
      .optional(),
    bucketType: z.enum(["hour", "day"]).describe("Rollup bucket type filter.").optional(),
    startTime: z.string().min(1).describe("ISO-8601 start time (inclusive).").optional(),
    endTime: z.string().min(1).describe("ISO-8601 end time (exclusive).").optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const res = await ctx.sdk.metering.getUsageSummary(
      input.workspace,
      compact<GetUsageSummaryRequest>({
        metric: input.metric,
        projectId: input.project,
        environmentId: input.environment,
        bucketType: input.bucketType,
        startTime: input.startTime,
        endTime: input.endTime,
      }),
    );
    const data = res satisfies GetUsageSummaryResponse;
    return {
      summary: `${res.metric}: ${res.totalQuantity} across ${res.totalRecords} record(s)`,
      data,
    };
  },
});

export const quotaCheckTool = defineTool({
  name: "quota_check",
  title: "Check quota headroom",
  description:
    "Check one `metric` against the workspace's quota: allowed/limit/used/remaining plus period and enforcement mode. Use `usage_summary` for the underlying usage series.",
  inputSchema: z.object({
    ...scopedShape,
    metric: z.string().min(1).describe("Usage metric key to check."),
    project: projectArg.optional(),
    environment: z.string().min(1).describe("Environment public id scoping.").optional(),
    resourceId: z.string().min(1).describe("Resource scoping.").optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const res = await ctx.sdk.metering.checkQuota(
      input.workspace,
      compact<CheckQuotaRequest>({
        metric: input.metric,
        projectId: input.project,
        environmentId: input.environment,
        resourceId: input.resourceId,
      }),
    );
    const data = res satisfies CheckQuotaResponse;
    return {
      summary: `${res.metric}: ${res.allowed ? "within quota" : "over quota"} (used ${res.used}, limit ${res.limit})`,
      data,
    };
  },
});
