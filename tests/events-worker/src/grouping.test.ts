import type { Env } from "@events-worker/env";
import { createGroupingLaneHandler, GROUP_INACTIVITY_SECONDS } from "@events-worker/lanes/grouping-lane";
import { handleListEventGroups, handleGetEventGroup } from "@events-worker/handlers/event-groups";
import type {
  EventGroupsRepository,
  EventsRepository,
  StoredEvent,
  StoredEventGroup,
} from "@saas/db/events";

const ORG = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const ORG_PUBLIC = "org_a1b2c3d4e5f67890abcdef1234567890";
const GROUP_ID = "grp_0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-07-05T10:00:00.000Z");
const REQ = "req_test123456789012";
const ACTOR = { subjectId: "usr_abc", subjectType: "user" };

function event(overrides?: Partial<StoredEvent>): StoredEvent {
  return {
    id: "evt-1",
    type: "scm.push",
    version: 1,
    source: "integrations-worker",
    occurredAt: NOW,
    actorType: "system",
    actorId: "gh",
    actorSessionId: null,
    actorIp: null,
    orgId: ORG,
    projectId: null,
    environmentId: null,
    subjectKind: "repo",
    subjectId: "acme/api",
    subjectName: null,
    requestId: REQ,
    correlationId: null,
    causationId: null,
    idempotencyKey: null,
    payload: { repoFullName: "acme/api", headSha: "abc123", branch: "main" },
    redactPaths: [],
    createdAt: NOW,
    ...overrides,
  };
}

function group(overrides?: Partial<StoredEventGroup>): StoredEventGroup {
  return {
    id: GROUP_ID,
    orgId: ORG,
    groupKey: "run:" + ORG + ":acme/api:abc123",
    status: "open",
    firstEventId: "evt-1",
    lastEventId: "evt-1",
    eventCount: 1,
    maxSeverity: "info",
    firstAt: NOW,
    lastAt: NOW,
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface GroupCalls {
  created: unknown[];
  appended: unknown[];
  closedInactive: number;
}

function fakeGroupsRepo(opts?: {
  openGroup?: StoredEventGroup | null;
  createConflict?: boolean;
  list?: StoredEventGroup[];
  getGroup?: StoredEventGroup | null;
}): { repo: EventGroupsRepository; calls: GroupCalls } {
  const calls: GroupCalls = { created: [], appended: [], closedInactive: 0 };
  let openGroup = opts?.openGroup ?? null;
  const repo = {
    async closeInactiveGroups() {
      calls.closedInactive++;
      return { ok: true as const, value: [] };
    },
    async getOpenGroupByKey() {
      return { ok: true as const, value: openGroup };
    },
    async createGroup(input: unknown) {
      calls.created.push(input);
      if (opts?.createConflict) {
        openGroup = group();
        return { ok: false as const, error: { kind: "conflict" as const, entity: "event_group" } };
      }
      openGroup = group();
      return { ok: true as const, value: group() };
    },
    async appendMember(input: unknown) {
      calls.appended.push(input);
      return { ok: true as const, value: group({ eventCount: 2 }) };
    },
    async listGroupsByOrg() {
      return { ok: true as const, value: { items: opts?.list ?? [group()], nextCursor: null } };
    },
    async getGroup() {
      return { ok: true as const, value: opts?.getGroup !== undefined ? opts.getGroup : group() };
    },
    async listMembers() {
      return { ok: true as const, value: [{ groupId: GROUP_ID, eventId: "evt-1", addedAt: NOW }] };
    },
  } as unknown as EventGroupsRepository;
  return { repo, calls };
}

function fakeEventsRepo(orgIds: string[] = [ORG]): EventsRepository {
  return {
    async listRecentlyActiveOrgIds() {
      return { ok: true as const, value: orgIds };
    },
  } as unknown as EventsRepository;
}

describe("grouping lane", () => {
  it("discovers recently-active orgs", async () => {
    const { repo } = fakeGroupsRepo();
    const handler = createGroupingLaneHandler({ groupsRepo: repo, eventsRepo: fakeEventsRepo([ORG, "org-2"]), now: () => NOW });
    expect(await handler.discoverOrgIds()).toEqual([ORG, "org-2"]);
  });

  it("opens a new story for the first dedup-keyed event and sweeps inactive groups once", async () => {
    const { repo, calls } = fakeGroupsRepo({ openGroup: null });
    const handler = createGroupingLaneHandler({ groupsRepo: repo, eventsRepo: fakeEventsRepo(), now: () => NOW });
    await handler.handleEvent(event());
    await handler.handleEvent(event({ id: "evt-2" }));
    expect(calls.created).toHaveLength(1); // second event: group now exists → append
    expect(calls.closedInactive).toBe(1); // swept once per tick
  });

  it("appends to an existing open story", async () => {
    const { repo, calls } = fakeGroupsRepo({ openGroup: group() });
    const handler = createGroupingLaneHandler({ groupsRepo: repo, eventsRepo: fakeEventsRepo(), now: () => NOW });
    await handler.handleEvent(event({ id: "evt-2" }));
    expect(calls.created).toHaveLength(0);
    expect(calls.appended).toHaveLength(1);
  });

  it("ignores events without an authored dedup key", async () => {
    const { repo, calls } = fakeGroupsRepo();
    const handler = createGroupingLaneHandler({ groupsRepo: repo, eventsRepo: fakeEventsRepo(), now: () => NOW });
    // scm.pull_request.opened has no dedupKey in the catalog.
    await handler.handleEvent(event({ type: "scm.pull_request.opened", payload: {} }));
    expect(calls.created).toHaveLength(0);
    expect(calls.appended).toHaveLength(0);
  });

  it("skips an event whose key field is missing (no partial grouping)", async () => {
    const { repo, calls } = fakeGroupsRepo();
    const handler = createGroupingLaneHandler({ groupsRepo: repo, eventsRepo: fakeEventsRepo(), now: () => NOW });
    await handler.handleEvent(event({ payload: { repoFullName: "acme/api" } })); // no headSha
    expect(calls.created).toHaveLength(0);
  });

  it("recovers from a create race by appending to the winner", async () => {
    const { repo, calls } = fakeGroupsRepo({ openGroup: null, createConflict: true });
    const handler = createGroupingLaneHandler({ groupsRepo: repo, eventsRepo: fakeEventsRepo(), now: () => NOW });
    await handler.handleEvent(event());
    expect(calls.created).toHaveLength(1);
    expect(calls.appended).toHaveLength(1); // fell through to append the winner
  });

  it("keeps the inactivity window as the documented default", () => {
    expect(GROUP_INACTIVITY_SECONDS).toBe(30 * 60);
  });
});

// ---------------------------------------------------------------------------
// Groups read API
// ---------------------------------------------------------------------------

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
    PLATFORM_DB: { connectionString: "postgresql://t:t@localhost/t" },
    MEMBERSHIP_WORKER: createMockFetcher(async () =>
      Response.json({ data: { memberships: [{ kind: "role_assignment", role: "viewer", scope: { kind: "organization", orgId: ORG } }] } }),
    ),
    POLICY_WORKER: createMockFetcher(async () => Response.json({ data: { allow: true } })),
    ENVIRONMENT: "test",
  } as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base as unknown as Env;
}

