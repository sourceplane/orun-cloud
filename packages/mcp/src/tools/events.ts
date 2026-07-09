import type { PublicEvent } from "@saas/contracts/events";
import { z } from "zod";

import { compact, cursorArg, limitArg, projectArg, scopedShape } from "../scope.js";
import { defineTool } from "../tool.js";

import type { EventStreamFilters } from "@saas/sdk";

export const eventsSearchTool = defineTool({
  name: "events_search",
  title: "Search the event stream",
  description:
    "Explore the workspace's typed event stream (one page per call): filter by `type` glob, `source`, project/environment, and time range — or pass `eventId` to fetch a single event. For the human-audit projection use `audit_search` instead.",
  inputSchema: z.object({
    ...scopedShape,
    eventId: z
      .string()
      .min(1)
      .describe("Fetch exactly this event by id (`evt_…`); other filters are ignored.")
      .optional(),
    type: z.string().min(1).describe("Event type filter (glob supported, e.g. `run.*`).").optional(),
    source: z.string().min(1).describe("Event source filter.").optional(),
    project: projectArg.optional(),
    environment: z.string().min(1).describe("Environment public id (`env_…`) filter.").optional(),
    from: z.string().min(1).describe("Inclusive lower bound on occurredAt (ISO-8601).").optional(),
    to: z.string().min(1).describe("Inclusive upper bound on occurredAt (ISO-8601).").optional(),
    cursor: cursorArg.optional(),
    limit: limitArg.optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    if (input.eventId !== undefined) {
      const res = await ctx.sdk.events.getEvent(input.workspace, input.eventId);
      const data = { event: res.event } satisfies { event: PublicEvent };
      return { summary: `event ${res.event.id} (${res.event.type})`, data };
    }
    const page = await ctx.sdk.events.listEventsPage(
      input.workspace,
      compact<EventStreamFilters>({
        type: input.type,
        source: input.source,
        project: input.project,
        environment: input.environment,
        from: input.from,
        to: input.to,
        cursor: input.cursor,
        limit: input.limit,
      }),
    );
    const data = {
      events: page.events,
      meta: { cursor: page.cursor },
    } satisfies { events: ReadonlyArray<PublicEvent>; meta: { cursor: string | null } };
    return { summary: `${page.events.length} event(s)`, data };
  },
});
