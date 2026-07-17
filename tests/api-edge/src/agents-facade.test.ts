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
    it("matches the sessions collection + item + events + provision + runtime routes", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions/as_1")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions/as_1/events")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions/as_1/provision")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions/as_1/heartbeat")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions/as_1/token")).toBe(true);
    });
    it("matches the provider connections collection + item + verify (AG12)", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/providers")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/providers/apc_1")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/providers/apc_1/verify")).toBe(true);
    });
    it("matches autonomy + dispatch (AG9)", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/autonomy")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/dispatch")).toBe(true);
    });
    it("matches the attention fold (saas-agents-fleet AF5)", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/attention")).toBe(true);
    });
    it("matches the tree-transitive cancel (saas-agents-fleet AF4)", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions/as_1/cancel")).toBe(true);
    });
    it("matches the routine registry (saas-agents-fleet AF6)", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/routines")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/routines/rt_1")).toBe(true);
    });
    it("matches the records read + the profile item (saas-agents-fleet AF7)", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/records")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/profiles/agp_1")).toBe(true);
    });
    it("matches the budgets registry (saas-agents-fleet AF8)", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/budgets")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/budgets/bud_1")).toBe(true);
    });
    it("matches the head-facing relay attach + input routes (AL7)", () => {
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions/as_1/attach")).toBe(true);
      expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions/as_1/input")).toBe(true);
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

    it("forwards the session binding for an agent-session bearer — and never a spoofed inbound header", async () => {
      const calls: FetchCall[] = [];
      const identityFetcher = {
        fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          calls.push({ url, init: init ?? {} });
          return Promise.resolve(
            Response.json({
              data: {
                actor: { actorType: "service_principal", actorId: "sp_agent1", orgId: "org_abc" },
                agentSession: { id: "as_42" },
              },
              meta: { requestId: "req_inner", cursor: null },
            }),
          );
        },
        connect() {
          throw new Error("not implemented");
        },
      } as unknown as Fetcher;
      const { fetcher: agentsFetcher, calls: agentsCalls } = createFakeFetcher();
      const env = createEnv({ IDENTITY_WORKER: identityFetcher, AGENTS_WORKER: agentsFetcher });
      const path = "/v1/organizations/org_abc/agents/sessions/as_42/heartbeat";
      const req = new Request(`https://api-edge${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer ast_token",
          // A spoof attempt: must never pass through as-is.
          "x-actor-agent-session-id": "as_someone_elses",
          "x-actor-subject-id": "sp_spoof",
        },
      });
      const res = await handleAgentsRoute(req, env as never, "req_test", path);
      expect(res.status).toBe(200);
      const headers = new Headers(agentsCalls[0]!.init.headers);
      expect(headers.get("x-actor-agent-session-id")).toBe("as_42");
      expect(headers.get("x-actor-subject-id")).toBe("sp_agent1");
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

    it("forwards a PUT body (autonomy policy)", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const { fetcher: agentsFetcher, calls } = createFakeFetcher(
        Response.json({ data: { level: "full" }, meta: { requestId: "r", cursor: null } }),
      );
      const env = createEnv({ IDENTITY_WORKER: identityFetcher, AGENTS_WORKER: agentsFetcher });
      const path = "/v1/organizations/org_abc/agents/autonomy";
      const req = new Request(`https://api-edge${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer tok_test" },
        body: JSON.stringify({ level: "full" }),
      });
      const res = await handleAgentsRoute(req, env as never, "req_test", path);
      expect(res.status).toBe(200);
      expect(calls[0]!.init.method).toBe("PUT");
      expect(calls[0]!.init.body).toBeDefined();
    });

    it("405s an unsupported method", async () => {
      // PATCH joined the allowlist with the AF6 routine registry; OPTIONS
      // stays out — the facade never answers preflight for the worker.
      const env = createEnv();
      const path = "/v1/organizations/org_abc/agents/profiles";
      const req = new Request(`https://api-edge${path}`, {
        method: "OPTIONS",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleAgentsRoute(req, env as never, "req_test", path);
      expect(res.status).toBe(405);
    });
  });
});

// ── AN0/AN2 (saas-agents-native): the wire route + the upgrade pass-through ─

