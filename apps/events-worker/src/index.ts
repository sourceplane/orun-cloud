import type { Env } from "./env.js";
import { route } from "./router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import {
  createEventsRepository,
  createEventStreamsRepository,
  createNotificationRulesRepository,
} from "@saas/db/events";
import { runLaneDispatch } from "./lanes/dispatcher.js";
import { buildLaneHandlers } from "./lanes/registry.js";
import { generateRequestId } from "./ids.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  // The lane dispatcher (saas-event-streaming ES1): the spec-09 router loop.
  // Runs every minute like the shipped webhooks/integrations drains. Ships
  // dark in ES1 — the registry has no handlers until ES2 — but the machinery,
  // pause switch, and dead-letter discipline are live and tested.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.PLATFORM_DB) {
      console.error("[scheduled] PLATFORM_DB binding missing; skipping lane dispatch");
      return;
    }
    const executor = createSqlExecutor(env.PLATFORM_DB);
    try {
      const requestId = generateRequestId();
      const summary = await runLaneDispatch({
        streamsRepo: createEventStreamsRepository(executor),
        eventsRepo: createEventsRepository(executor),
        handlers: buildLaneHandlers(env, {
          rulesRepo: createNotificationRulesRepository(executor),
          requestId,
        }),
        requestId,
      });
      if (summary.errors > 0 || summary.eventsDeadLettered > 0 || summary.orgsStalled > 0) {
        console.warn(
          `[scheduled] lane dispatch: lanes=${summary.lanesRun} orgs=${summary.orgsScanned} processed=${summary.eventsProcessed} deadLettered=${summary.eventsDeadLettered} stalled=${summary.orgsStalled} errors=${summary.errors}`,
        );
      }
    } finally {
      await executor.dispose();
    }
  },
} satisfies ExportedHandler<Env>;

// perf(db): reverted to per-request DB client (task 0134 connection reuse rolled back).
