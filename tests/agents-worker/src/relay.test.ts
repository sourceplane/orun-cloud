// Body-facing relay route tests (#466, updated for the AN lock-7 cutover): the
// in-sandbox runtime's live wire — POST /stream (delta fan-out), GET /inputs
// (steer return-queue poll), POST /inputs/ack. The pinned invariants: (1) the
// SAME three-way session gate as heartbeat/events (a leaked session id must not
// open the input queue), and (2) the route reaches the per-session SDK relay DO
// via typed RPC when the gate passes. The old KV `SessionRelay` class and its
// HTTP forward are decommissioned — every session is on `AttachRelay`.

import { route } from "@agents-worker/router";
import type { AgentsDeps } from "@agents-worker/deps";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const baseEnv: Env = { ENVIRONMENT: "test" };

interface RpcCall {
  method: string;
  arg: unknown;
}

/** A minimal `AttachRelay` DO namespace double speaking typed RPC: records each
 * method call and returns a canned poll body. */
function mockRpcNs(
  calls: RpcCall[],
  pollBody: { items: unknown[]; cursor: number } = { items: [], cursor: 0 },
): NonNullable<Env["ATTACH_RELAY"]> {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      async streamDelta(frame: unknown) {
        calls.push({ method: "streamDelta", arg: frame });
      },
      async pollInputs(cursor: number) {
        calls.push({ method: "pollInputs", arg: cursor });
        return pollBody;
      },
      async ackInput(ack: unknown) {
        calls.push({ method: "ackInput", arg: ack });
      },
      async headInput(frame: unknown, principal: string) {
        calls.push({ method: "headInput", arg: { frame, principal } });
        return { ok: true };
      },
      async ingestEvents(frames: unknown[]) {
        calls.push({ method: "ingestEvents", arg: frames });
        return frames.length;
      },
      async armLease() {
        /* no-op */
      },
    }),
  } as unknown as NonNullable<Env["ATTACH_RELAY"]>;
}

interface Captured {
  url: string;
  method: string;
}

/** A fetch-style `AttachRelay` double for the upgrade/SSE paths (attach forwards
 * a live Request through `stub.fetch`, not RPC). */
function mockFetchNs(capture: Captured[], body: unknown = { ok: true }): NonNullable<Env["ATTACH_RELAY"]> {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (req: Request) => {
        capture.push({ url: new URL(req.url).pathname + new URL(req.url).search, method: req.method });
        return Response.json(body);
      },
    }),
  } as unknown as NonNullable<Env["ATTACH_RELAY"]>;
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
    const env = { ...baseEnv, ATTACH_RELAY: mockRpcNs([]) };
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
      expect(res.status).toBe(503); // reached the peer resolve — route is wired + gated
    }
  });

  it("polls the steer queue on the SDK class via pollInputs(cursor)", async () => {
    const f = await fixture();
    const calls: RpcCall[] = [];
    const env = { ...baseEnv, ATTACH_RELAY: mockRpcNs(calls, { items: [{ t: "input" }], cursor: 7 }) };
    const res = await route(
      new Request(`https://agents-worker/v1/organizations/${ORG}/agents/sessions/${f.sessionId}/inputs?cursor=4`, {
        method: "GET",
        headers: {
          "x-actor-subject-id": "sp_1",
          "x-actor-subject-type": "service_principal",
          "x-actor-agent-session-id": f.sessionId,
        },
      }),
      env,
      f.deps,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "pollInputs", arg: 4 }]);
    expect(((await res.json()) as { cursor: number }).cursor).toBe(7);
  });

  it("streams a delta via streamDelta() and acks via ackInput()", async () => {
    const f = await fixture();
    const calls: RpcCall[] = [];
    const env = { ...baseEnv, ATTACH_RELAY: mockRpcNs(calls) };
    await route(relayReq(f, "POST", "stream", { body: { t: "delta", text: "x" } }), env, f.deps);
    await route(relayReq(f, "POST", "inputs/ack", { body: { t: "ack", ref: "c-1", ok: true } }), env, f.deps);
    expect(calls.map((c) => c.method)).toEqual(["streamDelta", "ackInput"]);
    expect(calls[0]!.arg).toEqual({ t: "delta", text: "x" });
    expect(calls[1]!.arg).toEqual({ t: "ack", ref: "c-1", ok: true });
  });

  it("405s the wrong method on each relay route", async () => {
    const f = await fixture();
    const env = { ...baseEnv, ATTACH_RELAY: mockRpcNs([]) };
    expect((await route(relayReq(f, "GET", "stream"), env, f.deps)).status).toBe(405);
    expect((await route(relayReq(f, "POST", "inputs"), env, f.deps)).status).toBe(405);
    expect((await route(relayReq(f, "GET", "inputs/ack"), env, f.deps)).status).toBe(405);
  });
});

