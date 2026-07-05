import type { EventGroupsRepository, EventsRepository, StoredEvent } from "@saas/db/events";
import { eventDedupKey, effectiveEventSeverity } from "@saas/contracts/event-catalog";
import type { LaneHandler } from "./types.js";
import { generateGroupId } from "../ids.js";

/** How far back org discovery looks for active orgs (recency-bounded scan). */
export const GROUPING_ORG_LOOKBACK_SECONDS = 2 * 24 * 60 * 60;
const GROUPING_ORG_LIMIT = 1000;

/**
 * The grouping lane handler (saas-event-streaming ES4): the dedup/correlation
 * read-model. Per event, render the catalog dedup key; events sharing a
 * rendered key belong to one open "story". The lane upserts events.event_groups
 * (one open group per (org, key)) and appends the event as a member — the
 * substrate the ES6 explorer and the groups read API draw on.
 *
 * This lane is a pure overlay: it never mutates event_log and emits no events
 * about events (the dispatcher's recursion guard already skips event.* /
 * dead_letter.*). It does NOT drive notifications — the notifications lane
 * computes its own group key + firing decision from its own ledger, so there
 * is no cross-lane state dependency (design §7).
 *
 * Group closure runs opportunistically at the head of each org batch: any open
 * group idle past the inactivity window is closed, so a later same-key event
 * opens a fresh story.
 */

/** Inactivity window after which an open group is closed (design default). */
export const GROUP_INACTIVITY_SECONDS = 30 * 60;

export interface GroupingLaneDeps {
  groupsRepo: EventGroupsRepository;
  eventsRepo: EventsRepository;
  now?: () => Date;
}

export function createGroupingLaneHandler(deps: GroupingLaneDeps): LaneHandler {
  const now = deps.now ?? (() => new Date());
  let sweptThisTick = false;

  return {
    laneKey: "grouping",

    async discoverOrgIds() {
      const since = new Date(now().getTime() - GROUPING_ORG_LOOKBACK_SECONDS * 1000).toISOString();
      const result = await deps.eventsRepo.listRecentlyActiveOrgIds(since, GROUPING_ORG_LIMIT);
      if (!result.ok) throw new Error("grouping_org_discovery_failed");
      return result.value;
    },

    async handleEvent(event: StoredEvent) {
      // Opportunistic inactivity sweep, once per tick.
      if (!sweptThisTick) {
        sweptThisTick = true;
        const cutoff = new Date(now().getTime() - GROUP_INACTIVITY_SECONDS * 1000).toISOString();
        await deps.groupsRepo.closeInactiveGroups(cutoff);
      }

      const key = eventDedupKey(event.type, {
        subject: { kind: event.subjectKind, id: event.subjectId, name: event.subjectName },
        tenant: { orgId: event.orgId },
        payload: event.payload,
      });
      // No authored dedup key (or a missing field) ⇒ this event never groups.
      if (!key) return;

      const severity = effectiveEventSeverity(event.type, event.payload);
      const occurredAt = event.occurredAt.toISOString();

      const open = await deps.groupsRepo.getOpenGroupByKey(event.orgId, key);
      if (!open.ok) throw new Error("group_read_failed");

      if (!open.value) {
        const created = await deps.groupsRepo.createGroup({
          id: generateGroupId(),
          orgId: event.orgId,
          groupKey: key,
          firstEventId: event.id,
          severity,
          occurredAt,
        });
        if (created.ok) return;
        // A concurrent tick opened the group first — fall through to append.
        if (created.error.kind !== "conflict") throw new Error("group_create_failed");
        const reread = await deps.groupsRepo.getOpenGroupByKey(event.orgId, key);
        if (!reread.ok || !reread.value) throw new Error("group_reread_failed");
        open.value = reread.value;
      }

      const appended = await deps.groupsRepo.appendMember({
        groupId: open.value.id,
        eventId: event.id,
        severity,
        occurredAt,
      });
      if (!appended.ok) throw new Error("group_append_failed");
    },
  };
}
