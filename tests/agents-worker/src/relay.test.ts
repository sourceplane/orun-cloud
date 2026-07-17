// Body-facing relay route tests (#466): the in-sandbox runtime's live wire —
// POST /stream (delta fan-out), GET /inputs (steer return-queue poll), POST
// /inputs/ack. The pinned invariants: (1) the SAME three-way session gate as
// heartbeat/events (a leaked session id must not open the input queue), and
// (2) the route reaches the per-session DO when the gate passes.

import { route } from "@agents-worker/router";
import type { AgentsDeps } from "@agents-worker/deps";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const baseEnv: Env = { ENVIRONMENT: "test" };

interface Captured {
  url: string;
  method: string;
}

/** A minimal SESSION_RELAY DO namespace double: records the forwarded request
 * and returns a canned relay response. */
function mockRelay(capture: Captured[], body: unknown = { items: [], cursor: 0 }): NonNullable<Env["SESSION_RELAY"]> {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (req: Request) => {
        capture.push({ url: new URL(req.url).pathname + new URL(req.url).search, method: req.method });
        return Response.json(body);
      },
    }),
  } as unknown as NonNullable<Env["SESSION_RELAY"]>;
}

interface Fixture {
  deps: AgentsDeps;
  sessionId: string;
}

async function fixture(): Promise<Fixture> {
  const repo = new MemoryAgentsRepository();
  const scope = { orgId: ORG_UUID };
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
  await repo.advanceSession(scope, { publicId: session.publicId, to: "provisioning" });
  await repo.advanceSession(scope, {
    publicId: session.publicId,
    to: "running",
    leaseExpiresAt: "2099-01-01T00:00:00Z",
  });
  const deps: AgentsDeps = {
    repo,
    async authorize() {
      return true;
    },
    async dispose() {
      /* no-op */
    },
  };
  return { deps, sessionId: session.publicId };
}

