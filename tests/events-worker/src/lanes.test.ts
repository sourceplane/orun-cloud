import type { Env } from "@events-worker/env";
import {
  runLaneDispatch,
  isLaneSuppressedEvent,
  MAX_LANE_ATTEMPTS,
} from "@events-worker/lanes/dispatcher";
import type { LaneHandler } from "@events-worker/lanes/types";
import { handleListDeadLetters, handleReplayDeadLetter } from "@events-worker/handlers/dead-letters";
import type {
  EventsRepository,
  EventStreamsRepository,
  StoredDeadLetter,
  StoredEvent,
  StoredSubscriberLane,
} from "@saas/db/events";

const TEST_ORG_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TEST_ORG_PUBLIC_ID = "org_a1b2c3d4e5f67890abcdef1234567890";
const TEST_ACTOR = { subjectId: "usr_abc123", subjectType: "user" };
const REQUEST_ID = "req_test123456789012";
const NOW = new Date("2026-07-04T10:00:00.000Z");
const DL_ID = "dl_0123456789abcdef0123456789abcdef";

function storedEvent(overrides?: Partial<StoredEvent>): StoredEvent {
  return {
    id: "evt-1",
    type: "scm.push",
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
    payload: {},
    redactPaths: [],
    createdAt: NOW,
    ...overrides,
  };
}

