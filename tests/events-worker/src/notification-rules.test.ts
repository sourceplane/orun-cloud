import type { Env } from "@events-worker/env";
import {
  handleCreateRule,
  handleListRules,
  handleTestRule,
  handleDeleteRule,
} from "@events-worker/handlers/notification-rules";
import { createNotificationsLaneHandler, buildRuleNotificationIdempotencyKey } from "@events-worker/lanes/notifications-lane";
import { ruleMatchesEvent } from "@events-worker/lanes/rule-match";
import type {
  EventsRepository,
  NotificationRulesRepository,
  StoredEvent,
  StoredNotificationRule,
  StoredRuleTarget,
} from "@saas/db/events";

const TEST_ORG_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TEST_ORG_PUBLIC_ID = "org_a1b2c3d4e5f67890abcdef1234567890";
const TEST_ACTOR = { subjectId: "usr_abc123", subjectType: "user" };
const REQUEST_ID = "req_test123456789012";
const NOW = new Date("2026-07-04T10:00:00.000Z");
const RULE_ID = "rule_0123456789abcdef0123456789abcdef";
const TARGET_ID = "rtgt_0123456789abcdef0123456789abcdef";

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
    ...overrides,
  };
}

function storedTarget(overrides?: Partial<StoredRuleTarget>): StoredRuleTarget {
  return {
    id: TARGET_ID,
    ruleId: RULE_ID,
    orgId: TEST_ORG_UUID,
    targetKind: "email",
    targetRef: "ops@acme.test",
    enabled: true,
    createdAt: NOW,
    ...overrides,
  };
}

function storedEvent(overrides?: Partial<StoredEvent>): StoredEvent {
  return {
    id: "evt_0123456789abcdef0123456789abcdef",
    type: "scm.pull_request.merged",
    version: 1,
    source: "integrations-worker",
    occurredAt: NOW,
    actorType: "system",
    actorId: "github",
    actorSessionId: null,
    actorIp: null,
    orgId: TEST_ORG_UUID,
    projectId: null,
    environmentId: null,
    subjectKind: "repo",
    subjectId: "acme/api",
    subjectName: null,
    requestId: REQUEST_ID,
    correlationId: null,
    causationId: null,
    idempotencyKey: null,
    payload: { repoFullName: "acme/api", number: 7 },
    redactPaths: [],
    createdAt: NOW,
    ...overrides,
  };
}

interface RepoCalls {
  created: unknown[];
  targets: unknown[];
  throttleCalls: Array<{ ruleId: string; windowSeconds: number; max: number }>;
  deleted: string[];
}

function fakeRulesRepo(options?: {
  rules?: StoredNotificationRule[];
  targetsList?: StoredRuleTarget[];
  count?: number;
  throttleAdmit?: boolean[];
  getRule?: StoredNotificationRule | null;
}): { repo: NotificationRulesRepository; calls: RepoCalls } {
  const calls: RepoCalls = { created: [], targets: [], throttleCalls: [], deleted: [] };
  let throttleIdx = 0;
  const repo: NotificationRulesRepository = {
    async createRule(input) {
      calls.created.push(input);
      return { ok: true, value: storedRule({ id: input.id, name: input.name }) };
    },
    async getRule() {
      return { ok: true, value: options?.getRule !== undefined ? options.getRule : storedRule() };
    },
    async listRulesByOrg() {
      return { ok: true, value: { items: options?.rules ?? [storedRule()], nextCursor: null } };
    },
    async listEnabledRulesByOrg() {
      return { ok: true, value: options?.rules ?? [storedRule()] };
    },
    async listOrgIdsWithEnabledRules() {
      return { ok: true, value: [TEST_ORG_UUID] };
    },
    async countRulesByOrg() {
      return { ok: true, value: options?.count ?? 0 };
    },
    async updateRule(_orgId, id, patch) {
      return { ok: true, value: storedRule({ id, ...(patch.status ? { status: patch.status } : {}) }) };
    },
    async deleteRule(_orgId, id) {
      calls.deleted.push(id);
      return { ok: true, value: true };
    },
    async tryConsumeThrottle(ruleId, windowSeconds, max) {
      calls.throttleCalls.push({ ruleId, windowSeconds, max });
      const admit = options?.throttleAdmit?.[throttleIdx] ?? true;
      throttleIdx++;
      return { ok: true, value: admit };
    },
    async addTarget(input) {
      calls.targets.push(input);
      return { ok: true, value: storedTarget({ id: input.id, targetRef: input.targetRef }) };
    },
    async listTargetsByRule() {
      return { ok: true, value: options?.targetsList ?? [storedTarget()] };
    },
    async listTargetsForRules() {
      return { ok: true, value: options?.targetsList ?? [storedTarget()] };
    },
    async removeTarget() {
      return { ok: true, value: true };
    },
  };
  return { repo, calls };
}

