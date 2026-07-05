import type { Env } from "@events-worker/env";
import { handleIngestEvent } from "@events-worker/handlers/ingest-event";
import { route } from "@events-worker/router";
import type { AppendEventInput, EventsRepository, StoredEvent } from "@saas/db/events";

const TEST_ORG_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TEST_ORG_PUBLIC_ID = "org_a1b2c3d4e5f67890abcdef1234567890";
const TEST_ACTOR = { subjectId: "usr_abc123", subjectType: "user" };
const REQUEST_ID = "req_test123456789012";
const NOW = new Date("2026-07-05T10:00:00.000Z");

function storedFromInput(input: AppendEventInput): StoredEvent {
  return {
    id: input.id,
    type: input.type,
    version: input.version,
    source: input.source,
    occurredAt: input.occurredAt,
    actorType: input.actorType,
    actorId: input.actorId,
    actorSessionId: input.actorSessionId ?? null,
    actorIp: input.actorIp ?? null,
    orgId: input.orgId,
    projectId: input.projectId ?? null,
    environmentId: input.environmentId ?? null,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    subjectName: input.subjectName ?? null,
    requestId: input.requestId,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    payload: input.payload,
    redactPaths: input.redactPaths ?? [],
    createdAt: NOW,
  };
}

interface FakeRepoOptions {
  count?: number;
  existingByIdemKey?: StoredEvent | null;
  appendConflict?: boolean;
}

function fakeEventsRepo(options?: FakeRepoOptions): { repo: EventsRepository; appended: AppendEventInput[] } {
  const appended: AppendEventInput[] = [];
  const repo = {
    async appendEvent(input: AppendEventInput) {
      appended.push(input);
      if (options?.appendConflict) {
        return { ok: false as const, error: { kind: "conflict" as const, entity: "event" } };
      }
      return { ok: true as const, value: storedFromInput(input) };
    },
    async countCustomEventsSince() {
      return { ok: true as const, value: options?.count ?? 0 };
    },
    async findEventByIdempotencyKey() {
      return { ok: true as const, value: options?.existingByIdemKey ?? null };
    },
  } as unknown as EventsRepository;
  return { repo, appended };
}

function createMockFetcher(handler?: (req: Request) => Promise<Response>): Fetcher {
  return {
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
    ENVIRONMENT: "test",
  } as unknown as Env;
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result as unknown as Env;
}

function req(path: string, method = "POST", body?: unknown): Request {
  return new Request(`https://events.internal${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const PATH = `/v1/organizations/${TEST_ORG_PUBLIC_ID}/events`;

describe("custom event ingest", () => {
  it("401s when the actor headers are absent (router)", async () => {
    const res = await route(req(PATH, "POST", { type: "custom.x" }), createEnv());
    expect(res.status).toBe(401);
  });

  it("422s a reserved-namespace type (namespace escape)", async () => {
    const { repo } = fakeEventsRepo();
    const res = await handleIngestEvent(
      req(PATH, "POST", { type: "billing.invoice_paid" }),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { fields: Record<string, string[]> } } };
    expect(body.error.details.fields.type).toBeDefined();
  });

  it("422s an oversized payload", async () => {
    const { repo } = fakeEventsRepo();
    const big = "x".repeat(33 * 1024);
    const res = await handleIngestEvent(
      req(PATH, "POST", { type: "custom.big", payload: { blob: big } }),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(422);
  });

  it("402s when the custom-ingest feature entitlement is disabled", async () => {
    const { repo } = fakeEventsRepo();
    const env = createEnv({
      BILLING_WORKER: entitlementFetcher({ "feature.events.custom_ingest": { allowed: false, reason: "disabled" } }),
    });
    const res = await handleIngestEvent(
      req(PATH, "POST", { type: "custom.x" }),
      env,
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("entitlement_required");
    expect(body.error.details.entitlementKey).toBe("feature.events.custom_ingest");
  });

  it("412s when the daily quota is exhausted", async () => {
    const { repo } = fakeEventsRepo({ count: 5 });
    const env = createEnv({
      BILLING_WORKER: entitlementFetcher({ "limit.custom_events_per_day": { allowed: true, limitValue: 5 } }),
    });
    const res = await handleIngestEvent(
      req(PATH, "POST", { type: "custom.x" }),
      env,
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.details.limit).toBe(5);
  });

  it("201s on success, persisting with source custom-ingest and mapping to a PublicEvent", async () => {
    const { repo, appended } = fakeEventsRepo();
    const res = await handleIngestEvent(
      req(PATH, "POST", {
        type: "custom.order.placed",
        title: "Order placed",
        severity: "notice",
        payload: { orderId: "o-1" },
      }),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { event: Record<string, unknown> } };
    expect(body.data.event.type).toBe("custom.order.placed");
    expect(body.data.event.orgId).toBe(TEST_ORG_PUBLIC_ID);
    expect(body.data.event.category).toBe("custom");
    expect(body.data.event.severity).toBe("notice");
    expect(body.data.event.title).toBe("Order placed");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.source).toBe("custom-ingest");
    expect(appended[0]!.orgId).toBe(TEST_ORG_UUID);
  });

  it("returns the existing event (200) on idempotent replay", async () => {
    const existing = storedFromInput({
      id: "evt_0123456789abcdef0123456789abcdef",
      type: "custom.order.placed",
      version: 1,
      source: "custom-ingest",
      occurredAt: NOW,
      actorType: "user",
      actorId: "usr_abc123",
      orgId: TEST_ORG_UUID,
      subjectKind: "custom",
      subjectId: "custom",
      requestId: "req_prev",
      idempotencyKey: "idem-1",
      payload: {},
    });
    const { repo, appended } = fakeEventsRepo({ existingByIdemKey: existing });
    const res = await handleIngestEvent(
      req(PATH, "POST", { type: "custom.order.placed", idempotencyKey: "idem-1" }),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { event: Record<string, unknown> } };
    expect(body.data.event.id).toBe("evt_0123456789abcdef0123456789abcdef");
    expect(appended).toHaveLength(0); // no duplicate insert
  });

  it("404s (leak-free) on policy deny", async () => {
    const { repo } = fakeEventsRepo();
    const env = createEnv({
      POLICY_WORKER: createMockFetcher(async () =>
        Response.json({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
      ),
    });
    const res = await handleIngestEvent(
      req(PATH, "POST", { type: "custom.x" }),
      env,
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(404);
  });
});
