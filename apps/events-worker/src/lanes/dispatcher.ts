import type {
  EventsRepository,
  EventStreamsRepository,
  StoredEvent,
  StoredSubscriberLane,
} from "@saas/db/events";
import { matchesAnyEventTypeGlob } from "@saas/contracts/event-catalog";
import type { LaneHandler } from "./types.js";
import { generateDeadLetterId, generateEventId } from "../ids.js";

/**
 * The lane dispatcher (saas-event-streaming ES1) — the spec-09 router's
 * execution loop. Per active lane × discovered org: batch-read event_log past
 * the (lane, org) cursor, hand each event to the lane handler, advance the
 * cursor on success. Failure discipline mirrors the shipped drains: a failing
 * event stalls its org's lane (cursor stays before it, the minutely cron
 * retries), and after MAX_LANE_ATTEMPTS the event is dead-lettered and the
 * lane advances past it — one poisoned row can never wedge an org forever,
 * and never wedges other orgs at all.
 *
 * Concurrency posture matches webhooks-worker: no advisory locks; overlap
 * between ticks is tolerated because handlers are idempotent per event and
 * cursor advancement is an upsert.
 */

/** Failures per (lane, event) before the event is dead-lettered and skipped. */
export const MAX_LANE_ATTEMPTS = 5;

/**
 * Hot-org fairness cap (ES7, R3): the maximum number of orgs a single lane
 * services in one tick. When discovery returns more, a rotating offset derived
 * from the scheduled time picks a different contiguous window each tick
 * (round-robin), so no org is starved and the deferred remainder is reported —
 * never silently truncated.
 */
export const MAX_ORGS_PER_LANE_PER_TICK = 200;

/**
 * Lane-lag budget (ES7, R3): when an org has un-consumed events and its cursor
 * has fallen further than this many seconds behind, the dispatcher emits one
 * `event.lane_lagging` alert for that (lane, org) per tick — the pipeline
 * routing its own health onto the log.
 */
export const LANE_LAG_BUDGET_SECONDS = 900;

/**
 * Meta namespaces the dispatcher never feeds to handlers: events about
 * moving events must not generate more event movement (the generalized
 * recursion guard; webhooks-worker applies the same skip to its fanout).
 */
export function isLaneSuppressedEvent(eventType: string): boolean {
  return (
    eventType.startsWith("event.") ||
    eventType.startsWith("dead_letter.") ||
    // `notification_rule.*` (created/updated/deleted and the ES7
    // `notification_rule.suppressed` storm-breaker event) are meta events
    // about routing rules — feeding them back into rule matching would let a
    // suppression event trigger more matching / more suppression. They never
    // re-enter a lane.
    eventType.startsWith("notification_rule.")
  );
}

export interface LaneDispatchDeps {
  streamsRepo: EventStreamsRepository;
  eventsRepo: EventsRepository;
  handlers: LaneHandler[];
  requestId: string;
  /**
   * The cron's scheduled time in ms (`ScheduledController.scheduledTime`).
   * Drives the fairness rotating offset and the lane-lag clock deterministically
   * (never Date.now()). When omitted (unit tests, replay), the fairness offset
   * defaults to 0 and lane-lag detection is skipped entirely.
   */
  scheduledTimeMs?: number;
}

export interface LaneDispatchSummary {
  lanesRun: number;
  orgsScanned: number;
  eventsProcessed: number;
  eventsDeadLettered: number;
  orgsStalled: number;
  errors: number;
  /** Orgs skipped this tick by the fairness cap (serviced on a later tick). */
  orgsDeferred: number;
  /** Orgs whose lane lag exceeded LANE_LAG_BUDGET_SECONDS this tick. */
  laggingOrgs: number;
  /** The worst lane lag observed this tick, in seconds (0 when none measured). */
  maxLagSeconds: number;
}

function safeReason(err: unknown): string {
  if (err instanceof Error && err.message) return err.message.slice(0, 500);
  return "lane_handler_failed";
}

