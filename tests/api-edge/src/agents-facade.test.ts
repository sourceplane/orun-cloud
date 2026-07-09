import { isAgentsRoute, handleAgentsRoute } from "@api-edge/agents-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({ data: { profiles: [] }, meta: { requestId: "req_test", cursor: null } }),
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
      return Promise.resolve(Response.json({ data: { profiles: [] }, meta: { requestId: "req_test", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createEnv(overrides?: Record<string, unknown>) {
  const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
  return {
    IDENTITY_WORKER: identityFetcher,
    AGENTS_WORKER: createFakeFetcher().fetcher,
    MEMBERSHIP_WORKER: createFakeFetcher().fetcher,
    ENVIRONMENT: "test",
    ...overrides,
  };
}

describe("api-edge agents facade", () => {
  describe("isAgentsRoute", () => {
    it("matches the profiles collection", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/profiles")).toBe(true);
    });
    it("matches the sessions collection + item + events", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions/as_1")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions/as_1/events")).toBe(true);
    });
    it("matches the provider connections collection + item + verify (AG12)", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/providers")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/providers/apc_1")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/providers/apc_1/verify")).toBe(true);
    });
    it("does not match unrelated or internal routes", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/config/settings")).toBe(false);
      expect(isAgentsRoute("/v1/internal/agents/sessions/as_1/events")).toBe(false);
      expect(isAgentsRoute("/v1/internal/config/provider-keys/store")).toBe(false);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents")).toBe(false);
    });
  });

  describe("handleAgentsRoute", () => {
    it("resolves the actor and forwards a GET to agents-worker with x-actor headers", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const { fetcher: agentsFetcher, calls } = createFakeFetcher();
      const env = createEnv({ IDENTITY_WORKER: identityFetcher, AGENTS_WORKER: agentsFetcher });
      const path = "/v1/organizations/org_abc/agents/profiles";
      const req = new Request(`https://api-edge${path}`, {
        method: "GET",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleAgentsRoute(req, env as never, "req_test", path);
      expect(res.status).toBe(200);
      expect(calls.length).toBe(1);
      const headers = new Headers(calls[0]!.init.headers);
      expect(headers.get("x-actor-subject-id")).toBe("usr_test");
      expect(headers.get("x-actor-subject-type")).toBe("user");
    });

    it("forwards a POST body to agents-worker", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const { fetcher: agentsFetcher, calls } = createFakeFetcher(
        Response.json({ data: { id: "as_1" }, meta: { requestId: "r", cursor: null } }, { status: 201 }),
      );
      const env = createEnv({ IDENTITY_WORKER: identityFetcher, AGENTS_WORKER: agentsFetcher });
      const path = "/v1/organizations/org_abc/agents/sessions";
      const req = new Request(`https://api-edge${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok_test" },
        body: JSON.stringify({ profileId: "agp_1", runKind: "implementation" }),
      });
      const res = await handleAgentsRoute(req, env as never, "req_test", path);
      expect(res.status).toBe(201);
      expect(calls[0]!.init.method).toBe("POST");
    });

    it("503s when the agents worker is unbound", async () => {
      const env = createEnv({ AGENTS_WORKER: undefined });
      const path = "/v1/organizations/org_abc/agents/profiles";
      const req = new Request(`https://api-edge${path}`, {
        method: "GET",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleAgentsRoute(req, env as never, "req_test", path);
      expect(res.status).toBe(503);
    });

    it("forwards a DELETE (provider connection) without a body", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const { fetcher: agentsFetcher, calls } = createFakeFetcher(
        Response.json({ data: { deleted: true }, meta: { requestId: "r", cursor: null } }),
      );
      const env = createEnv({ IDENTITY_WORKER: identityFetcher, AGENTS_WORKER: agentsFetcher });
      const path = "/v1/organizations/org_abc/agents/providers/apc_1";
      const req = new Request(`https://api-edge${path}`, {
        method: "DELETE",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleAgentsRoute(req, env as never, "req_test", path);
      expect(res.status).toBe(200);
      expect(calls[0]!.init.method).toBe("DELETE");
      expect(calls[0]!.init.body).toBeUndefined();
    });

    it("405s an unsupported method", async () => {
      const env = createEnv();
      const path = "/v1/organizations/org_abc/agents/profiles";
      const req = new Request(`https://api-edge${path}`, {
        method: "PATCH",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleAgentsRoute(req, env as never, "req_test", path);
      expect(res.status).toBe(405);
    });
  });
});
