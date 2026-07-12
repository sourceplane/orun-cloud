import type { EventsRepository, NotificationRulesRepository, StoredEvent, StoredNotificationRule, StoredRuleTarget } from "@saas/db/events";
import { catalogEntryFor, effectiveEventSeverity, eventDedupKey, renderEventTitle } from "@saas/contracts/event-catalog";
import { enqueueNotification } from "@saas/notifications-client";
import type { NotificationsEnvBinding } from "@saas/notifications-client";
import { toPublicScopeId, generateEventId } from "../ids.js";
import type { LaneHandler } from "./types.js";
import { ruleMatchesEvent } from "./rule-match.js";

/**
 * The notifications lane handler (saas-event-streaming ES2): the rules
 * engine. Per event: evaluate the org's enabled rules (memoized per
 * dispatcher tick), admit matches through the per-rule throttle ledger, and
 * enqueue one notification per surviving (rule, enabled email target) with a
 * deterministic idempotency key — so at-least-once dispatch, cron overlap,
 * and dead-letter replay all collapse to one notification row.
 *
 * Target kinds: `email` and `slack_channel` deliver via notifications-worker
 * (ES3 channel seam — email address / chan_<hex> channel id). `webhook_endpoint`
 * remains deferred (reusing B5's webhook_delivery_attempts would violate its
 * NOT NULL subscription invariant and replay semantics); it is rejected at
 * CRUD and skipped here as defense in depth.
 */

export const EVENT_NOTIFICATION_TEMPLATE_KEY = "event.notification";

/**
 * Circuit-breaker policy (ES7, R1). After STORM_SATURATION_THRESHOLD
 * consecutive saturated (throttle-denied) firings a rule auto-suppresses; the
 * suppression clears once COOLDOWN_SECONDS have elapsed since it tripped, and
 * the rule resumes with a fresh saturation counter.
 */
export const STORM_SATURATION_THRESHOLD = 5;
export const STORM_COOLDOWN_SECONDS = 60 * 60;

export interface NotificationsLaneDeps {
  rulesRepo: NotificationRulesRepository;
  notificationsEnv: NotificationsEnvBinding;
  requestId: string;
  /**
   * The events repo used to emit the `notification_rule.suppressed` breaker
   * event (best-effort). Optional so existing call sites/tests that never trip
   * the breaker keep working; when absent the event is skipped.
   */
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
}

function sanitizeKeySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function buildRuleNotificationIdempotencyKey(
  ruleId: string,
  targetId: string,
  eventId: string,
): string {
  return [
    EVENT_NOTIFICATION_TEMPLATE_KEY,
    sanitizeKeySegment(ruleId),
    sanitizeKeySegment(targetId),
    sanitizeKeySegment(eventId),
  ].join(":");
}

function eventTitle(event: StoredEvent): string {
  const entry = catalogEntryFor(event.type);
  if (!entry) return event.type;
  return renderEventTitle(entry.title, {
    subject: { kind: event.subjectKind, id: event.subjectId, name: event.subjectName },
    tenant: { orgId: event.orgId },
    payload: event.payload,
  });
}

/**
 * Best-effort emission of the `notification_rule.suppressed` storm-breaker
 * event (ES7). The event is the admin-facing signal: it lands on event_log +
 * audit and surfaces on the console banner. It never re-enters a lane
 * (`notification_rule.` is lane-suppressed), so it cannot recurse.
 */
async function emitRuleSuppressed(
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit">,
  input: { rule: StoredNotificationRule; reason: string; saturatedWindows: number; requestId: string; now: Date },
): Promise<void> {
  try {
    await eventsRepo.appendEventWithAudit({
      event: {
        id: generateEventId(),
        type: "notification_rule.suppressed",
        version: 1,
        source: "events-worker",
        occurredAt: input.now,
        actorType: "system",
        actorId: "events-worker",
        orgId: input.rule.orgId,
        subjectKind: "notification_rule",
        subjectId: input.rule.id,
        subjectName: input.rule.name,
        requestId: input.requestId,
        payload: {
          ruleId: input.rule.id,
          reason: input.reason,
          saturatedWindows: input.saturatedWindows,
        },
      },
      audit: {
        id: generateEventId(),
        category: "system",
        description: `Notification rule ${input.rule.name} auto-suppressed after ${input.saturatedWindows} saturated windows`,
      },
    });
  } catch {
    // swallowed by design — the suppression itself already committed
  }
}