function fakeEventsRepo(): { repo: EventsRepository; emitted: string[] } {
  const emitted: string[] = [];
  const repo = {
    async appendEventWithAudit(input: { event: { type: string } }) {
      emitted.push(input.event.type);
      return { ok: true as const, value: { event: {}, audit: {} } };
    },
  } as unknown as EventsRepository;
  return { repo, emitted };
}

function createMockFetcher(handler?: (req: Request) => Promise<Response>): Fetcher {
  return {
    // Callers may fetch(url, init) or fetch(Request) — normalize to Request.
    fetch: (input: string | Request | URL, init?: RequestInit) => {
      if (!handler) return Promise.resolve(new Response(null, { status: 500 }));
      const request = input instanceof Request ? input : new Request(String(input), init);
      return handler(request);
    },
    connect: undefined as never,
  } as unknown as Fetcher;
}

function entitlementFetcher(overrides?: Record<string, { allowed: boolean; limitValue?: number | null; reason?: string }>): Fetcher {
  return createMockFetcher(async (req) => {
    const body = (await req.json()) as { entitlementKey: string; orgId: string };
    const config = overrides?.[body.entitlementKey];
    if (config) {
      return Response.json({
        data: config.allowed
          ? { allowed: true, orgId: body.orgId, entitlementKey: body.entitlementKey, valueType: "quantity", limitValue: config.limitValue ?? null, source: "plan", subscriptionId: "sub_1" }
          : { allowed: false, orgId: body.orgId, entitlementKey: body.entitlementKey, reason: config.reason ?? "disabled" },
      });
    }
    return Response.json({
      data: { allowed: true, orgId: body.orgId, entitlementKey: body.entitlementKey, valueType: "boolean", limitValue: null, source: "plan", subscriptionId: "sub_1" },
    });
  });
}

