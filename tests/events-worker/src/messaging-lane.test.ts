// IH3: the messaging reaction lane — Slack "Mute rule 1h" actions suppress
// the named rule (the storm-breaker suppression IS the 1h mute; the cooldown
// sweep clears it), and channel archives flip dependent slack_app channels to
// disabled via notifications-worker's internal route (best-effort).

import { createMessagingLaneHandler } from "@events-worker/lanes/messaging-lane";
import type { MessagingLaneDeps } from "@events-worker/lanes/messaging-lane";
import type { StoredEvent, StoredNotificationRule } from "@saas/db/events";

const TEST_ORG_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TEST_ORG_PUBLIC_ID = "org_a1b2c3d4e5f67890abcdef1234567890";
const REQUEST_ID = "req_test123456789012";
const NOW = new Date("2026-07-12T10:00:00.000Z");
const RULE_ID = "rule_0123456789abcdef0123456789abcdef";
const CONNECTION_ID = "int_00000000000000000000000000000abc";

function storedRule(overrides?: Partial<StoredNotificationRule>): StoredNotificationRule {
  return {
    id: RULE_ID,
    orgId: TEST_ORG_UUID,
    projectId: null,
    name: "PR merges to Slack",
    status: "enabled",
    eventTypes: ["scm.pull_request.*"],
    minSeverity: "info",
    sources: null,
    attributeFilters: null,
    throttleWindowSeconds: 300,
    throttleMax: 10,
    createdBy: "usr_abc123",
    createdAt: NOW,
    updatedAt: NOW,
    suppressedAt: null,
    suppressedReason: null,
    saturatedWindowCount: 0,
    lastSaturatedAt: null,
    ...overrides,
  };
}

function storedEvent(overrides?: Partial<StoredEvent>): StoredEvent {
  return {
    id: "evt_0123456789abcdef0123456789abcdef",
    type: "messaging.action.invoked",
    version: 1,
    source: "integrations-worker",
    occurredAt: NOW,
    actorType: "system",
    actorId: "slack",
    actorSessionId: null,
    actorIp: null,
    orgId: TEST_ORG_UUID,
    projectId: null,
    environmentId: null,
    subjectKind: "integration_connection",
    subjectId: CONNECTION_ID,
    subjectName: null,
    requestId: REQUEST_ID,
    correlationId: null,
    causationId: null,
    idempotencyKey: null,
    payload: {},
    redactPaths: [],
    createdAt: NOW,
    ...overrides,
  };
}

function muteEvent(overrides?: Record<string, unknown>): StoredEvent {
  return storedEvent({
    payload: {
      provider: "slack",
      connectionId: CONNECTION_ID,
      workspaceExternalId: "T012345",
      actionId: "mute_rule",
      value: RULE_ID,
      channelExternalId: "C0AAA",
      invokedByExternalUser: "U0USER",
      ...overrides,
    },
  });
}

function archiveEvent(overrides?: Record<string, unknown>): StoredEvent {
  return storedEvent({
    type: "messaging.channel.archived",
    payload: {
      provider: "slack",
      connectionId: CONNECTION_ID,
      workspaceExternalId: "T012345",
      channelExternalId: "C0AAA",
      channelName: "alerts",
      ...overrides,
    },
  });
}

function fakeRulesRepo(options?: {
  getRule?: StoredNotificationRule | null;
  suppressTransitions?: boolean[];
}): {
  repo: MessagingLaneDeps["rulesRepo"];
  suppressCalls: Array<{ ruleId: string; reason: string }>;
} {
  const suppressCalls: Array<{ ruleId: string; reason: string }> = [];
  let suppressIdx = 0;
  const repo: MessagingLaneDeps["rulesRepo"] = {
    async getRule(_orgId, _id) {
      return { ok: true, value: options?.getRule !== undefined ? options.getRule : storedRule() };
    },
    async suppressRuleForStorm(ruleId, reason) {
      suppressCalls.push({ ruleId, reason });
      const transitioned = options?.suppressTransitions?.[suppressIdx] ?? true;
      suppressIdx++;
      return { ok: true, value: transitioned };
    },
  };
  return { repo, suppressCalls };
}