function req(path: string): Request {
  return new Request(`https://events.internal${path}`, { method: "GET" });
}

describe("event-groups read API", () => {
  it("lists groups with public org ids", async () => {
    const { repo } = fakeGroupsRepo({ list: [group()] });
    const res = await handleListEventGroups(
      req(`/v1/organizations/${ORG_PUBLIC}/event-groups?status=open`),
      createEnv(),
      REQ,
      ACTOR,
      ORG,
      { groupsRepo: repo },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { eventGroups: Array<Record<string, unknown>> } };
    expect(body.data.eventGroups[0]!.id).toBe(GROUP_ID);
    expect(body.data.eventGroups[0]!.orgId).toBe(ORG_PUBLIC);
  });

  it("404s on policy deny without leaking group data", async () => {
    const { repo } = fakeGroupsRepo({ list: [group()] });
    const env = createEnv({ POLICY_WORKER: createMockFetcher(async () => Response.json({ data: { allow: false } })) });
    const res = await handleListEventGroups(
      req(`/v1/organizations/${ORG_PUBLIC}/event-groups`),
      env,
      REQ,
      ACTOR,
      ORG,
      { groupsRepo: repo },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(GROUP_ID);
  });

  it("gets a group with its member timeline", async () => {
    const { repo } = fakeGroupsRepo({ getGroup: group() });
    const res = await handleGetEventGroup(
      req(`/v1/organizations/${ORG_PUBLIC}/event-groups/${GROUP_ID}`),
      createEnv(),
      REQ,
      ACTOR,
      ORG,
      GROUP_ID,
      { groupsRepo: repo },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { eventGroup: Record<string, unknown>; members: unknown[] } };
    expect(body.data.eventGroup.id).toBe(GROUP_ID);
    expect(body.data.members).toHaveLength(1);
  });

  it("404s a malformed group id", async () => {
    const { repo } = fakeGroupsRepo();
    const res = await handleGetEventGroup(
      req(`/v1/organizations/${ORG_PUBLIC}/event-groups/not-a-group`),
      createEnv(),
      REQ,
      ACTOR,
      ORG,
      "not-a-group",
      { groupsRepo: repo },
    );
    expect(res.status).toBe(404);
  });
});