function lane(overrides?: Partial<StoredSubscriberLane>): StoredSubscriberLane {
  return {
    laneKey: "notifications",
    ownerContext: "events",
    description: "",
    typeFilter: [],
    status: "active",
    batchSize: 100,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function deadLetter(overrides?: Partial<StoredDeadLetter>): StoredDeadLetter {
  return {
    id: DL_ID,
    laneKey: "notifications",
    eventId: "evt-1",
    orgId: TEST_ORG_UUID,
    reason: "boom",
    attempts: 1,
    status: "open",
    firstFailedAt: NOW,
    lastFailedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface StreamsCalls {
  advances: Array<{ laneKey: string; orgId: string; lastEventId: string }>;
  deadLetters: Array<{ laneKey: string; eventId: string; reason: string }>;
  marks: Array<{ id: string; status: string }>;
}

function fakeStreamsRepo(options: {
  lanes?: StoredSubscriberLane[];
  recordAttempts?: number[];
  deadLetterRow?: StoredDeadLetter | null;
  listItems?: StoredDeadLetter[];
}): { repo: EventStreamsRepository; calls: StreamsCalls } {
  const calls: StreamsCalls = { advances: [], deadLetters: [], marks: [] };
  let recordCall = 0;
  const repo: EventStreamsRepository = {
    async upsertLane() {
      throw new Error("unused");
    },
    async listLanes() {
      return { ok: true, value: options.lanes ?? [] };
    },
    async getLane() {
      return { ok: true, value: null };
    },
    async setLaneStatus() {
      return { ok: true, value: null };
    },
    async getLaneCursor(laneKey, orgId) {
      return {
        ok: true,
        value: { laneKey, orgId, lastEventId: null, lastOccurredAt: null, updatedAt: new Date(0) },
      };
    },
    async advanceLaneCursor(laneKey, orgId, lastEventId, lastOccurredAt) {
      calls.advances.push({ laneKey, orgId, lastEventId });
      return {
        ok: true,
        value: { laneKey, orgId, lastEventId, lastOccurredAt: new Date(lastOccurredAt), updatedAt: NOW },
      };
    },
    async recordDeadLetter(input) {
      calls.deadLetters.push({ laneKey: input.laneKey, eventId: input.eventId, reason: input.reason });
      const attempts = options.recordAttempts?.[recordCall] ?? recordCall + 1;
      recordCall++;
      return { ok: true, value: deadLetter({ eventId: input.eventId, attempts, reason: input.reason }) };
    },
    async getDeadLetter() {
      return { ok: true, value: options.deadLetterRow ?? null };
    },
    async listDeadLettersByOrg() {
      return { ok: true, value: { items: options.listItems ?? [], nextCursor: null } };
    },
    async markDeadLetter(_orgId, id, status) {
      calls.marks.push({ id, status });
      return { ok: true, value: deadLetter({ id, status: status as StoredDeadLetter["status"] }) };
    },
  };
  return { repo, calls };
}

function fakeEventsRepo(options: {
  events?: StoredEvent[];
  eventById?: StoredEvent | null;
}): { repo: EventsRepository; emitted: string[] } {
  const emitted: string[] = [];
  const repo = {
    async appendEvent() {
      throw new Error("unused");
    },
    async appendEventWithAudit(input: { event: { type: string } }) {
      emitted.push(input.event.type);
      return { ok: true as const, value: { event: {}, audit: {} } };
    },
    async queryAuditByOrg() {
      throw new Error("unused");
    },
    async queryAuditByTarget() {
      throw new Error("unused");
    },
    async queryEventsByOrg() {
      return { ok: true as const, value: options.events ?? [] };
    },
    async getEventById() {
      return { ok: true as const, value: options.eventById ?? null };
    },
    async listScmEventsSince() {
      throw new Error("unused");
    },
    async listRunResultEventsSince() {
      throw new Error("unused");
    },
  } as unknown as EventsRepository;
  return { repo, emitted };
}

function handler(laneKey: string, impl?: (event: StoredEvent) => Promise<void>): LaneHandler & { handled: string[] } {
  const handled: string[] = [];
  return {
    laneKey,
    handled,
    async discoverOrgIds() {
      return [TEST_ORG_UUID];
    },
    async handleEvent(event) {
      handled.push(event.id);
      if (impl) await impl(event);
    },
  };
}

describe("lane dispatcher", () => {
  it("suppresses meta namespaces", () => {
    expect(isLaneSuppressedEvent("event.delivery_failed")).toBe(true);
    expect(isLaneSuppressedEvent("dead_letter.created")).toBe(true);
    expect(isLaneSuppressedEvent("scm.push")).toBe(false);
  });

  it("runs only active lanes that have a registered handler", async () => {
    const { repo: streamsRepo, calls } = fakeStreamsRepo({
      lanes: [
        lane({ laneKey: "webhooks", ownerContext: "webhooks" }), // active, no handler here
        lane({ laneKey: "notifications", status: "paused" }), // paused: kill switch
        lane({ laneKey: "grouping" }), // active + handled
      ],
    });
    const { repo: eventsRepo } = fakeEventsRepo({ events: [storedEvent()] });
    const grouping = handler("grouping");
    const notifications = handler("notifications");

    const summary = await runLaneDispatch({
      streamsRepo,
      eventsRepo,
      handlers: [grouping, notifications],
      requestId: REQUEST_ID,
    });

    expect(summary.lanesRun).toBe(1);
    expect(grouping.handled).toEqual(["evt-1"]);
    expect(notifications.handled).toEqual([]);
    expect(calls.advances).toEqual([{ laneKey: "grouping", orgId: TEST_ORG_UUID, lastEventId: "evt-1" }]);
  });

  it("skips suppressed and filtered events but advances the cursor past them", async () => {
    const { repo: streamsRepo, calls } = fakeStreamsRepo({
      lanes: [lane({ typeFilter: ["scm.*"] })],
    });
    const { repo: eventsRepo } = fakeEventsRepo({
      events: [
        storedEvent({ id: "evt-1", type: "dead_letter.created" }),
        storedEvent({ id: "evt-2", type: "billing.subscription.created" }),
        storedEvent({ id: "evt-3", type: "scm.pull_request.opened" }),
      ],
    });
    const h = handler("notifications");

    const summary = await runLaneDispatch({ streamsRepo, eventsRepo, handlers: [h], requestId: REQUEST_ID });

    expect(h.handled).toEqual(["evt-3"]);
    expect(summary.eventsProcessed).toBe(1);
    expect(calls.advances).toEqual([{ laneKey: "notifications", orgId: TEST_ORG_UUID, lastEventId: "evt-3" }]);
  });

  it("stalls the org at a failing event (bounded retry) and emits event.delivery_failed once", async () => {
    const { repo: streamsRepo, calls } = fakeStreamsRepo({ lanes: [lane()], recordAttempts: [1] });
    const { repo: eventsRepo, emitted } = fakeEventsRepo({
      events: [storedEvent({ id: "evt-ok" }), storedEvent({ id: "evt-bad" }), storedEvent({ id: "evt-after" })],
    });
    const h = handler("notifications", async (event) => {
      if (event.id === "evt-bad") throw new Error("boom");
    });

    const summary = await runLaneDispatch({ streamsRepo, eventsRepo, handlers: [h], requestId: REQUEST_ID });

    // Cursor advanced only to the last good event; evt-after untouched.
    expect(calls.advances).toEqual([{ laneKey: "notifications", orgId: TEST_ORG_UUID, lastEventId: "evt-ok" }]);
    expect(calls.deadLetters).toEqual([{ laneKey: "notifications", eventId: "evt-bad", reason: "boom" }]);
    expect(emitted).toEqual(["event.delivery_failed"]);
    expect(summary.orgsStalled).toBe(1);
    expect(h.handled).toEqual(["evt-ok", "evt-bad"]);
  });

  it("dead-letters after MAX_LANE_ATTEMPTS and advances past the poisoned event", async () => {
    const { repo: streamsRepo, calls } = fakeStreamsRepo({
      lanes: [lane()],
      recordAttempts: [MAX_LANE_ATTEMPTS],
    });
    const { repo: eventsRepo, emitted } = fakeEventsRepo({
      events: [storedEvent({ id: "evt-bad" }), storedEvent({ id: "evt-after" })],
    });
    const h = handler("notifications", async (event) => {
      if (event.id === "evt-bad") throw new Error("still broken");
    });

    const summary = await runLaneDispatch({ streamsRepo, eventsRepo, handlers: [h], requestId: REQUEST_ID });

    expect(summary.eventsDeadLettered).toBe(1);
    expect(emitted).toEqual(["dead_letter.created"]);
    // Advanced past the poisoned event to the end of the batch.
    expect(calls.advances).toEqual([{ laneKey: "notifications", orgId: TEST_ORG_UUID, lastEventId: "evt-after" }]);
    expect(h.handled).toEqual(["evt-bad", "evt-after"]);
  });
});

// ---------------------------------------------------------------------------
// Dead-letter HTTP handlers
// ---------------------------------------------------------------------------

function createMockFetcher(handlerFn?: (req: Request) => Promise<Response>): Fetcher {
  return {
    fetch: handlerFn ?? (async () => new Response(null, { status: 500 })),
    connect: undefined as never,
  } as unknown as Fetcher;
}

function createEnv(overrides?: Record<string, unknown>): Env {
  const base: Env = {
    PLATFORM_DB: {
      connectionString: "postgresql://test:test@localhost:5432/test",
    } as unknown as Hyperdrive,
    MEMBERSHIP_WORKER: createMockFetcher(async () =>
      Response.json({
        data: {
          memberships: [
            { kind: "role_assignment", role: "owner", scope: { kind: "organization", orgId: TEST_ORG_UUID } },
          ],
        },
      }),
    ),
    POLICY_WORKER: createMockFetcher(async () =>
      Response.json({ data: { allow: true, reason: "org_owner", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
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

function req(path: string, method = "GET"): Request {
  return new Request(`https://events.internal${path}`, { method });
}

describe("dead-letter handlers", () => {
  it("lists dead letters with public org ids", async () => {
    const { repo: streamsRepo } = fakeStreamsRepo({ listItems: [deadLetter()] });
    const res = await handleListDeadLetters(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/dead-letters`),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { streamsRepo },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deadLetters: Array<Record<string, unknown>> } };
    expect(body.data.deadLetters).toHaveLength(1);
    expect(body.data.deadLetters[0]!.id).toBe(DL_ID);
    expect(body.data.deadLetters[0]!.orgId).toBe(TEST_ORG_PUBLIC_ID);
    expect(body.data.deadLetters[0]!.status).toBe("open");
  });

  it("returns 404 on policy deny without leaking data", async () => {
    const { repo: streamsRepo } = fakeStreamsRepo({ listItems: [deadLetter()] });
    const env = createEnv({
      POLICY_WORKER: createMockFetcher(async () =>
        Response.json({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
      ),
    });
    const res = await handleListDeadLetters(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/dead-letters`),
      env,
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { streamsRepo },
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(DL_ID);
  });

  it("rejects invalid status filter", async () => {
    const { repo: streamsRepo } = fakeStreamsRepo({});
    const res = await handleListDeadLetters(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/dead-letters?status=bogus`),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      { streamsRepo },
    );
    expect(res.status).toBe(422);
  });

  it("replays an open dead letter through the lane handler", async () => {
    const { repo: streamsRepo, calls } = fakeStreamsRepo({ deadLetterRow: deadLetter() });
    const { repo: eventsRepo, emitted } = fakeEventsRepo({ eventById: storedEvent() });
    const h = handler("notifications");

    const res = await handleReplayDeadLetter(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/dead-letters/${DL_ID}/replay`, "POST"),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      DL_ID,
      { streamsRepo, eventsRepo, handlers: [h] },
    );

    expect(res.status).toBe(200);
    expect(h.handled).toEqual(["evt-1"]);
    expect(calls.marks).toEqual([{ id: DL_ID, status: "replayed" }]);
    expect(emitted).toEqual(["dead_letter.replayed"]);
  });

  it("409s when the dead letter is not open", async () => {
    const { repo: streamsRepo } = fakeStreamsRepo({ deadLetterRow: deadLetter({ status: "replayed" }) });
    const { repo: eventsRepo } = fakeEventsRepo({});
    const res = await handleReplayDeadLetter(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/dead-letters/${DL_ID}/replay`, "POST"),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      DL_ID,
      { streamsRepo, eventsRepo, handlers: [handler("notifications")] },
    );
    expect(res.status).toBe(409);
  });

  it("409s when no events-owned handler exists for the lane", async () => {
    const { repo: streamsRepo } = fakeStreamsRepo({ deadLetterRow: deadLetter({ laneKey: "webhooks" }) });
    const { repo: eventsRepo } = fakeEventsRepo({});
    const res = await handleReplayDeadLetter(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/dead-letters/${DL_ID}/replay`, "POST"),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      DL_ID,
      { streamsRepo, eventsRepo, handlers: [handler("notifications")] },
    );
    expect(res.status).toBe(409);
  });

  it("502s and re-records when the replay fails; dead letter stays open", async () => {
    const { repo: streamsRepo, calls } = fakeStreamsRepo({ deadLetterRow: deadLetter() });
    const { repo: eventsRepo } = fakeEventsRepo({ eventById: storedEvent() });
    const failing = handler("notifications", async () => {
      throw new Error("still broken");
    });

    const res = await handleReplayDeadLetter(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/dead-letters/${DL_ID}/replay`, "POST"),
      createEnv(),
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      DL_ID,
      { streamsRepo, eventsRepo, handlers: [failing] },
    );

    expect(res.status).toBe(502);
    expect(calls.marks).toEqual([]);
    expect(calls.deadLetters).toEqual([
      { laneKey: "notifications", eventId: "evt-1", reason: "replay_failed" },
    ]);
  });

  it("denies replay before doing any work when policy denies", async () => {
    const { repo: streamsRepo, calls } = fakeStreamsRepo({ deadLetterRow: deadLetter() });
    const { repo: eventsRepo } = fakeEventsRepo({ eventById: storedEvent() });
    const h = handler("notifications");
    const env = createEnv({
      POLICY_WORKER: createMockFetcher(async () =>
        Response.json({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
      ),
    });

    const res = await handleReplayDeadLetter(
      req(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/dead-letters/${DL_ID}/replay`, "POST"),
      env,
      REQUEST_ID,
      TEST_ACTOR,
      TEST_ORG_UUID,
      DL_ID,
      { streamsRepo, eventsRepo, handlers: [h] },
    );

    expect(res.status).toBe(404);
    expect(h.handled).toEqual([]);
    expect(calls.marks).toEqual([]);
  });
});