function fakeEventsRepo(): { repo: MessagingLaneDeps["eventsRepo"]; emitted: Array<Record<string, unknown>> } {
  const emitted: Array<Record<string, unknown>> = [];
  const repo = {
    async appendEventWithAudit(input: { event: Record<string, unknown> }) {
      emitted.push(input.event);
      return { ok: true as const, value: { event: {}, audit: {} } };
    },
    async listRecentlyActiveOrgIds() {
      return { ok: true as const, value: [TEST_ORG_UUID] };
    },
  } as unknown as MessagingLaneDeps["eventsRepo"];
  return { repo, emitted };
}

function fakeNotificationsBinding(status = 200): {
  env: MessagingLaneDeps["notificationsEnv"];
  calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const binding = {
    fetch: async (input: string | Request | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        headers[k] = v;
      });
      calls.push({ url: request.url, headers, body: (await request.json()) as Record<string, unknown> });
      if (status >= 500) return new Response(null, { status });
      return Response.json({ data: { disabled: 1 }, meta: { requestId: "req" } }, { status });
    },
    connect: undefined as never,
  } as unknown as Fetcher;
  return { env: { NOTIFICATIONS_WORKER: binding }, calls };
}

function laneHandler(overrides?: Partial<MessagingLaneDeps>) {
  const { repo: rulesRepo, suppressCalls } = fakeRulesRepo();
  const { repo: eventsRepo, emitted } = fakeEventsRepo();
  const { env: notificationsEnv, calls: disableCalls } = fakeNotificationsBinding();
  const handler = createMessagingLaneHandler({
    rulesRepo,
    eventsRepo,
    notificationsEnv,
    requestId: REQUEST_ID,
    ...overrides,
  });
  return { handler, suppressCalls, emitted, disableCalls };
}

