import type { Env } from "@events-worker/env";
import { handleListEvents, handleGetEvent } from "@events-worker/handlers/list-events";
import type { EventLogFilters, EventsRepository, StoredEvent } from "@saas/db/events";

const TEST_ORG_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TEST_ORG_PUBLIC_ID = "org_a1b2c3d4e5f67890abcdef1234567890";
const TEST_ACTOR = { subjectId: "usr_abc123", subjectType: "user" };
const REQUEST_ID = "req_test123456789012";
const NOW = new Date("2026-07-05T10:00:00.000Z");
const EVENT_ID = "evt_0123456789abcdef0123456789abcdef";

function storedEvent(overrides?: Partial<StoredEvent>): StoredEvent {
  return {
    id: EVENT_ID,
    type: "custom.order.placed",
    version: 1,
    source: "custom-ingest",
    occurredAt: NOW,
    actorType: "user",
    actorId: "usr_abc123",
    actorSessionId: null,
    actorIp: null,
    orgId: TEST_ORG_UUID,
    projectId: null,
    environmentId: null,
    subjectKind: "custom",
    subjectId: "custom",
    subjectName: null,
    requestId: REQUEST_ID,
    correlationId: null,
    causationId: null,
    idempotencyKey: null,
    payload: { region: "us" },
    redactPaths: [],
    createdAt: NOW,
    ...overrides,
  };
}

function fakeRepo(options?: {
  items?: StoredEvent[];
  getEvent?: StoredEvent | null;
}): { repo: EventsRepository; capturedFilters: EventLogFilters[] } {
  const capturedFilters: EventLogFilters[] = [];
  const repo = {
    async queryEventLogByOrg(_orgId: string, _params: unknown, filters?: EventLogFilters) {
      capturedFilters.push(filters ?? {});
      return { ok: true as const, value: { items: options?.items ?? [storedEvent()], nextCursor: null } };
    },
    async getEventById() {
      return { ok: true as const, value: options?.getEvent !== undefined ? options.getEvent : storedEvent() };
    },
  } as unknown as EventsRepository;
  return { repo, capturedFilters };
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

function createEnv(overrides?: Record<string, unknown>): Env {
  const base = {
    PLATFORM_DB: { connectionString: "postgresql://test:test@localhost:5432/test" } as unknown as Hyperdrive,
    MEMBERSHIP_WORKER: createMockFetcher(async () =>
      Response.json({ data: { memberships: [{ kind: "role_assignment", role: "owner", scope: { kind: "organization", orgId: TEST_ORG_UUID } }] } }),
    ),
    POLICY_WORKER: createMockFetcher(async () =>
      Response.json({ data: { allow: true, reason: "org_owner", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    ),
    ENVIRONMENT: "test",
  } as unknown as Env;
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result as unknown as Env;
}

function req(path: string): Request {
  return new Request(`https://events.internal${path}`, { method: "GET" });
}

describe("events explorer: list", () => {
  it("maps events to public ids and forwards parsed filters to the repo", async () => {
    const { repo, capturedFilters } = fakeRepo();
    const res = await handleListEvents(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/events?type=custom.*&source=custom-ingest&project=prj_00000000000000000000000000000001&from=2026-07-01T00:00:00.000Z&to=2026-07-05T00:00:00.000Z`),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { events: Array<Record<string, unknown>> } };
    expect(body.data.events[0]!.orgId).toBe(TEST_ORG_PUBLIC_ID);
    expect(body.data.events[0]!.category).toBe("custom");
    expect(capturedFilters[0]).toEqual({
      type: "custom.*",
      source: "custom-ingest",
      projectId: "00000000-0000-0000-0000-000000000001",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-05T00:00:00.000Z",
    });
  });

  it("422s a malformed project filter", async () => {
    const { repo } = fakeRepo();
    const res = await handleListEvents(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/events?project=not-a-prj`),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(422);
  });

  it("404s (leak-free) on policy deny", async () => {
    const { repo } = fakeRepo();
    const env = createEnv({
      POLICY_WORKER: createMockFetcher(async () =>
        Response.json({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
      ),
    });
    const res = await handleListEvents(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/events`),
      env,
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(EVENT_ID);
  });

  it("respects redactPaths in the projected payload", async () => {
    const { repo } = fakeRepo({
      items: [storedEvent({ payload: { secret: "shh", ok: 1 }, redactPaths: ["payload.secret"] })],
    });
    const res = await handleListEvents(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/events`),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { eventsRepo: repo },
    );
    const body = (await res.json()) as { data: { events: Array<{ payload: Record<string, unknown> }> } };
    expect(body.data.events[0]!.payload.secret).toBe("[REDACTED]");
    expect(body.data.events[0]!.payload.ok).toBe(1);
  });
});

describe("events explorer: get", () => {
  it("returns a single public event", async () => {
    const { repo } = fakeRepo();
    const res = await handleGetEvent(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/events/${EVENT_ID}`),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      EVENT_ID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { event: Record<string, unknown> } };
    expect(body.data.event.id).toBe(EVENT_ID);
    expect(body.data.event.orgId).toBe(TEST_ORG_PUBLIC_ID);
  });

  it("404s a malformed event id without touching the repo", async () => {
    const { repo } = fakeRepo();
    const res = await handleGetEvent(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/events/not-an-event`),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      "not-an-event",
      { eventsRepo: repo },
    );
    expect(res.status).toBe(404);
  });

  it("404s a missing event", async () => {
    const { repo } = fakeRepo({ getEvent: null });
    const res = await handleGetEvent(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/events/${EVENT_ID}`),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      EVENT_ID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(404);
  });

  it("404s (leak-free) on policy deny", async () => {
    const { repo } = fakeRepo();
    const env = createEnv({
      POLICY_WORKER: createMockFetcher(async () =>
        Response.json({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
      ),
    });
    const res = await handleGetEvent(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/events/${EVENT_ID}`),
      env,
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      EVENT_ID,
      { eventsRepo: repo },
    );
    expect(res.status).toBe(404);
  });
});
