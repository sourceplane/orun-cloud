import type { NotificationRulesRepository, StoredEvent, StoredNotificationRule, StoredRuleTarget } from "@saas/db/events";
import { catalogEntryFor, effectiveEventSeverity, renderEventTitle } from "@saas/contracts/event-catalog";
import { enqueueNotification } from "@saas/notifications-client";
import type { NotificationsEnvBinding } from "@saas/notifications-client";
import { toPublicScopeId } from "../ids.js";
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

export interface NotificationsLaneDeps {
  rulesRepo: NotificationRulesRepository;
  notificationsEnv: NotificationsEnvBinding;
  requestId: string;
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

export function createNotificationsLaneHandler(deps: NotificationsLaneDeps): LaneHandler {
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

        // One throttle consumption per (rule, event) — a rule firing is one
        // admission regardless of its target count. Saturated window = the
        // event is silently absorbed by design (storm control), not retried.
        const admitted = await deps.rulesRepo.tryConsumeThrottle(
          rule.id,
          rule.throttleWindowSeconds,
          rule.throttleMax,
        );
        if (!admitted.ok) throw new Error("throttle_state_failed");
        if (!admitted.value) continue;

        const severity = effectiveEventSeverity(event.type, event.payload);
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
                occurredAt: event.occurredAt.toISOString(),
                sourceEventId: event.id,
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
