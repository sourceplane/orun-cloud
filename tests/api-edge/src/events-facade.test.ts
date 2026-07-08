import { isEventsRoute, handleEventsRoute } from "@api-edge/events-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({ data: { events: [] }, meta: { requestId: "req_test", cursor: null } }),
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
      return Promise.resolve(Response.json({ data: { events: [] }, meta: { requestId: "req_test", cursor: null } }));
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

const LIST_PATH = "/v1/organizations/org_abc123def456/events";
const GET_PATH = "/v1/organizations/org_abc123def456/events/evt_0123456789abcdef0123456789abcdef";

function makeRequest(path: string, method = "GET", headers?: Record<string, string>, body?: string): Request {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { authorization: "Bearer token123", ...headers },
    ...(body !== undefined ? { body } : {}),
  });
}

describe("api-edge events facade", () => {
  describe("isEventsRoute", () => {
    it("matches the collection route", () => {
      expect(isEventsRoute(LIST_PATH)).toBe(true);
    });
    it("matches the single-event route", () => {
      expect(isEventsRoute(GET_PATH)).toBe(true);
    });
    it("does not match audit, event-groups, or sub-paths", () => {
      expect(isEventsRoute("/v1/organizations/org_abc/audit")).toBe(false);
      expect(isEventsRoute("/v1/organizations/org_abc/event-groups")).toBe(false);
      expect(isEventsRoute("/v1/organizations/org_abc/events/evt_x/extra")).toBe(false);
    });
  });

  it("forwards GET list to events-worker with actor headers, no bearer", async () => {
    const { fetcher: eventsFetcher, calls } = createFakeFetcher();
    const env = createEnv({ EVENTS_WORKER: eventsFetcher });
    const res = await handleEventsRoute(
      makeRequest(`${LIST_PATH}?type=custom.*`, "GET", { traceparent: "00-trace-span-01" }),
      env as never,
      "req_edge_1",
      LIST_PATH,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://events.internal${LIST_PATH}?type=custom.*`);
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("x-actor-subject-id")).toBe("usr_abc123");
    expect(headers.get("x-actor-subject-type")).toBe("user");
    expect(headers.get("x-actor-email")).toBe("user@test.com");
    expect(headers.get("traceparent")).toBe("00-trace-span-01");
    expect(headers.get("authorization")).toBeNull();
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("forwards POST with body and method to events-worker", async () => {
    const { fetcher: eventsFetcher, calls } = createFakeFetcher(
      Response.json({ data: { event: { id: "evt_x" } }, meta: { requestId: "req_x" } }, { status: 201 }),
    );
    const env = createEnv({ EVENTS_WORKER: eventsFetcher });
    const res = await handleEventsRoute(
      makeRequest(LIST_PATH, "POST", { "idempotency-key": "idem-1" }, JSON.stringify({ type: "custom.x" })),
      env as never,
      "req_edge_post",
      LIST_PATH,
    );
    expect(res.status).toBe(201);
    expect(calls[0]!.url).toBe(`https://events.internal${LIST_PATH}`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeDefined();
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("idem-1");
  });

  it("forwards GET single event to events-worker", async () => {
    const { fetcher: eventsFetcher, calls } = createFakeFetcher(
      Response.json({ data: { event: { id: "evt_x" } }, meta: { requestId: "req_x" } }),
    );
    const env = createEnv({ EVENTS_WORKER: eventsFetcher });
    const res = await handleEventsRoute(makeRequest(GET_PATH), env as never, "req_edge_2", GET_PATH);
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(`https://events.internal${GET_PATH}`);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("405s PUT/DELETE on the collection", async () => {
    const env = createEnv();
    for (const method of ["PUT", "DELETE"]) {
      const res = await handleEventsRoute(makeRequest(LIST_PATH, method), env as never, "req_1", LIST_PATH);
      expect(res.status).toBe(405);
    }
  });

  it("405s POST on the single-event route", async () => {
    const env = createEnv();
    const res = await handleEventsRoute(makeRequest(GET_PATH, "POST"), env as never, "req_1", GET_PATH);
    expect(res.status).toBe(405);
  });

  it("401s when authorization header is absent", async () => {
    const env = createEnv();
    const req = new Request(`https://api.test${LIST_PATH}`, { method: "GET" });
    const res = await handleEventsRoute(req, env as never, "req_1", LIST_PATH);
    expect(res.status).toBe(401);
  });

  it("503s when EVENTS_WORKER binding is missing", async () => {
    const env = createEnv({ EVENTS_WORKER: undefined });
    const res = await handleEventsRoute(makeRequest(LIST_PATH), env as never, "req_3", LIST_PATH);
    expect(res.status).toBe(503);
  });

  it("503s when EVENTS_WORKER fetch throws", async () => {
    const env = createEnv({ EVENTS_WORKER: createThrowingFetcher() });
    const res = await handleEventsRoute(makeRequest(LIST_PATH), env as never, "req_4", LIST_PATH);
    expect(res.status).toBe(503);
  });
});
