// Runtime dial-home route tests (saas-agents AG6 §3–4): heartbeat, event
// ingest, lease-gated token refresh. The pinned invariant is the three-way
// gate — service principal + the session's OWN principal + a token bound to
// THIS session — and that the lease is the refresh gate (kill = never extend).

import { route } from "@agents-worker/router";
import type { AgentsDeps } from "@agents-worker/deps";
import type { SessionTokenMinter } from "@agents-worker/identity-client";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2"; // public org id carried in the URL
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2"; // what the router decodes to (repo scope)
const env: Env = { ENVIRONMENT: "test" };

function runtimeReq(
  method: string,
  path: string,
  opts?: {
    body?: unknown;
    subjectId?: string;
    subjectType?: string;
    agentSessionId?: string | null;
  },
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-actor-subject-id": opts?.subjectId ?? "sp_1",
    "x-actor-subject-type": opts?.subjectType ?? "service_principal",
  };
  if (opts?.agentSessionId !== null) {
    headers["x-actor-agent-session-id"] = opts?.agentSessionId ?? "__SESSION__";
  }
  return new Request(`https://agents-worker${path}`, {
    method,
    headers,
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function json(res: Response): Promise<{ data?: unknown; error?: { code: string; message?: string } }> {
  return (await res.json()) as { data?: unknown; error?: { code: string; message?: string } };
}

interface Fixture {
  deps: AgentsDeps;
  repo: MemoryAgentsRepository;
  sessionId: string;
  minted: string[];
}

async function fixture(opts?: { state?: "requested" | "provisioning" | "running"; lease?: string }): Promise<Fixture> {
  const repo = new MemoryAgentsRepository();
  const scope = { orgId: ORG_UUID };
  const minted: string[] = [];

  const profile = await repo.createProfile(scope, {
    name: "impl",
    principalId: "sp_1",
    owner: "team/platform",
    agentType: "implementer",
    harness: "claude-code",
    model: "claude-opus-4-8",
  });
  const session = await repo.createSession(scope, {
    profileId: profile.publicId,
    runKind: "implementation",
    spawnedBy: "usr_rahul",
  });
  const state = opts?.state ?? "provisioning";
  if (state !== "requested") {
    await repo.advanceSession(scope, { publicId: session.publicId, to: "provisioning" });
    if (state === "running") {
      await repo.advanceSession(scope, {
        publicId: session.publicId,
        to: "running",
        ...(opts?.lease !== undefined ? { leaseExpiresAt: opts.lease } : {}),
      });
    }
  }

  const deps: AgentsDeps = {
    repo,
    async authorize() {
      return true;
    },
    sessionTokens: {
      async mint(principalId, orgId, sid) {
        minted.push(`${principalId}/${orgId}/${sid}`);
        return { token: "ast_next", expiresAt: "2099-01-01T00:00:00Z" };
      },
    } satisfies SessionTokenMinter,
    async dispose() {
      /* no-op */
    },
  };
  return { deps, repo, sessionId: session.publicId, minted };
}

// Substitutes the real session id into requests built before the fixture ran.
function at(path: string, f: Fixture): string {
  return `/v1/organizations/${ORG}/agents/sessions/${f.sessionId}/${path}`;
}

function reqFor(f: Fixture, method: string, path: string, opts?: Parameters<typeof runtimeReq>[2]): Request {
  const r = runtimeReq(method, at(path, f), opts);
  // Replace the session-binding placeholder with the real id.
  if (r.headers.get("x-actor-agent-session-id") === "__SESSION__") {
    const headers = new Headers(r.headers);
    headers.set("x-actor-agent-session-id", f.sessionId);
    return new Request(r.url, { method, headers, ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  }
  return r;
}

describe("agents-worker runtime routes (AG6)", () => {
  it("first heartbeat flips provisioning → running and sets the lease", async () => {
    const f = await fixture({ state: "provisioning" });
    const res = await route(reqFor(f, "POST", "heartbeat"), env, f.deps);
    expect(res.status).toBe(200);
    const s = (await json(res)).data as { state: string; startedAt?: string };
    expect(s.state).toBe("running");
    expect(s.startedAt).toBeTruthy();
    expect((await f.repo.getSession({ orgId: ORG_UUID }, f.sessionId))?.leaseExpiresAt).toBeTruthy();
  });

  it("subsequent heartbeats extend the lease without a transition", async () => {
    const f = await fixture({ state: "running", lease: "2000-01-01T00:00:00Z" });
    const res = await route(reqFor(f, "POST", "heartbeat"), env, f.deps);
    expect(res.status).toBe(200);
    const stored = await f.repo.getSession({ orgId: ORG_UUID }, f.sessionId);
    expect(stored?.state).toBe("running");
    expect(new Date(stored!.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("gates every runtime route three ways: type, principal, session binding", async () => {
    const f = await fixture({ state: "running", lease: "2099-01-01T00:00:00Z" });
    for (const [path, body] of [
      ["heartbeat", undefined],
      ["events", [{ seq: 0, kind: "harness_event" }]],
      ["token", undefined],
    ] as const) {
      // A human user is refused even with the right subject id.
      const asUser = await route(
        reqFor(f, "POST", path, { subjectType: "user", ...(body !== undefined ? { body } : {}) }),
        env,
        f.deps,
      );
      expect(asUser.status).toBe(403);
      // A different principal is refused.
      const wrongPrincipal = await route(
        reqFor(f, "POST", path, { subjectId: "sp_other", ...(body !== undefined ? { body } : {}) }),
        env,
        f.deps,
      );
      expect(wrongPrincipal.status).toBe(403);
      // A token bound to another session is refused.
      const wrongSession = await route(
        reqFor(f, "POST", path, { agentSessionId: "as_other", ...(body !== undefined ? { body } : {}) }),
        env,
        f.deps,
      );
      expect(wrongSession.status).toBe(403);
      // No session binding at all (a plain API key) is refused.
      const noBinding = await route(
        reqFor(f, "POST", path, { agentSessionId: null, ...(body !== undefined ? { body } : {}) }),
        env,
        f.deps,
      );
      expect(noBinding.status).toBe(403);
    }
  });

  it("ingests events idempotently and refuses a non-vocabulary kind", async () => {
    const f = await fixture({ state: "running", lease: "2099-01-01T00:00:00Z" });
    const batch = [
      { seq: 0, kind: "state_changed", payload: { state: "running" } },
      { seq: 1, kind: "tool_call", payload: { tool: "Bash" } },
    ];
    const res = await route(reqFor(f, "POST", "events", { body: batch }), env, f.deps);
    expect(res.status).toBe(200);
    expect(((await json(res)).data as { accepted: number }).accepted).toBe(2);

    // Redelivery of the same seq is a no-op.
    await route(reqFor(f, "POST", "events", { body: [batch[1]] }), env, f.deps);
    expect((await f.repo.listSessionEvents({ orgId: ORG_UUID }, f.sessionId)).length).toBe(2);

    const bad = await route(
      reqFor(f, "POST", "events", { body: [{ seq: 2, kind: "status_asserted" }] }),
      env,
      f.deps,
    );
    expect(bad.status).toBe(422);
  });

  it("meters tokens from cost samples and minutes on the terminal transition (AL9)", async () => {
    const f = await fixture({ state: "running", lease: "2099-01-01T00:00:00Z" });
    const usage: Array<{ metric: string; quantity: number; dims: Record<string, string> }> = [];
    f.deps.usage = {
      async record(_orgId, metric, quantity, dims) {
        usage.push({ metric, quantity, dims });
      },
    };
    // Cost samples across two ingests sum into agents.tokens.
    await route(
      reqFor(f, "POST", "events", {
        body: [
          { seq: 0, kind: "cost_sample", payload: { tokens: 1200 } },
          { seq: 1, kind: "message_agent", payload: { text: "working" } },
        ],
      }),
      env,
      f.deps,
    );
    await route(
      reqFor(f, "POST", "events", { body: [{ seq: 2, kind: "cost_sample", payload: { tokens: 800 } }] }),
      env,
      f.deps,
    );
    const tokenSamples = usage.filter((u) => u.metric === "agents.tokens");
    expect(tokenSamples.map((u) => u.quantity)).toEqual([1200, 800]);
    expect(tokenSamples[0]!.dims).toEqual({ runKind: "implementation" });

    // A terminal state_changed emits session_minutes once (>= 1).
    await route(
      reqFor(f, "POST", "events", { body: [{ seq: 3, kind: "state_changed", payload: { state: "completed" } }] }),
      env,
      f.deps,
    );
    const minuteSamples = usage.filter((u) => u.metric === "agents.session_minutes");
    expect(minuteSamples.length).toBe(1);
    expect(minuteSamples[0]!.quantity).toBeGreaterThanOrEqual(1);

    // A non-terminal state change emits no minutes.
    const before = usage.length;
    await route(
      reqFor(f, "POST", "events", { body: [{ seq: 4, kind: "state_changed", payload: { state: "running" } }] }),
      env,
      f.deps,
    );
    expect(usage.length).toBe(before);
  });

  it("refreshes the token while the lease is live", async () => {
    const f = await fixture({ state: "running", lease: "2099-01-01T00:00:00Z" });
    const res = await route(reqFor(f, "POST", "token"), env, f.deps);
    expect(res.status).toBe(201);
    // The /token refresh body is FLAT ({token, expiresAt}) — not the {data}
    // envelope — because the orun runtime unmarshals it flat (see the handler).
    expect(((await res.json()) as { token: string }).token).toBe("ast_next");
    expect(f.minted).toEqual([`sp_1/${ORG}/${f.sessionId}`]);
  });

  it("refuses a refresh on a lapsed lease — the runaway kill switch", async () => {
    const f = await fixture({ state: "running", lease: "2000-01-01T00:00:00Z" });
    const res = await route(reqFor(f, "POST", "token"), env, f.deps);
    expect(res.status).toBe(403);
    expect((await json(res)).error?.message).toContain("lapsed");
    expect(f.minted).toEqual([]);
  });

  it("refuses a refresh on a terminal session", async () => {
    const f = await fixture({ state: "running", lease: "2099-01-01T00:00:00Z" });
    await f.repo.advanceSession({ orgId: ORG_UUID }, { publicId: f.sessionId, to: "canceled" });
    const res = await route(reqFor(f, "POST", "token"), env, f.deps);
    expect(res.status).toBe(409);
  });

  it("405s a GET on the runtime routes", async () => {
    const f = await fixture();
    expect((await route(reqFor(f, "GET", "heartbeat"), env, f.deps)).status).toBe(405);
    expect((await route(reqFor(f, "GET", "token"), env, f.deps)).status).toBe(405);
  });
});