function createEnv(overrides?: Record<string, unknown>): Env {
  const base: Env = {
    PLATFORM_DB: { connectionString: "postgresql://test:test@localhost:5432/test" } as unknown as Hyperdrive,
    MEMBERSHIP_WORKER: createMockFetcher(async () =>
      Response.json({ data: { memberships: [{ kind: "role_assignment", role: "owner", scope: { kind: "organization", orgId: TEST_ORG_UUID } }] } }),
    ),
    POLICY_WORKER: createMockFetcher(async () =>
      Response.json({ data: { allow: true, reason: "org_owner", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    ),
    BILLING_WORKER: entitlementFetcher(),
    NOTIFICATIONS_WORKER: createMockFetcher(async () =>
      Response.json({ data: { notification: { id: "ntf_1" } } }, { status: 202 }),
    ),
    ENVIRONMENT: "test",
  };
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result as unknown as Env;
}

function req(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://events.internal${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("notification rules CRUD", () => {
  it("creates a rule with targets and emits notification_rule.created", async () => {
    const { repo, calls } = fakeRulesRepo();
    const { repo: eventsRepo, emitted } = fakeEventsRepo();
    const res = await handleCreateRule(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/notification-rules`, "POST", {
        name: "PR merges",
        eventTypes: ["scm.pull_request.*"],
        minSeverity: "info",
        targets: [{ kind: "email", ref: "ops@acme.test" }],
      }),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { rulesRepo: repo, eventsRepo },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { notificationRule: Record<string, unknown> } };
    expect(body.data.notificationRule.orgId).toBe(TEST_ORG_PUBLIC_ID);
    expect(calls.created).toHaveLength(1);
    expect(calls.targets).toHaveLength(1);
    expect(emitted).toEqual(["notification_rule.created"]);
  });

  it("rejects slack_channel and webhook_endpoint targets until ES3", async () => {
    const { repo } = fakeRulesRepo();
    const { repo: eventsRepo } = fakeEventsRepo();
    for (const kind of ["slack_channel", "webhook_endpoint"]) {
      const res = await handleCreateRule(
        req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/notification-rules`, "POST", {
          name: "x",
          eventTypes: ["*"],
          targets: [{ kind, ref: "something" }],
        }),
        createEnv(),
        REQUEST_ID,
        TEST_ACTOR,
        TEST_ORG_UUID,
        { rulesRepo: repo, eventsRepo },
      );
      expect(res.status).toBe(422);
    }
  });

  it("412s when the feature entitlement is disabled", async () => {
    const { repo } = fakeRulesRepo();
    const { repo: eventsRepo } = fakeEventsRepo();
    const env = createEnv({
      BILLING_WORKER: entitlementFetcher({
        "feature.event_routing": { allowed: false, reason: "disabled" },
      }),
    });
    const res = await handleCreateRule(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/notification-rules`, "POST", {
        name: "x",
        eventTypes: ["*"],
      }),
      env,
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { rulesRepo: repo, eventsRepo },
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("precondition_failed");
    expect(body.error.details.entitlementKey).toBe("feature.event_routing");
  });

  it("412s when the rule limit is reached", async () => {
    const { repo } = fakeRulesRepo({ count: 10 });
    const { repo: eventsRepo } = fakeEventsRepo();
    const env = createEnv({
      BILLING_WORKER: entitlementFetcher({
        "limit.notification_rules": { allowed: true, limitValue: 10 },
      }),
    });
    const res = await handleCreateRule(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/notification-rules`, "POST", {
        name: "x",
        eventTypes: ["*"],
      }),
      env,
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { rulesRepo: repo, eventsRepo },
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { details: Record<string, unknown> } };
    expect(body.error.details.reason).toBe("limit_reached");
  });

  it("404s on policy deny without leaking rules", async () => {
    const { repo } = fakeRulesRepo();
    const env = createEnv({
      POLICY_WORKER: createMockFetcher(async () =>
        Response.json({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
      ),
    });
    const res = await handleListRules(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/notification-rules`),
      env,
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { rulesRepo: repo },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(RULE_ID);
  });

  it("validates glob shapes", async () => {
    const { repo } = fakeRulesRepo();
    const { repo: eventsRepo } = fakeEventsRepo();
    const res = await handleCreateRule(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/notification-rules`, "POST", {
        name: "bad globs",
        eventTypes: ["scm.*.opened"],
      }),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { rulesRepo: repo, eventsRepo },
    );
    expect(res.status).toBe(422);
  });

  it("deletes a rule and emits notification_rule.deleted", async () => {
    const { repo, calls } = fakeRulesRepo();
    const { repo: eventsRepo, emitted } = fakeEventsRepo();
    const res = await handleDeleteRule(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/notification-rules/${RULE_ID}`, "DELETE"),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      RULE_ID,
      { rulesRepo: repo, eventsRepo },
    );
    expect(res.status).toBe(200);
    expect(calls.deleted).toEqual([RULE_ID]);
    expect(emitted).toEqual(["notification_rule.deleted"]);
  });

  it("test-fires a rule without sending", async () => {
    const { repo } = fakeRulesRepo();
    const res = await handleTestRule(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/notification-rules/${RULE_ID}/test`, "POST", {
        type: "scm.pull_request.merged",
        payload: { repoFullName: "acme/api" },
      }),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      RULE_ID,
      { rulesRepo: repo },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { matched: boolean; matchedTargets: unknown[] } };
    expect(body.data.matched).toBe(true);
    expect(body.data.matchedTargets).toHaveLength(1);
  });
});

