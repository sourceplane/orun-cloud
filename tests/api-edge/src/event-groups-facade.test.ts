import { isEventGroupsRoute, handleEventGroupsRoute } from "@api-edge/event-groups-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({ data: { eventGroups: [] }, meta: { requestId: "req_test", cursor: null } }),
): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(response.clone());
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createThrowingFetcher(): Fetcher {
  return {
    fetch(): Promise<Response> {
      return Promise.reject(new Error("connection refused"));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createSessionFetcher(userId: string): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      if (url.includes("/v1/auth/resolve")) {
        return Promise.resolve(
          Response.json({
            data: { actor: { actorType: "user", actorId: userId, email: "user@test.com" }, session: { id: "ses_abc" }, user: { id: userId, email: "user@test.com", displayName: "Test" } },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: { eventGroups: [] }, meta: { requestId: "req_test", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createEnv(overrides?: Record<string, unknown>) {
  const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
  const { fetcher: eventsFetcher } = createFakeFetcher();
  return {
    IDENTITY_WORKER: identityFetcher,
    EVENTS_WORKER: eventsFetcher,
    MEMBERSHIP_WORKER: createFakeFetcher().fetcher,
    PROJECTS_WORKER: createFakeFetcher().fetcher,
    ENVIRONMENT: "test",
    ...overrides,
  };
}

const LIST_PATH = "/v1/organizations/org_abc123def456/event-groups";
const GET_PATH = "/v1/organizations/org_abc123def456/event-groups/grp_0123456789abcdef0123456789abcdef";

function makeRequest(path: string, method = "GET", headers?: Record<string, string>): Request {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { authorization: "Bearer token123", ...headers },
  });
}

describe("api-edge event-groups facade", () => {
  describe("isEventGroupsRoute", () => {
    it("matches the list route", () => {
      expect(isEventGroupsRoute(LIST_PATH)).toBe(true);
    });

    it("matches the single-group route", () => {
      expect(isEventGroupsRoute(GET_PATH)).toBe(true);
    });

    it("does not match audit or other org routes", () => {
      expect(isEventGroupsRoute("/v1/organizations/org_abc/audit")).toBe(false);
      expect(isEventGroupsRoute("/v1/organizations/org_abc/event-groups/grp_x/extra")).toBe(false);
      expect(isEventGroupsRoute("/v1/organizations/org_abc/members")).toBe(false);
    });
  });

  it("forwards GET list to events-worker with actor headers, no bearer", async () => {
    const { fetcher: eventsFetcher, calls } = createFakeFetcher();
    const env = createEnv({ EVENTS_WORKER: eventsFetcher });
    const res = await handleEventGroupsRoute(
      makeRequest(`${LIST_PATH}?status=open`, "GET", { traceparent: "00-trace-span-01" }),
      env as never,
      "req_edge_1",
      LIST_PATH,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://events.internal${LIST_PATH}?status=open`);
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("x-actor-subject-id")).toBe("usr_abc123");
    expect(headers.get("x-actor-subject-type")).toBe("user");
    expect(headers.get("x-actor-email")).toBe("user@test.com");
    expect(headers.get("x-request-id")).toBe("req_edge_1");
    expect(headers.get("traceparent")).toBe("00-trace-span-01");
    expect(headers.get("authorization")).toBeNull();
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("forwards GET single group to events-worker", async () => {
    const { fetcher: eventsFetcher, calls } = createFakeFetcher(
      Response.json({ data: { eventGroup: { id: "grp_x" }, members: [] }, meta: { requestId: "req_x" } }),
    );
    const env = createEnv({ EVENTS_WORKER: eventsFetcher });
    const res = await handleEventGroupsRoute(makeRequest(GET_PATH), env as never, "req_edge_2", GET_PATH);
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(`https://events.internal${GET_PATH}`);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("405s non-GET methods", async () => {
    const env = createEnv();
    const post = await handleEventGroupsRoute(makeRequest(LIST_PATH, "POST"), env as never, "req_1", LIST_PATH);
    expect(post.status).toBe(405);
  });

  it("401s when authorization header is absent", async () => {
    const env = createEnv();
    const req = new Request(`https://api.test${LIST_PATH}`, { method: "GET" });
    const res = await handleEventGroupsRoute(req, env as never, "req_1", LIST_PATH);
    expect(res.status).toBe(401);
  });

  it("503s when EVENTS_WORKER binding is missing", async () => {
    const env = createEnv({ EVENTS_WORKER: undefined });
    const res = await handleEventGroupsRoute(makeRequest(LIST_PATH), env as never, "req_3", LIST_PATH);
    expect(res.status).toBe(503);
  });

  it("503s when EVENTS_WORKER fetch throws", async () => {
    const env = createEnv({ EVENTS_WORKER: createThrowingFetcher() });
    const res = await handleEventGroupsRoute(makeRequest(LIST_PATH), env as never, "req_4", LIST_PATH);
    expect(res.status).toBe(503);
  });
});
