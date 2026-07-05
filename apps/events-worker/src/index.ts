import type { Env } from "./env.js";
import { route } from "./router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import {
  createEventsRepository,
  createEventStreamsRepository,
  createNotificationRulesRepository,
  createEventGroupsRepository,
} from "@saas/db/events";
import { runLaneDispatch } from "./lanes/dispatcher.js";
import { buildLaneHandlers } from "./lanes/registry.js";
import { runRetentionSweep } from "./retention.js";
import { generateRequestId } from "./ids.js";

/**
 * Retention cadence (saas-event-streaming ES7). The cron fires every minute
 * (matching the shipped drains), but the retention sweep is off-peak-gated to
 * the UTC hour below to avoid competing with live dispatch. Within that hour it
 * runs on each tick; every delete is batched + capped + idempotent, so the
 * per-tick work is bounded and the ~60 ticks in the window simply drain any
 * backlog and then no-op. The gate is derived from the deterministic
 * ScheduledController.scheduledTime, never Date.now().
 */
const RETENTION_SWEEP_UTC_HOUR = 4;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  // The lane dispatcher (saas-event-streaming ES1): the spec-09 router loop.
  // Runs every minute like the shipped webhooks/integrations drains. Ships
  // dark in ES1 — the registry has no handlers until ES2 — but the machinery,
  // pause switch, and dead-letter discipline are live and tested.
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.PLATFORM_DB) {
      console.error("[scheduled] PLATFORM_DB binding missing; skipping lane dispatch");
      return;
    }
    const scheduledTimeMs = controller.scheduledTime;
    const executor = createSqlExecutor(env.PLATFORM_DB);
    try {
      const requestId = generateRequestId();
      const eventsRepo = createEventsRepository(executor);
      const summary = await runLaneDispatch({
        streamsRepo: createEventStreamsRepository(executor),
        eventsRepo,
        handlers: buildLaneHandlers(env, {
          rulesRepo: createNotificationRulesRepository(executor),
          groupsRepo: createEventGroupsRepository(executor),
          eventsRepo,
          requestId,
        }),
        requestId,
        scheduledTimeMs,
      });
      if (
        summary.errors > 0 ||
        summary.eventsDeadLettered > 0 ||
        summary.orgsStalled > 0 ||
        summary.orgsDeferred > 0 ||
        summary.laggingOrgs > 0
      ) {
        console.warn(
          `[scheduled] lane dispatch: lanes=${summary.lanesRun} orgs=${summary.orgsScanned} processed=${summary.eventsProcessed} deadLettered=${summary.eventsDeadLettered} stalled=${summary.orgsStalled} deferred=${summary.orgsDeferred} lagging=${summary.laggingOrgs} maxLagSeconds=${summary.maxLagSeconds} errors=${summary.errors}`,
        );
      }

      // Retention sweep (ES7): off-peak-gated, run AFTER dispatch, and never
      // allowed to throw out of scheduled(). BILLING_WORKER is optional — its
      // absence skips only the per-org event/audit sweep; the fixed-window
      // dead-letter + closed-group sweeps still run.
      if (new Date(scheduledTimeMs).getUTCHours() === RETENTION_SWEEP_UTC_HOUR) {
        try {
          const retention = await runRetentionSweep({
            eventsRepo,
            billingWorker: env.BILLING_WORKER,
            requestId,
            now: () => new Date(scheduledTimeMs),
          });
          if (
            retention.errors > 0 ||
            retention.eventsDeleted > 0 ||
            retention.auditDeleted > 0 ||
            retention.deadLettersDeleted > 0 ||
            retention.groupsDeleted > 0
          ) {
            console.warn(
              `[scheduled] retention sweep: orgsSwept=${retention.orgsSwept} orgsSkipped=${retention.orgsSkipped} events=${retention.eventsDeleted} audit=${retention.auditDeleted} deadLetters=${retention.deadLettersDeleted} groups=${retention.groupsDeleted} errors=${retention.errors}`,
            );
          }
        } catch (err) {
          console.error("[scheduled] retention sweep threw; swallowed", err);
        }
      }
    } finally {
      await executor.dispose();
    }
  },
} satisfies ExportedHandler<Env>;

// perf(db): reverted to per-request DB client (task 0134 connection reuse rolled back).
