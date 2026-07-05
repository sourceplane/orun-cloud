import { isNotificationChannelsRoute, handleNotificationChannelsRoute } from "@api-edge/notification-channels-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(response: Response = Response.json({ data: {} })): {
  fetcher: Fetcher;
  calls: FetchCall[];
} {
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
              actor: { actorType: "user", actorId: userId, email: "u@test.com" },
              session: { id: "ses" },
              user: { id: userId, email: "u@test.com", displayName: "T" },
            },
            meta: { requestId: "r" },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: {} }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createEnv(overrides?: Record<string, unknown>) {
  return {
    IDENTITY_WORKER: createSessionFetcher("usr_abc"),
    NOTIFICATIONS_WORKER: createFakeFetcher().fetcher,
    MEMBERSHIP_WORKER: createFakeFetcher().fetcher,
    PROJECTS_WORKER: createFakeFetcher().fetcher,
    ENVIRONMENT: "test",
    ...overrides,
  };
}

const CHANNELS = "/v1/organizations/org_abc123/notification-channels";
const CHANNEL = `${CHANNELS}/chan_0123456789abcdef0123456789abcdef`;
const TEST = `${CHANNEL}/test`;

function req(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("api-edge notification-channels facade", () => {
  it("matches collection, item, and test routes", () => {
    expect(isNotificationChannelsRoute(CHANNELS)).toBe(true);
    expect(isNotificationChannelsRoute(CHANNEL)).toBe(true);
    expect(isNotificationChannelsRoute(TEST)).toBe(true);
    expect(isNotificationChannelsRoute("/v1/organizations/org_abc/notification-rules")).toBe(false);
  });

  it("forwards POST create to notifications-worker with x-internal-actor=api-edge", async () => {
    const { fetcher, calls } = createFakeFetcher(Response.json({ data: {} }, { status: 201 }));
    const env = createEnv({ NOTIFICATIONS_WORKER: fetcher });
    const res = await handleNotificationChannelsRoute(
      req(CHANNELS, "POST", { name: "Ops", webhookUrl: "https://hooks.slack.com/services/x" }),
      env as never,
      "req_e",
      CHANNELS,
    );
    expect(res.status).toBe(201);
    expect(calls[0]!.url).toBe(`https://notifications.internal${CHANNELS}`);
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("x-internal-actor")).toBe("api-edge");
    expect(headers.get("x-actor-subject-id")).toBe("usr_abc");
  });

  it("enforces per-path methods", async () => {
    const env = createEnv();
    expect((await handleNotificationChannelsRoute(req(CHANNELS, "PATCH"), env as never, "r", CHANNELS)).status).toBe(405);
    expect((await handleNotificationChannelsRoute(req(CHANNEL, "GET"), env as never, "r", CHANNEL)).status).toBe(405);
    expect((await handleNotificationChannelsRoute(req(TEST, "GET"), env as never, "r", TEST)).status).toBe(405);
  });

  it("503s without the notifications binding", async () => {
    const env = createEnv({ NOTIFICATIONS_WORKER: undefined });
    const res = await handleNotificationChannelsRoute(req(CHANNELS), env as never, "r", CHANNELS);
    expect(res.status).toBe(503);
  });
});
