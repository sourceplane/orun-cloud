import type { EventGroupsRepository, EventsRepository, NotificationRulesRepository } from "@saas/db/events";
import type { Env } from "../env.js";
import type { LaneHandler } from "./types.js";
import { createNotificationsLaneHandler } from "./notifications-lane.js";
import { createGroupingLaneHandler } from "./grouping-lane.js";
import { createMessagingLaneHandler } from "./messaging-lane.js";

/**
 * The events-owned lane handler registry (saas-event-streaming).
 *
 * - 'grouping' (ES4): maintains the dedup/correlation read-model. Alphabetical
 *   lane ordering drains it before 'notifications', though the two share no
 *   state (each computes group keys independently).
 * - 'messaging' (saas-integration-hub IH3): reacts to normalized inbound
 *   Slack activity — mute-rule actions and channel archives.
 * - 'notifications' (ES2): the rules engine, group-aware as of ES4.
 * - 'webhooks' never appears here — webhooks-worker owns its own drain and
 *   shares only the cursor storage.
 *
 * A handler instance memoizes per-org reads, so build a fresh registry per
 * dispatcher tick / replay request. Tests inject fake handlers directly.
 */
export function buildLaneHandlers(
  env: Env,
  deps: {
    rulesRepo: NotificationRulesRepository;
    groupsRepo: EventGroupsRepository;
    eventsRepo: EventsRepository;
    requestId: string;
  },
): LaneHandler[] {
  return [
    createGroupingLaneHandler({
      groupsRepo: deps.groupsRepo,
      eventsRepo: deps.eventsRepo,
    }),
    createMessagingLaneHandler({
      rulesRepo: deps.rulesRepo,
      eventsRepo: deps.eventsRepo,
      notificationsEnv: env.NOTIFICATIONS_WORKER ? { NOTIFICATIONS_WORKER: env.NOTIFICATIONS_WORKER } : {},
      requestId: deps.requestId,
    }),
    createNotificationsLaneHandler({
      rulesRepo: deps.rulesRepo,
      notificationsEnv: env.NOTIFICATIONS_WORKER ? { NOTIFICATIONS_WORKER: env.NOTIFICATIONS_WORKER } : {},
      requestId: deps.requestId,
      eventsRepo: deps.eventsRepo,
    }),
  ];
}