// ── AN1/lock 7: the relay namespace resolves to the SDK class ───────────────

import { relayNamespace } from "@agents-worker/relay-epoch";

describe("relay namespace resolution (SDK-only after the lock-7 cutover)", () => {
  const newNs = mockFetchNs([]);

  it("resolves to the ATTACH_RELAY SDK class when bound", () => {
    expect(relayNamespace({ ...baseEnv, ATTACH_RELAY: newNs })).toBe(newNs);
  });

  it("is null (dormant) when unbound — no legacy class to fall back to", () => {
    expect(relayNamespace({ ...baseEnv })).toBeNull();
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
    const env: Env = { ...baseEnv, ATTACH_RELAY: mockFetchNs(capture) };
    const res = await route(headReq(f, { upgrade: true }), env, f.deps);
    expect(res.status).toBe(200);
    expect(capture).toHaveLength(1);
    expect(capture[0]!.url).toBe("/attach?from=-1&surface=console&principal=usr_alice");
  });

  it("serves a plain GET its SSE feed from the SDK class", async () => {
    const f = await fixture();
    const capture: Captured[] = [];
    const env: Env = { ...baseEnv, ATTACH_RELAY: mockFetchNs(capture) };
    const res = await route(headReq(f), env, f.deps);
    expect(res.status).toBe(200);
    expect(capture).toHaveLength(1);
    expect(capture[0]!.url).toBe("/attach?from=-1&surface=console&principal=usr_alice");
  });

  it("503s the attach when the relay is unbound (dormant posture)", async () => {
    const f = await fixture();
    const res = await route(headReq(f, { upgrade: true }), baseEnv, f.deps);
    expect(res.status).toBe(503);
  });

  it("404s an attach to a session that does not exist (no phantom DO)", async () => {
    const f = await fixture();
    const env: Env = { ...baseEnv, ATTACH_RELAY: mockFetchNs([]) };
    const res = await route(headReq(f, { sessionId: "as_missing" }), env, f.deps);
    expect(res.status).toBe(404);
  });
});

describe("AN1/AN3: the ingest mirror (typed RPC on the SDK class)", () => {
  it("mirrors an accepted event batch to the relay DO via ingestEvents()", async () => {
    const f = await fixture();
    const calls: RpcCall[] = [];
    const env: Env = { ...baseEnv, ATTACH_RELAY: mockRpcNs(calls) };

    const res = await route(
      relayReq(f, "POST", "events", {
        body: [{ seq: 0, kind: "message_agent", payload: { text: "hi" }, at: "2026-07-17T00:00:00Z" }],
      }),
      env,
      f.deps,
    );
    expect(res.status).toBe(200);
    const ingest = calls.filter((c) => c.method === "ingestEvents");
    expect(ingest).toHaveLength(1);
    expect(ingest[0]!.arg).toEqual([
      { v: 1, t: "event", seq: 0, kind: "message_agent", at: "2026-07-17T00:00:00Z", payload: { text: "hi" } },
    ]);
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
    } as unknown as NonNullable<Env["ATTACH_RELAY"]>;
    const env: Env = { ...baseEnv, ATTACH_RELAY: ns };
    const res = await route(relayReq(f, "POST", "events", { body: [{ seq: 0, kind: "message_agent" }] }), env, f.deps);
    expect(res.status).toBe(200);
  });
});