describe("agents facade: the body wire + WS upgrade (AN0/AN2)", () => {
  it("matches the wire route", () => {
    expect(isAgentsRoute("/v1/organizations/org_abc/agents/sessions/as_1/wire")).toBe(true);
  });

  it("forwards a WebSocket upgrade with the actor stamped and no idempotency layer", async () => {
    // Node cannot construct a 101; a 200 stands in for the accepted upgrade.
    const agents = createFakeFetcher(new Response(null, { status: 200 }));
    const env = createEnv({ AGENTS_WORKER: agents.fetcher });
    const path = "/v1/organizations/org_abc/agents/sessions/as_1/attach";
    const res = await handleAgentsRoute(
      new Request(`https://api.example.com${path}?from=-1&surface=console`, {
        headers: { authorization: "Bearer tok", upgrade: "websocket", connection: "Upgrade" },
      }),
      env as never,
      "req_up1",
      path,
    );
    expect(res.status).toBe(200);
    expect(agents.calls).toHaveLength(1);
    const fwd = agents.calls[0]!.url.includes("attach") ? agents.calls[0]! : agents.calls[0]!;
    expect(fwd.url).toContain("/attach?from=-1&surface=console");
  });

  it("accepts the query bearer on the attach route (browser WS) and strips it before forwarding", async () => {
    const captured: Request[] = [];
    const agents = {
      fetch(input: Request | string | URL): Promise<Response> {
        const req = input instanceof Request ? input : new Request(String(input));
        captured.push(req);
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      connect() {
        throw new Error("not implemented");
      },
    } as unknown as Fetcher;
    const env = createEnv({ AGENTS_WORKER: agents });
    const path = "/v1/organizations/org_abc/agents/sessions/as_1/attach";
    const res = await handleAgentsRoute(
      new Request(`https://api.example.com${path}?from=-1&access_token=tok-browser`, {
        headers: { upgrade: "websocket" },
      }),
      env as never,
      "req_up2",
      path,
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).not.toContain("access_token");
    expect(captured[0]!.headers.get("authorization")).toBeNull(); // never forwarded
    expect(captured[0]!.headers.get("x-actor-subject-id")).toBe("usr_abc123");
  });

  it("rejects the query bearer on non-attach routes (the wire authenticates with its header)", async () => {
    const env = createEnv();
    const path = "/v1/organizations/org_abc/agents/sessions/as_1/wire";
    const res = await handleAgentsRoute(
      new Request(`https://api.example.com${path}?access_token=tok`, { headers: { upgrade: "websocket" } }),
      env as never,
      "req_up3",
      path,
    );
    expect(res.status).toBe(401);
  });

  it("accepts the query bearer on a plain attach GET (the EventSource fallback)", async () => {
    const agents = createFakeFetcher(new Response("data: {}\n", { status: 200 }));
    const env = createEnv({ AGENTS_WORKER: agents.fetcher });
    const path = "/v1/organizations/org_abc/agents/sessions/as_1/attach";
    const res = await handleAgentsRoute(
      new Request(`https://api.example.com${path}?from=-1&access_token=tok-browser`),
      env as never,
      "req_sse1",
      path,
    );
    expect(res.status).toBe(200);
    expect(agents.calls).toHaveLength(1);
    expect(agents.calls[0]!.url).not.toContain("access_token");
  });
});

// ── AN4 (saas-agents-native): the Workspace Agent chat facade ───────────────

describe("agents facade: the chat plane (AN4)", () => {
  const chatBase = "/v1/organizations/org_abc/agents/chats";

  it("recognizes the chat routes", () => {
    expect(isAgentsRoute(chatBase)).toBe(true);
    expect(isAgentsRoute(`${chatBase}/ch_1`)).toBe(true);
    expect(isAgentsRoute(`${chatBase}/ch_1/turn`)).toBe(true);
  });

  it("routes chat traffic to CHAT_WORKER, not AGENTS_WORKER", async () => {
    const chat = createFakeFetcher(Response.json({ data: [] }));
    const agents = createFakeFetcher(Response.json({ data: [] }));
    const env = createEnv({ CHAT_WORKER: chat.fetcher, AGENTS_WORKER: agents.fetcher });
    const res = await handleAgentsRoute(
      new Request(`https://api.example.com${chatBase}`, { headers: { authorization: "Bearer tok" } }),
      env as never,
      "req_chat1",
      chatBase,
    );
    expect(res.status).toBe(200);
    expect(chat.calls).toHaveLength(1);
    expect(agents.calls).toHaveLength(0);
  });

  it("forwards the owner bearer ONLY on the turn route", async () => {
    const seen: { url: string; owner: string | null }[] = [];
    const chat = {
      fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const headers = new Headers(init?.headers);
        seen.push({ url, owner: headers.get("x-owner-bearer") });
        return Promise.resolve(Response.json({ data: { accepted: true } }));
      },
      connect() {
        throw new Error("not implemented");
      },
    } as unknown as Fetcher;
    const env = createEnv({ CHAT_WORKER: chat });

    await handleAgentsRoute(
      new Request(`https://api.example.com${chatBase}/ch_1/turn`, {
        method: "POST",
        headers: { authorization: "Bearer tok-owner", "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
      env as never,
      "req_chat2",
      `${chatBase}/ch_1/turn`,
    );
    await handleAgentsRoute(
      new Request(`https://api.example.com${chatBase}/ch_1`, { headers: { authorization: "Bearer tok-owner" } }),
      env as never,
      "req_chat3",
      `${chatBase}/ch_1`,
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]!.owner).toBe("tok-owner"); // the turn route carries it
    expect(seen[1]!.owner).toBeNull(); // nothing else does
  });

  it("accepts the query bearer on the chat WS upgrade (browser socket)", async () => {
    const captured: Request[] = [];
    const chat = {
      fetch(input: Request | string | URL): Promise<Response> {
        const req = input instanceof Request ? input : new Request(String(input));
        captured.push(req);
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      connect() {
        throw new Error("not implemented");
      },
    } as unknown as Fetcher;
    const env = createEnv({ CHAT_WORKER: chat });
    const res = await handleAgentsRoute(
      new Request(`https://api.example.com${chatBase}/ch_1?from=-1&access_token=tok-browser`, {
        headers: { upgrade: "websocket" },
      }),
      env as never,
      "req_chat4",
      `${chatBase}/ch_1`,
    );
    expect(res.status).toBe(200);
    expect(captured[0]!.url).not.toContain("access_token");
    expect(captured[0]!.headers.get("x-actor-subject-id")).toBe("usr_abc123");
  });
});