export async function emitDeadLetterLifecycle(
  eventsRepo: EventsRepository,
  input: {
    type: "event.delivery_failed" | "dead_letter.created" | "dead_letter.replayed";
    orgId: string;
    laneKey: string;
    eventId: string;
    deadLetterId: string;
    attempts: number;
    reason: string;
    requestId: string;
    description: string;
  },
): Promise<void> {
  // Best-effort: lifecycle emission must never break dispatch itself.
  try {
    await eventsRepo.appendEventWithAudit({
      event: {
        id: generateEventId(),
        type: input.type,
        version: 1,
        source: "events-worker",
        occurredAt: new Date(),
        actorType: "system",
        actorId: "events-worker",
        orgId: input.orgId,
        subjectKind: "dead_letter",
        subjectId: input.deadLetterId,
        requestId: input.requestId,
        // The source event id threads causation without copying payloads.
        causationId: input.eventId,
        payload: {
          laneKey: input.laneKey,
          eventId: input.eventId,
          deadLetterId: input.deadLetterId,
          attempts: input.attempts,
          reason: input.reason,
        },
      },
      audit: {
        id: generateEventId(),
        category: "system",
        description: input.description,
      },
    });
  } catch {
    // swallowed by design
  }
}

/**
 * Best-effort emission of the `event.lane_lagging` alert (ES7). Uses the
 * `event.` namespace so it is lane-suppressed and cannot recurse.
 */
async function emitLaneLagging(
  eventsRepo: EventsRepository,
  input: { laneKey: string; orgId: string; lagSeconds: number; budgetSeconds: number; requestId: string; now: Date },
): Promise<void> {
  try {
    await eventsRepo.appendEventWithAudit({
      event: {
        id: generateEventId(),
        type: "event.lane_lagging",
        version: 1,
        source: "events-worker",
        occurredAt: input.now,
        actorType: "system",
        actorId: "events-worker",
        orgId: input.orgId,
        subjectKind: "subscriber_lane",
        subjectId: input.laneKey,
        requestId: input.requestId,
        payload: {
          laneKey: input.laneKey,
          orgId: input.orgId,
          lagSeconds: input.lagSeconds,
          budgetSeconds: input.budgetSeconds,
        },
      },
      audit: {
        id: generateEventId(),
        category: "system",
        description: `Lane '${input.laneKey}' is ${input.lagSeconds}s behind for one org (budget ${input.budgetSeconds}s)`,
      },
    });
  } catch {
    // swallowed by design — lag alerting must never break dispatch
  }
}

async function dispatchLaneForOrg(
  deps: LaneDispatchDeps,
  lane: StoredSubscriberLane,
  handler: LaneHandler,
  orgId: string,
  summary: LaneDispatchSummary,
): Promise<void> {
  const { streamsRepo, eventsRepo } = deps;

  const cursorResult = await streamsRepo.getLaneCursor(lane.laneKey, orgId);
  if (!cursorResult.ok) {
    summary.errors++;
    return;
  }
  const cursor = cursorResult.value;

  const eventsResult = await eventsRepo.queryEventsByOrg(
    orgId,
    cursor.lastOccurredAt ? cursor.lastOccurredAt.toISOString() : null,
    cursor.lastEventId,
    lane.batchSize,
  );
  if (!eventsResult.ok) {
    summary.errors++;
    return;
  }
  if (eventsResult.value.length === 0) return;

  // Lane-lag metric (ES7): the org has un-consumed events. Measure how far the
  // cursor trails now — from the last consumed time, or the oldest un-consumed
  // event when the cursor is fresh. Only when the cron's scheduledTime is
  // available (real dispatch, not unit tests / replay).
  if (deps.scheduledTimeMs !== undefined) {
    const laggedFrom = cursor.lastOccurredAt ?? eventsResult.value[0]!.occurredAt;
    const lagSeconds = Math.max(0, Math.round((deps.scheduledTimeMs - laggedFrom.getTime()) / 1000));
    if (lagSeconds > summary.maxLagSeconds) summary.maxLagSeconds = lagSeconds;
    if (lagSeconds > LANE_LAG_BUDGET_SECONDS) {
      summary.laggingOrgs++;
      await emitLaneLagging(eventsRepo, {
        laneKey: lane.laneKey,
        orgId,
        lagSeconds,
        budgetSeconds: LANE_LAG_BUDGET_SECONDS,
        requestId: deps.requestId,
        now: new Date(deps.scheduledTimeMs),
      });
    }
  }

  let lastDone: StoredEvent | null = null;

  for (const event of eventsResult.value) {
    if (isLaneSuppressedEvent(event.type) || !matchesAnyEventTypeGlob(event.type, lane.typeFilter)) {
      lastDone = event; // advance past suppressed/filtered events
      continue;
    }

    try {
      await handler.handleEvent(event);
      lastDone = event;
      summary.eventsProcessed++;
    } catch (err) {
      const reason = safeReason(err);
      const dlResult = await streamsRepo.recordDeadLetter({
        id: generateDeadLetterId(),
        laneKey: lane.laneKey,
        eventId: event.id,
        orgId,
        reason,
      });
      if (!dlResult.ok) {
        // Could not even record the failure — stall the org and surface it.
        summary.errors++;
        summary.orgsStalled++;
        break;
      }
      const deadLetter = dlResult.value;

      if (deadLetter.attempts === 1) {
        await emitDeadLetterLifecycle(eventsRepo, {
          type: "event.delivery_failed",
          orgId,
          laneKey: lane.laneKey,
          eventId: event.id,
          deadLetterId: deadLetter.id,
          attempts: deadLetter.attempts,
          reason,
          requestId: deps.requestId,
          description: `Lane '${lane.laneKey}' failed to process event ${event.id}`,
        });
      }

      if (deadLetter.attempts >= MAX_LANE_ATTEMPTS) {
        // Poisoned: leave it dead-lettered and advance past so the org's
        // lane unwedges. Replay re-processes it from the durable log row.
        await emitDeadLetterLifecycle(eventsRepo, {
          type: "dead_letter.created",
          orgId,
          laneKey: lane.laneKey,
          eventId: event.id,
          deadLetterId: deadLetter.id,
          attempts: deadLetter.attempts,
          reason,
          requestId: deps.requestId,
          description: `Event ${event.id} dead-lettered on lane '${lane.laneKey}' after ${deadLetter.attempts} attempts`,
        });
        lastDone = event;
        summary.eventsDeadLettered++;
        continue;
      }

      // Bounded retry: stall this org at the failed event — the cursor stays
      // just before it and the next cron tick retries. Other orgs proceed.
      summary.orgsStalled++;
      break;
    }
  }

  if (lastDone) {
    const advanceResult = await streamsRepo.advanceLaneCursor(
      lane.laneKey,
      orgId,
      lastDone.id,
      lastDone.occurredAt.toISOString(),
    );
    if (!advanceResult.ok) summary.errors++;
  }
}