export function createNotificationsLaneHandler(deps: NotificationsLaneDeps): LaneHandler {
  const now = deps.now ?? (() => new Date());
  // Memoized per handler instance == per dispatcher tick (a fresh handler is
  // built per scheduled() invocation), so a 100-event batch costs one rules
  // read and one targets read per org, not one per event.
  const rulesByOrg = new Map<string, StoredNotificationRule[]>();
  const targetsByRule = new Map<string, StoredRuleTarget[]>();

  async function loadRules(orgId: string): Promise<StoredNotificationRule[]> {
    const cached = rulesByOrg.get(orgId);
    if (cached) return cached;
    const result = await deps.rulesRepo.listEnabledRulesByOrg(orgId);
    if (!result.ok) throw new Error("rules_read_failed");
    rulesByOrg.set(orgId, result.value);

    const targetsResult = await deps.rulesRepo.listTargetsForRules(result.value.map((r) => r.id));
    if (!targetsResult.ok) throw new Error("targets_read_failed");
    for (const rule of result.value) targetsByRule.set(rule.id, []);
    for (const target of targetsResult.value) {
      const list = targetsByRule.get(target.ruleId) ?? [];
      list.push(target);
      targetsByRule.set(target.ruleId, list);
    }
    return result.value;
  }

  return {
    laneKey: "notifications",

    async discoverOrgIds() {
      // Cooldown pass (ES7): before discovering orgs, re-enable any rule whose
      // suppression has aged past the cooldown so its org is re-included this
      // tick. Best-effort — a failure here must not block dispatch.
      const cooldownCutoff = new Date(now().getTime() - STORM_COOLDOWN_SECONDS * 1000).toISOString();
      await deps.rulesRepo.clearExpiredSuppressions(cooldownCutoff);

      const result = await deps.rulesRepo.listOrgIdsWithEnabledRules();
      if (!result.ok) throw new Error("org_discovery_failed");
      return result.value;
    },

    async handleEvent(event) {
      const rules = await loadRules(event.orgId);

      for (const rule of rules) {
        if (!ruleMatchesEvent(rule, event)) continue;

        // ES3: email + slack_channel targets deliver via notifications-worker
        // (email address / chan_<hex> channel id). webhook_endpoint stays
        // deferred and is skipped here as defense in depth.
        const targets = (targetsByRule.get(rule.id) ?? []).filter(
          (t) => t.enabled && (t.targetKind === "email" || t.targetKind === "slack_channel"),
        );
        if (targets.length === 0) continue;

        const severity = effectiveEventSeverity(event.type, event.payload);

        // Admission (ES4 group-aware): if the event belongs to a dedup story,
        // fire once per (rule, story) plus on severity escalation — collapsing
        // a burst of correlated events (push × checks × run) into one
        // notification. Otherwise fall back to the per-rule throttle window
        // (ES2 storm control). Both paths are single-statement + race-free.
        const groupKey = eventDedupKey(event.type, {
          subject: { kind: event.subjectKind, id: event.subjectId, name: event.subjectName },
          tenant: { orgId: event.orgId },
          payload: event.payload,
        });
        // Grouped fires carry the story identity + fire cause downstream so a
        // slack_app channel can edit one message per story and thread-reply on
        // escalation (IH2) instead of append-posting.
        let grouped: { groupKey: string; escalation: boolean } | null = null;
        if (groupKey) {
          const decision = await deps.rulesRepo.tryNotifyGroup(rule.id, groupKey, severity);
          if (!decision.ok) throw new Error("group_notify_state_failed");
          if (!decision.value.fire) continue;
          grouped = { groupKey, escalation: decision.value.escalated };
        } else {
          const admission = await deps.rulesRepo.tryConsumeThrottle(
            rule.id,
            rule.throttleWindowSeconds,
            rule.throttleMax,
          );
          if (!admission.ok) throw new Error("throttle_state_failed");
          if (!admission.value.admitted) {
            // Circuit breaker (ES7, R1): sustained saturation trips
            // auto-suppression. suppressRuleForStorm is idempotent and returns
            // true only on the transition, so the event + admin notice fire
            // exactly once even though every denied event in the same tick
            // re-checks. A suppressed rule is excluded from next tick's
            // working set.
            if (admission.value.saturatedWindows >= STORM_SATURATION_THRESHOLD) {
              const reason = `storm_breaker:${admission.value.saturatedWindows}_saturated_windows`;
              const suppressed = await deps.rulesRepo.suppressRuleForStorm(rule.id, reason);
              if (suppressed.ok && suppressed.value && deps.eventsRepo) {
                await emitRuleSuppressed(deps.eventsRepo, {
                  rule,
                  reason,
                  saturatedWindows: admission.value.saturatedWindows,
                  requestId: deps.requestId,
                  now: now(),
                });
              }
            }
            continue;
          }
        }

        const title = eventTitle(event);

        for (const target of targets) {
          const result = await enqueueNotification(
            deps.notificationsEnv,
            {
              internalActor: "events-worker",
              actorSubjectType: "system",
              actorSubjectId: "events-worker",
              requestId: deps.requestId,
            },
            {
              orgId: toPublicScopeId("org_", event.orgId) ?? event.orgId,
              category: "product",
              templateKey: EVENT_NOTIFICATION_TEMPLATE_KEY,
              templateData: {
                title,
                eventType: event.type,
                severity,
                ruleName: rule.name,
                // The rule's public id (rule_<32hex> — the TEXT PK is the
                // public form). IH3: slack_app deliveries put it on the
                // "Mute rule 1h" button (action_id orun_mute) so the Slack
                // interactivity drain can hand it back verbatim on
                // messaging.action.invoked.
                ruleId: rule.id,
                occurredAt: event.occurredAt.toISOString(),
                sourceEventId: event.id,
                ...(grouped
                  ? { groupKey: grouped.groupKey, escalation: grouped.escalation }
                  : {}),
              },
              recipient: {
                channel: target.targetKind === "slack_channel" ? "slack" : "email",
                address: target.targetRef,
              },
              idempotencyKey: buildRuleNotificationIdempotencyKey(rule.id, target.id, event.id),
              correlationId: event.correlationId ?? event.id,
            },
          );
          // The client never throws; surface real failures so the lane's
          // bounded-retry/dead-letter discipline applies. Idempotent
          // duplicates are 2xx server-side and land here as ok.
          if (!result.ok) {
            throw new Error(`notification_enqueue_failed:${result.reason}`);
          }
        }
      }
    },
  };
}