function relayReq(
  f: Fixture,
  method: string,
  suffix: string,
  opts?: { body?: unknown; subjectId?: string; subjectType?: string; agentSessionId?: string | null },
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-actor-subject-id": opts?.subjectId ?? "sp_1",
    "x-actor-subject-type": opts?.subjectType ?? "service_principal",
  };
  if (opts?.agentSessionId !== null) {
    headers["x-actor-agent-session-id"] = opts?.agentSessionId ?? f.sessionId;
  }
  return new Request(`https://agents-worker/v1/organizations/${ORG}/agents/sessions/${f.sessionId}/${suffix}`, {
    method,
    headers,
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("agents-worker body-facing relay routes (#466)", () => {
  const routes = [
    { suffix: "stream", method: "POST", body: { t: "delta", text: "x" } },
    { suffix: "inputs", method: "GET", body: undefined },
    { suffix: "inputs/ack", method: "POST", body: { t: "ack", ref: "c-1", ok: true } },
  ] as const;

  it("gates every relay route three ways: type, principal, session binding", async () => {
    const f = await fixture();
    const env = { ...baseEnv, SESSION_RELAY: mockRelay([]) };
    for (const r of routes) {
      const asUser = await route(relayReq(f, r.method, r.suffix, { subjectType: "user", body: r.body }), env, f.deps);
      expect(asUser.status).toBe(403);
      const wrongPrincipal = await route(
        relayReq(f, r.method, r.suffix, { subjectId: "sp_other", body: r.body }),
        env,
        f.deps,
      );
      expect(wrongPrincipal.status).toBe(403);
      const wrongSession = await route(
        relayReq(f, r.method, r.suffix, { agentSessionId: "as_other", body: r.body }),
        env,
        f.deps,
      );
      expect(wrongSession.status).toBe(403);
      const noBinding = await route(
        relayReq(f, r.method, r.suffix, { agentSessionId: null, body: r.body }),
        env,
        f.deps,
      );
      expect(noBinding.status).toBe(403);
    }
  });

  it("returns 503 (not 404) when the gate passes but the relay DO is unbound", async () => {
    const f = await fixture();
    for (const r of routes) {
      const res = await route(relayReq(f, r.method, r.suffix, { body: r.body }), baseEnv, f.deps);
      expect(res.status).toBe(503); // reached the forward — route is wired + gated
    }
  });

  it("forwards a steer-queue poll to the per-session DO with the cursor", async () => {
    const f = await fixture();
    const capture: Captured[] = [];
    const env = { ...baseEnv, SESSION_RELAY: mockRelay(capture, { items: [{ t: "input" }], cursor: 7 }) };
    const res = await route(
      new Request(
        `https://agents-worker/v1/organizations/${ORG}/agents/sessions/${f.sessionId}/inputs?cursor=4`,
        { method: "GET", headers: { "x-actor-subject-id": "sp_1", "x-actor-subject-type": "service_principal", "x-actor-agent-session-id": f.sessionId } },
      ),
      env,
      f.deps,
    );
    expect(res.status).toBe(200);
    expect(capture[0]!.method).toBe("GET");
    expect(capture[0]!.url).toBe("/inputs?cursor=4");
    expect(((await res.json()) as { cursor: number }).cursor).toBe(7);
  });

  it("forwards a delta to /stream and an ack to /inputs/ack", async () => {
    const f = await fixture();
    const capture: Captured[] = [];
    const env = { ...baseEnv, SESSION_RELAY: mockRelay(capture, { ok: true }) };
    await route(relayReq(f, "POST", "stream", { body: { t: "delta", text: "x" } }), env, f.deps);
    await route(relayReq(f, "POST", "inputs/ack", { body: { t: "ack", ref: "c-1", ok: true } }), env, f.deps);
    expect(capture.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /stream", "POST /inputs/ack"]);
  });

  it("405s the wrong method on each relay route", async () => {
    const f = await fixture();
    const env = { ...baseEnv, SESSION_RELAY: mockRelay([]) };
    expect((await route(relayReq(f, "GET", "stream"), env, f.deps)).status).toBe(405);
    expect((await route(relayReq(f, "POST", "inputs"), env, f.deps)).status).toBe(405);
    expect((await route(relayReq(f, "GET", "inputs/ack"), env, f.deps)).status).toBe(405);
  });
});

// ── AN1 (saas-agents-native): session-epoch routing + the WS door ──────────

import { chooseRelayNamespace } from "@agents-worker/relay-epoch";

function mockNamespace(capture: Captured[], body: unknown = { ok: true }, label = "ns"): NonNullable<Env["SESSION_RELAY"]> {
  return {
    label,
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (req: Request) => {
        capture.push({ url: new URL(req.url).pathname + new URL(req.url).search, method: req.method });
        return Response.json(body);
      },
    }),
  } as unknown as NonNullable<Env["SESSION_RELAY"]>;
}

describe("AN1: session-epoch relay routing (lock 7)", () => {
  const oldNs = mockNamespace([], {}, "old");
  const newNs = mockNamespace([], {}, "new");

  it("routes everything to the SDK class when no cutover is set", () => {
    const env: Env = { ...baseEnv, SESSION_RELAY: oldNs, ATTACH_RELAY: newNs };
    expect(chooseRelayNamespace(env, "2026-01-01T00:00:00Z")).toBe(newNs);
    expect(chooseRelayNamespace(env)).toBe(newNs);
  });

  it("drains pre-cutover sessions on the old class, lands new ones on the SDK class", () => {
    const env: Env = {
      ...baseEnv,
      SESSION_RELAY: oldNs,
      ATTACH_RELAY: newNs,
      RELAY_CUTOVER_AT: "2026-07-01T00:00:00Z",
    };
    expect(chooseRelayNamespace(env, "2026-06-30T23:59:59Z")).toBe(oldNs);
    expect(chooseRelayNamespace(env, "2026-07-01T00:00:00Z")).toBe(newNs);
    expect(chooseRelayNamespace(env, "2026-07-15T12:00:00Z")).toBe(newNs);
  });

  it("falls back to whichever single class is bound", () => {
    expect(chooseRelayNamespace({ ...baseEnv, SESSION_RELAY: oldNs })).toBe(oldNs);
    expect(chooseRelayNamespace({ ...baseEnv, ATTACH_RELAY: newNs })).toBe(newNs);
    expect(chooseRelayNamespace({ ...baseEnv })).toBeNull();
  });
});

describe("AN1: the attach door (WS upgrade + SSE fallback)", () => {
  function headReq(f: Fixture, opts?: { upgrade?: boolean; sessionId?: string }): Request {
    const headers: Record<string, string> = {
      "x-actor-subject-id": "usr_alice",
      "x-actor-subject-type": "user",
    };
    if (opts?.upgrade) headers["upgrade"] = "websocket";
    return new Request(
      `https://agents-worker/v1/organizations/${ORG}/agents/sessions/${opts?.sessionId ?? f.sessionId}/attach?from=-1&surface=console`,
      { method: "GET", headers },
    );
  }

  it("forwards a WS upgrade to the SDK class with the edge-stamped principal on the URL", async () => {
    const f = await fixture();
    const capture: Captured[] = [];
    const env: Env = { ...baseEnv, ATTACH_RELAY: mockNamespace(capture) };
    const res = await route(headReq(f, { upgrade: true }), env, f.deps);
    expect(res.status).toBe(200);
    expect(capture).toHaveLength(1);
    expect(capture[0]!.url).toBe("/attach?from=-1&surface=console&principal=usr_alice");
  });

  it("refuses the upgrade (426) when the session drains on the KV class — the client falls back to SSE", async () => {
    const f = await fixture();
    const capture: Captured[] = [];
    const env: Env = {
      ...baseEnv,
      SESSION_RELAY: mockNamespace(capture),
      ATTACH_RELAY: mockNamespace(capture),
      RELAY_CUTOVER_AT: "2099-01-01T00:00:00Z", // every session pre-dates it
    };
    const res = await route(headReq(f, { upgrade: true }), env, f.deps);
    expect(res.status).toBe(426);
    expect(capture).toHaveLength(0);

    // The same session's plain GET still gets its SSE feed from the old class.
    const sse = await route(headReq(f), env, f.deps);
    expect(sse.status).toBe(200);
    expect(capture).toHaveLength(1);
  });

  it("404s an attach to a session that does not exist (no phantom DO)", async () => {
    const f = await fixture();
    const env: Env = { ...baseEnv, ATTACH_RELAY: mockNamespace([]) };
    const res = await route(headReq(f, { sessionId: "as_missing" }), env, f.deps);
    expect(res.status).toBe(404);
  });
});

describe("AN1/AN3: the ingest mirror (typed RPC on the SDK class)", () => {
  it("mirrors an accepted event batch to the relay DO via ingestEvents()", async () => {
    const f = await fixture();
    const batches: unknown[] = [];
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        ingestEvents: async (frames: unknown[]) => {
          batches.push(frames);
          return frames.length;
        },
      }),
    } as unknown as NonNullable<Env["SESSION_RELAY"]>;
    const env: Env = { ...baseEnv, ATTACH_RELAY: ns };

    const res = await route(
      relayReq(f, "POST", "events", {
        body: [{ seq: 0, kind: "message_agent", payload: { text: "hi" }, at: "2026-07-17T00:00:00Z" }],
      }),
      env,
      f.deps,
    );
    expect(res.status).toBe(200);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      { v: 1, t: "event", seq: 0, kind: "message_agent", at: "2026-07-17T00:00:00Z", payload: { text: "hi" } },
    ]);
  });

  it("a draining KV-class session still mirrors over the HTTP forward", async () => {
    const f = await fixture();
    const capture: Captured[] = [];
    const env: Env = {
      ...baseEnv,
      SESSION_RELAY: mockNamespace(capture, { accepted: 1 }),
      ATTACH_RELAY: mockNamespace([], {}),
      RELAY_CUTOVER_AT: "2099-01-01T00:00:00Z", // every session pre-dates it
    };
    const res = await route(relayReq(f, "POST", "events", { body: [{ seq: 0, kind: "message_agent" }] }), env, f.deps);
    expect(res.status).toBe(200);
    expect(capture.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /events"]);
  });

  it("a mirror failure never fails the ingest", async () => {
    const f = await fixture();
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        ingestEvents: async () => {
          throw new Error("relay down");
        },
      }),
    } as unknown as NonNullable<Env["SESSION_RELAY"]>;
    const env: Env = { ...baseEnv, ATTACH_RELAY: ns };
    const res = await route(relayReq(f, "POST", "events", { body: [{ seq: 0, kind: "message_agent" }] }), env, f.deps);
    expect(res.status).toBe(200);
  });
});