describe("messaging lane (IH3)", () => {
  it("registers the messaging lane key and discovers recently active orgs", async () => {
    const { handler } = laneHandler();
    expect(handler.laneKey).toBe("messaging");
    expect(await handler.discoverOrgIds()).toEqual([TEST_ORG_UUID]);
  });

  describe("mute_rule actions", () => {
    it("suppresses the rule with the Slack-user-attributed reason and emits notification_rule.suppressed", async () => {
      const { repo: rulesRepo, suppressCalls } = fakeRulesRepo();
      const { repo: eventsRepo, emitted } = fakeEventsRepo();
      const handler = createMessagingLaneHandler({
        rulesRepo,
        eventsRepo,
        notificationsEnv: {},
        requestId: REQUEST_ID,
      });

      await handler.handleEvent(muteEvent());

      expect(suppressCalls).toEqual([{ ruleId: RULE_ID, reason: "slack_mute:U0USER" }]);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.type).toBe("notification_rule.suppressed");
      expect(emitted[0]!.subjectId).toBe(RULE_ID);
      expect((emitted[0]!.payload as Record<string, unknown>).reason).toBe("slack_mute:U0USER");
    });

    it("attributes an unknown invoker when the payload carries none", async () => {
      const { handler, suppressCalls } = laneHandler();
      await handler.handleEvent(muteEvent({ invokedByExternalUser: null }));
      expect(suppressCalls).toEqual([{ ruleId: RULE_ID, reason: "slack_mute:unknown" }]);
    });

    it("does not re-emit when the rule was already suppressed (idempotent replay)", async () => {
      const { repo: rulesRepo, suppressCalls } = fakeRulesRepo({ suppressTransitions: [false] });
      const { repo: eventsRepo, emitted } = fakeEventsRepo();
      const handler = createMessagingLaneHandler({
        rulesRepo,
        eventsRepo,
        notificationsEnv: {},
        requestId: REQUEST_ID,
      });
      await handler.handleEvent(muteEvent());
      expect(suppressCalls).toHaveLength(1);
      expect(emitted).toEqual([]);
    });

    it("ignores a rule id that does not resolve in the event's org", async () => {
      const { repo: rulesRepo, suppressCalls } = fakeRulesRepo({ getRule: null });
      const { repo: eventsRepo, emitted } = fakeEventsRepo();
      const handler = createMessagingLaneHandler({
        rulesRepo,
        eventsRepo,
        notificationsEnv: {},
        requestId: REQUEST_ID,
      });
      await handler.handleEvent(muteEvent());
      expect(suppressCalls).toEqual([]);
      expect(emitted).toEqual([]);
    });

    it("ignores an unparseable rule value", async () => {
      const { handler, suppressCalls } = laneHandler();
      await handler.handleEvent(muteEvent({ value: "not-a-rule-id" }));
      await handler.handleEvent(muteEvent({ value: null }));
      expect(suppressCalls).toEqual([]);
    });

    it("ignores acknowledge actions — the drain owns the Slack-side reply", async () => {
      const { handler, suppressCalls, disableCalls } = laneHandler();
      await handler.handleEvent(muteEvent({ actionId: "acknowledge", value: "ntf_1" }));
      expect(suppressCalls).toEqual([]);
      expect(disableCalls).toEqual([]);
    });

    it("throws on a rules-repo failure so the lane's bounded retry applies", async () => {
      const rulesRepo: MessagingLaneDeps["rulesRepo"] = {
        async getRule() {
          return { ok: false, error: { kind: "internal", message: "boom" } };
        },
        async suppressRuleForStorm() {
          return { ok: true, value: true };
        },
      };
      const { repo: eventsRepo } = fakeEventsRepo();
      const handler = createMessagingLaneHandler({
        rulesRepo,
        eventsRepo,
        notificationsEnv: {},
        requestId: REQUEST_ID,
      });
      await expect(handler.handleEvent(muteEvent())).rejects.toThrow("rule_read_failed");
    });
  });

  describe("channel archives", () => {
    it("calls the internal slack-disable route with the public org id and the allowlisted internal actor", async () => {
      const { handler, disableCalls } = laneHandler();
      await handler.handleEvent(archiveEvent());

      expect(disableCalls).toHaveLength(1);
      const call = disableCalls[0]!;
      expect(call.url).toBe("https://notifications.internal/internal/notification-channels/slack-disable");
      expect(call.headers["x-internal-actor"]).toBe("events-worker");
      expect(call.headers["x-actor-subject-type"]).toBe("system");
      expect(call.headers["x-request-id"]).toBe(REQUEST_ID);
      expect(call.body).toEqual({
        orgId: TEST_ORG_PUBLIC_ID,
        connectionId: CONNECTION_ID,
        channelExternalId: "C0AAA",
      });
    });

    it("never throws when the disable call fails (best-effort, no dead-letter)", async () => {
      const { env, calls } = fakeNotificationsBinding(500);
      const { repo: rulesRepo } = fakeRulesRepo();
      const { repo: eventsRepo } = fakeEventsRepo();
      const handler = createMessagingLaneHandler({
        rulesRepo,
        eventsRepo,
        notificationsEnv: env,
        requestId: REQUEST_ID,
      });
      await expect(handler.handleEvent(archiveEvent())).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
    });

    it("never throws when the binding itself throws", async () => {
      const throwing = {
        fetch: async () => {
          throw new Error("network down");
        },
        connect: undefined as never,
      } as unknown as Fetcher;
      const { repo: rulesRepo } = fakeRulesRepo();
      const { repo: eventsRepo } = fakeEventsRepo();
      const handler = createMessagingLaneHandler({
        rulesRepo,
        eventsRepo,
        notificationsEnv: { NOTIFICATIONS_WORKER: throwing },
        requestId: REQUEST_ID,
      });
      await expect(handler.handleEvent(archiveEvent())).resolves.toBeUndefined();
    });

    it("is a no-op without the notifications binding or the reference fields", async () => {
      const { repo: rulesRepo } = fakeRulesRepo();
      const { repo: eventsRepo } = fakeEventsRepo();
      const handler = createMessagingLaneHandler({
        rulesRepo,
        eventsRepo,
        notificationsEnv: {},
        requestId: REQUEST_ID,
      });
      await expect(handler.handleEvent(archiveEvent())).resolves.toBeUndefined();

      const { handler: withBinding, disableCalls } = laneHandler();
      await withBinding.handleEvent(archiveEvent({ connectionId: null }));
      await withBinding.handleEvent(archiveEvent({ channelExternalId: "" }));
      expect(disableCalls).toEqual([]);
    });
  });

  it("ignores unrelated messaging events", async () => {
    const { handler, suppressCalls, disableCalls } = laneHandler();
    await handler.handleEvent(storedEvent({ type: "messaging.channel.renamed", payload: { channelExternalId: "C0AAA" } }));
    await handler.handleEvent(storedEvent({ type: "messaging.command.invoked", payload: { command: "/orun" } }));
    expect(suppressCalls).toEqual([]);
    expect(disableCalls).toEqual([]);
  });
});
