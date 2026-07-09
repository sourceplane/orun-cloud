import type { PublicAuditEntry } from "@saas/contracts/events";
import { z } from "zod";

import { cursorArg, limitArg, scopedShape } from "../scope.js";
import { defineTool } from "../tool.js";

export const auditSearchTool = defineTool({
  name: "audit_search",
  title: "Search the audit log",
  description:
    "Search the workspace's immutable audit log (one page per call): filter by time range (`from`/`to`, ISO-8601), actor, subject, event type, or category. For the raw typed event stream use `events_search`; for sign-in/session security use `security_events_list`.",
  inputSchema: z.object({
    ...scopedShape,
    category: z.string().min(1).describe("Audit category filter.").optional(),
    actorId: z.string().min(1).describe("Actor id filter (`usr_…` / `sp_…`).").optional(),
    actorType: z.string().min(1).describe("Actor type filter (user | service_principal | …).").optional(),
    subjectKind: z.string().min(1).describe("Subject kind filter.").optional(),
    subjectId: z.string().min(1).describe("Subject id filter.").optional(),
    eventType: z.string().min(1).describe("Event type filter.").optional(),
    from: z.string().min(1).describe("Inclusive lower bound on occurredAt (ISO-8601).").optional(),
    to: z.string().min(1).describe("Inclusive upper bound on occurredAt (ISO-8601).").optional(),
    cursor: cursorArg.optional(),
    limit: limitArg.optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const page = await ctx.sdk.events.listAuditEntriesPage(input.workspace, {
      by: "org",
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      ...(input.actorType !== undefined ? { actorType: input.actorType } : {}),
      ...(input.subjectKind !== undefined ? { subjectKind: input.subjectKind } : {}),
      ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
      ...(input.eventType !== undefined ? { eventType: input.eventType } : {}),
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    const data = {
      auditEntries: page.entries,
      meta: { cursor: page.cursor },
    } satisfies {
      auditEntries: ReadonlyArray<PublicAuditEntry>;
      meta: { cursor: string | null };
    };
    return { summary: `${page.entries.length} audit entr(y/ies)`, data };
  },
});
