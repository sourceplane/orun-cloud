// Situation facade (saas-dispatch DX0). Invariants under test: the fold is a
// composition of existing reads with the viewer's actor stamped on every
// downstream call; ready = fold-rung ready ∧ unassigned; in-flight = live
// infrastructure states only; waiting-on-me passes the attention fold through
// with provenance; sections degrade independently; the whole route 503s only
// when every source fails; the cursor is the work fold's sequence watermark.

import { isDispatchRoute, handleDispatchRoute } from "@api-edge/dispatch-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
  headers: Headers;
}

function jsonResponse(data: unknown): Response {
  return Response.json({ data, meta: { requestId: "req_down", cursor: null } });
}

/** A fetcher that answers by URL suffix; records calls + stamped headers. */
function createRoutedFetcher(routes: Record<string, unknown | Error>): {
  fetcher: Fetcher;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const req = input instanceof Request ? input : new Request(input.toString(), init);
      calls.push({ url: req.url, init: init ?? {}, headers: req.headers });
      for (const [suffix, data] of Object.entries(routes)) {
        if (new URL(req.url).pathname.endsWith(suffix)) {
          if (data instanceof Error) return Promise.reject(data);
          return Promise.resolve(jsonResponse(data));
        }
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createIdentityFetcher(userId: string): Fetcher {
  return {
    fetch(): Promise<Response> {
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
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

const WORK_SET = {
  tasks: [
    {
      key: "ORN-1",
      title: "Ready and unassigned",
      spec: "epic-a",
      lifecycle: { rung: "ready", ready: true, blocked: false, evidence: ["contract complete", "deps closed"] },
    },
    {
      key: "ORN-2",
      title: "Ready but claimed",
      lifecycle: { rung: "ready", ready: true, blocked: false },
      assignees: ["sp_agent1"],
    },
    {
      key: "ORN-3",
      title: "Still drafting",
      lifecycle: { rung: "draft", ready: false, blocked: false },
    },
    {
      key: "ORN-4",
      title: "Already reviewing",
      lifecycle: { rung: "in_review", ready: false, blocked: false },
    },
  ],
  coordSeq: 42,
  obsSeq: 17,
};

const SESSIONS = [
  { id: "as_live1", state: "running", runKind: "implementation", profileId: "agp_1", spawnedBy: "usr_a", taskKey: "ORN-9", tokensUsed: 1200 },
  { id: "as_wait", state: "awaiting_approval", runKind: "design", profileId: "agp_1", spawnedBy: "usr_a", tokensUsed: 300 },
  { id: "as_done", state: "completed", runKind: "implementation", profileId: "agp_1", spawnedBy: "usr_a", tokensUsed: 9000 },
  { id: "as_dead", state: "failed", runKind: "fix", profileId: "agp_2", spawnedBy: "usr_b" },
];

const ATTENTION = {
  items: [
    {
      kind: "verdict",
      reason: "wants to run npx wrangler deploy",
      at: "2026-07-20T10:00:00Z",
      sessionId: "as_wait",
      request: { requestId: "apr_1", tool: "bash" },
    },
    { kind: "routine_parked", reason: "2 consecutive failures", at: "2026-07-20T09:00:00Z", routineId: "rt_1" },
  ],
  counts: { verdict: 1, budget: 0, routine_parked: 1, failed_retryable: 0, stuck: 0 },
  running: 1,
};

const BUDGETS = [
  { id: "bud_1", grain: "workspace", maxTokens: 500000 },
  { id: "bud_2", grain: "routine", ref: "rt_1", maxTokens: 10000 },
];

function envWith(overrides?: Record<string, unknown>) {
  const agents = createRoutedFetcher({
    "/agents/sessions": SESSIONS,
    "/agents/attention": ATTENTION,
    "/agents/budgets": BUDGETS,
  });
  const state = createRoutedFetcher({ "/work": WORK_SET });
  return {
    env: {
      ENVIRONMENT: "test",
      IDENTITY_WORKER: createIdentityFetcher("usr_viewer"),
      AGENTS_WORKER: agents.fetcher,
      STATE_WORKER: state.fetcher,
      ...overrides,
    },
    agentsCalls: agents.calls,
    stateCalls: state.calls,
  };
}

const PATH = "/v1/organizations/org_abc/dispatch/situation";

function situationRequest(): Request {
  return new Request(`https://api.test${PATH}`, {
    method: "GET",
    headers: { authorization: "Bearer tok_viewer" },
  });
}

async function situationOf(res: Response): Promise<Record<string, any>> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, any> };
  return body.data;
}

describe("dispatch facade (DX0)", () => {
  it("matches the situation + index routes only", () => {
    expect(isDispatchRoute(PATH)).toBe(true);
    expect(isDispatchRoute("/v1/organizations/org_abc/dispatch/index")).toBe(true);
    expect(isDispatchRoute("/v1/organizations/org_abc/dispatch")).toBe(false);
    expect(isDispatchRoute("/v1/organizations/org_abc/agents/sessions")).toBe(false);
  });

  it("folds ready ∧ unassigned with the fold's evidence, never recomputing", async () => {
    const { env } = envWith();
    const data = await situationOf(await handleDispatchRoute(situationRequest(), env as never, "req_t", PATH));
    expect(data.ready.map((r: any) => r.key)).toEqual(["ORN-1"]);
    expect(data.ready[0].plane).toBe("work");
    expect(data.ready[0].evidence).toEqual(["contract complete", "deps closed"]);
  });

  it("keeps only live infrastructure states in in-flight", async () => {
    const { env } = envWith();
    const data = await situationOf(await handleDispatchRoute(situationRequest(), env as never, "req_t", PATH));
    expect(data.inFlight.map((s: any) => s.id).sort()).toEqual(["as_live1", "as_wait"]);
    for (const s of data.inFlight) expect(s.plane).toBe("session");
  });

  it("passes the attention fold through with provenance and plane tags", async () => {
    const { env } = envWith();
    const data = await situationOf(await handleDispatchRoute(situationRequest(), env as never, "req_t", PATH));
    expect(data.waitingOnMe).toHaveLength(2);
    const verdict = data.waitingOnMe.find((i: any) => i.kind === "verdict");
    expect(verdict.plane).toBe("session");
    expect(verdict.request).toEqual({ requestId: "apr_1", tool: "bash" });
    const parked = data.waitingOnMe.find((i: any) => i.kind === "routine_parked");
    expect(parked.plane).toBe("governance");
    expect(data.counts.verdict).toBe(1);
    expect(data.counts.running).toBe(1);
  });

  it("folds the workspace budget ceiling + live spend", async () => {
    const { env } = envWith();
    const data = await situationOf(await handleDispatchRoute(situationRequest(), env as never, "req_t", PATH));
    expect(data.budget.workspaceMaxTokens).toBe(500000);
    // Live spend counts live sessions only (1200 + 300), never terminal ones.
    expect(data.budget.liveTokens).toBe(1500);
    expect(data.budget.softMark).toBe(0.8);
  });

  it("carries the work fold's sequence watermark as the cursor", async () => {
    const { env } = envWith();
    const data = await situationOf(await handleDispatchRoute(situationRequest(), env as never, "req_t", PATH));
    expect(data.cursor).toBe("w42.17");
  });

  it("stamps the resolved viewer on EVERY downstream call (per-viewer fold)", async () => {
    const { env, agentsCalls, stateCalls } = envWith();
    await handleDispatchRoute(situationRequest(), env as never, "req_t", PATH);
    const all = [...agentsCalls, ...stateCalls];
    expect(all.length).toBe(4);
    for (const call of all) {
      expect(call.headers.get("x-actor-subject-id")).toBe("usr_viewer");
      expect(call.headers.get("x-actor-subject-type")).toBe("user");
      // The viewer's bearer never travels downstream — actor stamping only.
      expect(call.headers.get("authorization")).toBeNull();
    }
  });

  it("degrades a failed section to empty + unavailable, keeping the rest", async () => {
    const { env } = envWith({
      STATE_WORKER: createRoutedFetcher({ "/work": new Error("state down") }).fetcher,
    });
    const data = await situationOf(await handleDispatchRoute(situationRequest(), env as never, "req_t", PATH));
    expect(data.ready).toEqual([]);
    expect(data.sections.ready.unavailable).toBe(true);
    expect(data.inFlight.length).toBe(2);
    expect(data.sections.inFlight.unavailable).toBeUndefined();
    expect(data.cursor).toBe("w0.0");
  });

  it("503s situation_unavailable only when every source fails", async () => {
    const { env } = envWith({
      STATE_WORKER: undefined,
      AGENTS_WORKER: undefined,
    });
    const res = await handleDispatchRoute(situationRequest(), env as never, "req_t", PATH);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("situation_unavailable");
  });

  it("401s an unauthenticated request before any downstream call", async () => {
    const { env, agentsCalls, stateCalls } = envWith();
    const res = await handleDispatchRoute(
      new Request(`https://api.test${PATH}`, { method: "GET" }),
      env as never,
      "req_t",
      PATH,
    );
    expect(res.status).toBe(401);
    expect(agentsCalls.length + stateCalls.length).toBe(0);
  });

  it("forwards the index route to chat-worker with the actor stamped and the query token stripped (DX1)", async () => {
    const chat = createRoutedFetcher({ "/dispatch/index": { cursor: "w7.7", counts: {} } });
    const { env } = envWith({ CHAT_WORKER: chat.fetcher });
    const indexPath = "/v1/organizations/org_abc/dispatch/index";
    const res = await handleDispatchRoute(
      new Request(`https://api.test${indexPath}?access_token=tok_ws`, { method: "GET" }),
      env as never,
      "req_t",
      indexPath,
    );
    expect(res.status).toBe(200);
    expect(chat.calls).toHaveLength(1);
    const fwd = chat.calls[0]!;
    expect(fwd.headers.get("x-actor-subject-id")).toBe("usr_viewer");
    expect(fwd.headers.get("authorization")).toBeNull();
    expect(fwd.url).not.toContain("access_token"); // never forwarded, never logged
  });

  it("503s the index route when chat-worker is unbound", async () => {
    const { env } = envWith({ CHAT_WORKER: undefined });
    const indexPath = "/v1/organizations/org_abc/dispatch/index";
    const res = await handleDispatchRoute(
      new Request(`https://api.test${indexPath}`, { method: "GET", headers: { authorization: "Bearer t" } }),
      env as never,
      "req_t",
      indexPath,
    );
    expect(res.status).toBe(503);
  });

  it("405s non-GET methods", async () => {
    const { env } = envWith();
    const res = await handleDispatchRoute(
      new Request(`https://api.test${PATH}`, { method: "POST", headers: { authorization: "Bearer t" } }),
      env as never,
      "req_t",
      PATH,
    );
    expect(res.status).toBe(405);
  });
});
