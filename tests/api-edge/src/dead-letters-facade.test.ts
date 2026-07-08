import { isDeadLettersRoute, handleDeadLettersRoute } from "@api-edge/dead-letters-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({ data: { deadLetters: [] }, meta: { requestId: "req_test", cursor: null } }),
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

function createSessionFetcher(userId: string): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      if (url.includes("/v1/auth/resolve")) {
        return Promise.resolve(
          Response.json({
            data: {
              actor: { actorType: "user", actorId: userId, email: "user@test.com" },
              session: { id: "ses_abc" },
              user: { id: userId, email: "user@test.com", displayName: "Test" },
            },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: {}, meta: { requestId: "req_test" } }));
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

const LIST_PATH = "/v1/organizations/org_abc123def456/dead-letters";
const REPLAY_PATH = "/v1/organizations/org_abc123def456/dead-letters/dl_0123456789abcdef0123456789abcdef/replay";

function makeRequest(path: string, method = "GET"): Request {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { authorization: "Bearer token123" },
  });
}

describe("api-edge dead-letters facade", () => {
  describe("isDeadLettersRoute", () => {
    it("matches the list route", () => {
      expect(isDeadLettersRoute(LIST_PATH)).toBe(true);
    });

    it("matches the replay route", () => {
      expect(isDeadLettersRoute(REPLAY_PATH)).toBe(true);
    });

    it("does not match audit or other org routes", () => {
      expect(isDeadLettersRoute("/v1/organizations/org_abc/audit")).toBe(false);
      expect(isDeadLettersRoute("/v1/organizations/org_abc/dead-letters/dl_x")).toBe(false);
      expect(isDeadLettersRoute("/v1/organizations/org_abc/members")).toBe(false);
    });
  });

  it("forwards GET list to events-worker with actor headers", async () => {
    const { fetcher: eventsFetcher, calls } = createFakeFetcher();
    const env = createEnv({ EVENTS_WORKER: eventsFetcher });
    const res = await handleDeadLettersRoute(
      makeRequest(`${LIST_PATH}?status=open`),
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
    expect(headers.get("x-request-id")).toBe("req_edge_1");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("forwards POST replay to events-worker", async () => {
    const { fetcher: eventsFetcher, calls } = createFakeFetcher(
      Response.json({ data: { deadLetter: { status: "replayed" } }, meta: { requestId: "req_x" } }),
    );
    const env = createEnv({ EVENTS_WORKER: eventsFetcher });
    const res = await handleDeadLettersRoute(
      makeRequest(REPLAY_PATH, "POST"),
      env as never,
      "req_edge_2",
      REPLAY_PATH,
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(`https://events.internal${REPLAY_PATH}`);
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("405s wrong methods per route shape", async () => {
    const env = createEnv();
    const postList = await handleDeadLettersRoute(makeRequest(LIST_PATH, "POST"), env as never, "req_1", LIST_PATH);
    expect(postList.status).toBe(405);
    const getReplay = await handleDeadLettersRoute(makeRequest(REPLAY_PATH, "GET"), env as never, "req_2", REPLAY_PATH);
    expect(getReplay.status).toBe(405);
  });

  it("503s when EVENTS_WORKER binding is missing", async () => {
    const env = createEnv({ EVENTS_WORKER: undefined });
    const res = await handleDeadLettersRoute(makeRequest(LIST_PATH), env as never, "req_3", LIST_PATH);
    expect(res.status).toBe(503);
  });
});
