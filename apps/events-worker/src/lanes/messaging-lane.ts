import type { EventsRepository, NotificationRulesRepository, StoredEvent, StoredNotificationRule } from "@saas/db/events";
import type { NotificationsEnvBinding } from "@saas/notifications-client";
import { toPublicScopeId, generateEventId } from "../ids.js";
import type { LaneHandler } from "./types.js";
import { RULE_ID_RE } from "../handlers/notification-rules.js";

/**
 * The messaging reaction lane (saas-integration-hub IH3, design §4.3): the
 * platform half of "Slack talks back". The integrations-worker drain
 * normalizes inbound Slack interactivity/events into `messaging.*` events on
 * the canonical log; this lane reacts:
 *
 * - `messaging.action.invoked` with actionId `mute_rule` → suppress the
 *   named notification rule ("Mute rule 1h"). `acknowledge` actions need no
 *   lane reaction — the drain posts the Slack-side "acked by @user" reply.
 * - `messaging.channel.archived` → best-effort call to notifications-worker's
 *   internal slack-disable route so dependent slack_app channels flip to
 *   disabled (channel-reference freshness).
 *
 * Both reactions are idempotent per event (suppress transitions at most once;
 * disabling an already-disabled channel is a no-op), so the dispatcher's
 * at-least-once delivery and replay are safe.
 */

/** Discovery mirrors the grouping lane: recency-bounded active-org scan. */
export const MESSAGING_ORG_LOOKBACK_SECONDS = 2 * 24 * 60 * 60;
const MESSAGING_ORG_LIMIT = 1000;

const SLACK_DISABLE_URL = "https://notifications.internal/internal/notification-channels/slack-disable";

export interface MessagingLaneDeps {
  rulesRepo: Pick<NotificationRulesRepository, "getRule" | "suppressRuleForStorm">;
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit" | "listRecentlyActiveOrgIds">;
  notificationsEnv: NotificationsEnvBinding;
  requestId: string;
  now?: () => Date;
}

/**
 * Best-effort emission of `notification_rule.suppressed` for a Slack mute —
 * the same admin-facing event the notifications lane emits on storm trips
 * (mirrored here; the storm variant's description is saturation-specific).
 * `notification_rule.*` is lane-suppressed, so this can never recurse.
 */
async function emitRuleSuppressed(
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit">,
  input: { rule: StoredNotificationRule; reason: string; requestId: string; now: Date },
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
        },
      },
      audit: {
        id: generateEventId(),
        category: "system",
        description: `Notification rule ${input.rule.name} muted for 1h from Slack`,
      },
    });
  } catch {
    // swallowed by design — the suppression itself already committed
  }
}

/**
 * Best-effort POST to notifications-worker's internal slack-disable route
 * (the enqueueNotification client pattern: internal URL over the service
 * binding, x-internal-actor from the notifications allowlist). Failures are
 * swallowed — channel freshness must never stall or dead-letter the lane,
 * and the reaction is idempotent so a missed call merely leaves a channel
 * to fail loudly on its next send.
 */
async function requestSlackChannelDisable(
  env: NotificationsEnvBinding,
  requestId: string,
  body: { orgId: string; connectionId: string; channelExternalId: string },
): Promise<void> {
  if (!env.NOTIFICATIONS_WORKER) return;
  try {
    await env.NOTIFICATIONS_WORKER.fetch(SLACK_DISABLE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-internal-actor": "events-worker",
        "x-actor-subject-type": "system",
        "x-actor-subject-id": "events-worker",
      },
      body: JSON.stringify(body),
    });
  } catch {
    // best-effort by design
  }
}

export function createMessagingLaneHandler(deps: MessagingLaneDeps): LaneHandler {
  const now = deps.now ?? (() => new Date());

  async function handleActionInvoked(event: StoredEvent): Promise<void> {
    const payload = event.payload ?? {};
    // Only mute_rule needs a platform reaction; `acknowledge` is handled
    // entirely by the drain (the visible Slack thread reply).
    if (payload["actionId"] !== "mute_rule") return;

    // The button value is the rule PUBLIC id — rule_<32hex>, which IS the
    // TEXT PK (the same parsing the rules handlers apply before getRule).
    const value = payload["value"];
    if (typeof value !== "string" || !RULE_ID_RE.test(value)) return;

    // Tenant check: the rule must belong to the event's org (getRule is
    // org-scoped, so a foreign or deleted rule id simply misses).
    const ruleResult = await deps.rulesRepo.getRule(event.orgId, value);
    if (!ruleResult.ok) throw new Error("rule_read_failed");
    const rule = ruleResult.value;
    if (!rule) return;

    const invokedBy =
      typeof payload["invokedByExternalUser"] === "string" && payload["invokedByExternalUser"]
        ? payload["invokedByExternalUser"]
        : "unknown";
    const reason = `slack_mute:${invokedBy}`;

    // "Mute rule 1h" IS the storm-breaker suppression: the notifications
    // lane's cooldown pass clears any suppression once STORM_COOLDOWN_SECONDS
    // (= 3600s, see notifications-lane.ts) have elapsed since it was set, so
    // suppressing here mutes the rule for exactly one hour with no extra
    // timer machinery. Idempotent: only the transition returns true, so the
    // admin-facing event fires at most once per mute even under replay.
    const suppressed = await deps.rulesRepo.suppressRuleForStorm(rule.id, reason);
    if (!suppressed.ok) throw new Error("rule_suppress_failed");
    if (suppressed.value) {
      await emitRuleSuppressed(deps.eventsRepo, {
        rule,
        reason,
        requestId: deps.requestId,
        now: now(),
      });
    }
  }

  async function handleChannelArchived(event: StoredEvent): Promise<void> {
    const payload = event.payload ?? {};
    const connectionId = payload["connectionId"];
    const channelExternalId = payload["channelExternalId"];
    if (typeof connectionId !== "string" || !connectionId) return;
    if (typeof channelExternalId !== "string" || !channelExternalId) return;
    await requestSlackChannelDisable(deps.notificationsEnv, deps.requestId, {
      orgId: toPublicScopeId("org_", event.orgId) ?? event.orgId,
      connectionId,
      channelExternalId,
    });
  }

  return {
    laneKey: "messaging",

    async discoverOrgIds() {
      const since = new Date(now().getTime() - MESSAGING_ORG_LOOKBACK_SECONDS * 1000).toISOString();
      const result = await deps.eventsRepo.listRecentlyActiveOrgIds(since, MESSAGING_ORG_LIMIT);
      if (!result.ok) throw new Error("messaging_org_discovery_failed");
      return result.value;
    },

    async handleEvent(event) {
      if (event.type === "messaging.action.invoked") {
        await handleActionInvoked(event);
        return;
      }
      if (event.type === "messaging.channel.archived") {
        await handleChannelArchived(event);
        return;
      }
      // Everything else (commands, renames, unfurl fodder) has no lane
      // reaction in this milestone.
    },
  };
}
