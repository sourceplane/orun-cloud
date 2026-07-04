import { isNotificationRulesRoute, handleNotificationRulesRoute } from "@api-edge/notification-rules-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({ data: {}, meta: { requestId: "req_test", cursor: null } }),
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

function createSessionFetcher(userId: string): Fetcher {
  return {
    fetch(input: string | Request | URL): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
}

function createEnv(overrides?: Record<string, unknown>) {
  return {
    IDENTITY_WORKER: createSessionFetcher("usr_abc123"),
    EVENTS_WORKER: createFakeFetcher().fetcher,
    MEMBERSHIP_WORKER: createFakeFetcher().fetcher,
    PROJECTS_WORKER: createFakeFetcher().fetcher,
    ENVIRONMENT: "test",
    ...overrides,
  };
}

const RULES_PATH = "/v1/organizations/org_abc123def456/notification-rules";
const RULE_PATH = `${RULES_PATH}/rule_0123456789abcdef0123456789abcdef`;
const TEST_PATH = `${RULE_PATH}/test`;

function makeRequest(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { authorization: "Bearer token123", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("api-edge notification-rules facade", () => {
  it("route matching covers collection, item, and test paths", () => {
    expect(isNotificationRulesRoute(RULES_PATH)).toBe(true);
    expect(isNotificationRulesRoute(RULE_PATH)).toBe(true);
    expect(isNotificationRulesRoute(TEST_PATH)).toBe(true);
    expect(isNotificationRulesRoute("/v1/organizations/org_abc/audit")).toBe(false);
  });

  it("forwards POST create with body and actor headers", async () => {
    const { fetcher, calls } = createFakeFetcher(
      Response.json({ data: { notificationRule: { id: "rule_x" } }, meta: { requestId: "r" } }, { status: 201 }),
    );
    const env = createEnv({ EVENTS_WORKER: fetcher });
    const res = await handleNotificationRulesRoute(
      makeRequest(RULES_PATH, "POST", { name: "x", eventTypes: ["*"] }),
      env as never,
      "req_edge_1",
      RULES_PATH,
    );
    expect(res.status).toBe(201);
    expect(calls[0]!.url).toBe(`https://events.internal${RULES_PATH}`);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("x-actor-subject-id")).toBe("usr_abc123");
  });

  it("enforces per-path method shapes", async () => {
    const env = createEnv();
    expect((await handleNotificationRulesRoute(makeRequest(RULES_PATH, "PATCH"), env as never, "r1", RULES_PATH)).status).toBe(405);
    expect((await handleNotificationRulesRoute(makeRequest(RULE_PATH, "POST"), env as never, "r2", RULE_PATH)).status).toBe(405);
    expect((await handleNotificationRulesRoute(makeRequest(TEST_PATH, "GET"), env as never, "r3", TEST_PATH)).status).toBe(405);
  });

  it("503s when EVENTS_WORKER is missing", async () => {
    const env = createEnv({ EVENTS_WORKER: undefined });
    const res = await handleNotificationRulesRoute(makeRequest(RULES_PATH), env as never, "r4", RULES_PATH);
    expect(res.status).toBe(503);
  });
});