export async function runLaneDispatch(deps: LaneDispatchDeps): Promise<LaneDispatchSummary> {
  const summary: LaneDispatchSummary = {
    lanesRun: 0,
    orgsScanned: 0,
    eventsProcessed: 0,
    eventsDeadLettered: 0,
    orgsStalled: 0,
    errors: 0,
    orgsDeferred: 0,
    laggingOrgs: 0,
    maxLagSeconds: 0,
  };

  const lanesResult = await deps.streamsRepo.listLanes();
  if (!lanesResult.ok) {
    summary.errors++;
    return summary;
  }

  const handlersByLane = new Map(deps.handlers.map((h) => [h.laneKey, h]));

  for (const lane of lanesResult.value) {
    // Paused lanes are the kill switch; lanes without a registered handler
    // here (e.g. 'webhooks', run by its owning worker) are not ours to run.
    if (lane.status !== "active") continue;
    const handler = handlersByLane.get(lane.laneKey);
    if (!handler) continue;

    summary.lanesRun++;

    let orgIds: string[];
    try {
      orgIds = await handler.discoverOrgIds();
    } catch {
      summary.errors++;
      continue;
    }

    // Hot-org fairness cap (ES7, R3): service at most MAX_ORGS_PER_LANE_PER_TICK
    // orgs this tick, rotating the window by a scheduled-time-derived offset so
    // different orgs are drained across ticks (round-robin, not always the
    // first N). The deferred remainder is counted and surfaced — never
    // silently dropped.
    let orgsToProcess = orgIds;
    if (orgIds.length > MAX_ORGS_PER_LANE_PER_TICK) {
      const tick = Math.floor((deps.scheduledTimeMs ?? 0) / 60_000);
      const offset = ((tick % orgIds.length) + orgIds.length) % orgIds.length;
      const rotated = orgIds.slice(offset).concat(orgIds.slice(0, offset));
      orgsToProcess = rotated.slice(0, MAX_ORGS_PER_LANE_PER_TICK);
      summary.orgsDeferred += orgIds.length - MAX_ORGS_PER_LANE_PER_TICK;
    }

    for (const orgId of orgsToProcess) {
      summary.orgsScanned++;
      await dispatchLaneForOrg(deps, lane, handler, orgId, summary);
    }
  }

  return summary;
}
