import type { NotificationRulesRepository } from "@saas/db/events";
import type { Env } from "../env.js";
import type { LaneHandler } from "./types.js";
import { createNotificationsLaneHandler } from "./notifications-lane.js";

/**
 * The events-owned lane handler registry (saas-event-streaming).
 *
 * ES2 registers the 'notifications' lane handler (the rules engine). The
 * 'webhooks' lane never appears here — webhooks-worker owns and runs its own
 * drain and shares only the cursor storage. The 'grouping' lane arrives in
 * ES4.
 *
 * A handler instance memoizes per-org reads, so build a fresh registry per
 * dispatcher tick / replay request. Tests inject fake handlers directly.
 */
export function buildLaneHandlers(
  env: Env,
  deps: { rulesRepo: NotificationRulesRepository; requestId: string },
): LaneHandler[] {
  return [
    createNotificationsLaneHandler({
      rulesRepo: deps.rulesRepo,
      notificationsEnv: env.NOTIFICATIONS_WORKER ? { NOTIFICATIONS_WORKER: env.NOTIFICATIONS_WORKER } : {},
      requestId: deps.requestId,
    }),
  ];
}