describe("rule matching engine", () => {
  it("matches multi-segment globs, severity floors, sources, scope, filters", () => {
    const event = storedEvent();
    expect(ruleMatchesEvent(storedRule(), event)).toBe(true);
    expect(ruleMatchesEvent(storedRule({ eventTypes: ["billing.*"] }), event)).toBe(false);
    expect(ruleMatchesEvent(storedRule({ minSeverity: "error" }), event)).toBe(false);
    expect(ruleMatchesEvent(storedRule({ sources: ["state-worker"] }), event)).toBe(false);
    expect(ruleMatchesEvent(storedRule({ projectId: "other-project" }), event)).toBe(false);
    expect(
      ruleMatchesEvent(
        storedRule({ attributeFilters: [{ path: "repoFullName", op: "eq", value: "acme/api" }] }),
        event,
      ),
    ).toBe(true);
    expect(
      ruleMatchesEvent(
        storedRule({ attributeFilters: [{ path: "repoFullName", op: "eq", value: "other/repo" }] }),
        event,
      ),
    ).toBe(false);
    expect(
      ruleMatchesEvent(
        storedRule({ attributeFilters: [{ path: "number", op: "in", value: [7, 8] }] }),
        event,
      ),
    ).toBe(true);
  });

  it("payload severity escalates but never de-escalates", () => {
    const rule = storedRule({ minSeverity: "error" });
    expect(ruleMatchesEvent(rule, storedEvent({ payload: { severity: "critical" } }))).toBe(true);
    expect(ruleMatchesEvent(rule, storedEvent({ payload: { severity: "bogus" } }))).toBe(false);
  });

  it("neq requires the field to be present and different", () => {
    const rule = storedRule({ attributeFilters: [{ path: "branch", op: "neq", value: "main" }] });
    expect(ruleMatchesEvent(rule, storedEvent({ payload: { branch: "dev" } }))).toBe(true);
    expect(ruleMatchesEvent(rule, storedEvent({ payload: {} }))).toBe(false);
  });
});

describe("notifications lane handler", () => {
  function laneEnv(notificationCalls: Array<{ url: string; body: Record<string, unknown> }>) {
    return {
      NOTIFICATIONS_WORKER: createMockFetcher(async (request) => {
        notificationCalls.push({ url: request.url, body: (await request.json()) as Record<string, unknown> });
        return Response.json({ data: { notification: { id: "ntf_1" } } }, { status: 202 });
      }),
    };
  }

  it("enqueues one email per matching rule target with a deterministic idempotency key", async () => {
    const { repo } = fakeRulesRepo();
    const notificationCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const handler = createNotificationsLaneHandler({
      rulesRepo: repo,
      notificationsEnv: laneEnv(notificationCalls),
      requestId: REQUEST_ID,
    });

    const event = storedEvent();
    await handler.handleEvent(event);

    expect(notificationCalls).toHaveLength(1);
    const body = notificationCalls[0]!.body;
    expect(body.templateKey).toBe("event.notification");
    expect(body.category).toBe("product");
    expect(body.idempotencyKey).toBe(buildRuleNotificationIdempotencyKey(RULE_ID, TARGET_ID, event.id));
    expect((body.recipient as Record<string, unknown>).address).toBe("ops@acme.test");
    const templateData = body.templateData as Record<string, unknown>;
    expect(templateData.eventType).toBe("scm.pull_request.merged");
    expect(String(templateData.title)).toContain("acme/api");
  });

  it("consumes the throttle once per rule and skips when saturated", async () => {
    const { repo, calls } = fakeRulesRepo({ throttleAdmit: [false] });
    const notificationCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const handler = createNotificationsLaneHandler({
      rulesRepo: repo,
      notificationsEnv: laneEnv(notificationCalls),
      requestId: REQUEST_ID,
    });

    await handler.handleEvent(storedEvent());

    expect(calls.throttleCalls).toEqual([{ ruleId: RULE_ID, windowSeconds: 300, max: 10 }]);
    expect(notificationCalls).toHaveLength(0);
  });

  it("does not consume the throttle for non-matching events", async () => {
    const { repo, calls } = fakeRulesRepo();
    const handler = createNotificationsLaneHandler({
      rulesRepo: repo,
      notificationsEnv: {},
      requestId: REQUEST_ID,
    });
    await handler.handleEvent(storedEvent({ type: "billing.subscription.created" as string }));
    expect(calls.throttleCalls).toHaveLength(0);
  });

  it("throws on enqueue failure so the lane retries/dead-letters", async () => {
    const { repo } = fakeRulesRepo();
    const handler = createNotificationsLaneHandler({
      rulesRepo: repo,
      notificationsEnv: {
        NOTIFICATIONS_WORKER: createMockFetcher(async () => new Response(null, { status: 500 })),
      },
      requestId: REQUEST_ID,
    });
    await expect(handler.handleEvent(storedEvent())).rejects.toThrow("notification_enqueue_failed");
  });
});
