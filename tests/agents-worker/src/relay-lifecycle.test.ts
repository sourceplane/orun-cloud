// AN3 (saas-agents-native): lifecycle in the object. The relay DO's timers
// are thin; the DECISION — did this lease really lapse, and what happens then
// — lives in relay-lifecycle.ts and is pinned here: the DO reports, the
// control plane (the shared sweep reclaim + the transition table) decides.

import { reportLeaseLapse, RELAY_LEASE_GRACE_MS } from "@agents-worker/relay-lifecycle";
import { route } from "@agents-worker/router";
import type { AgentsDeps } from "@agents-worker/deps";
import type { Env } from "@agents-worker/env";
import { MemoryAgentsRepository } from "@saas/db/agents";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const SCOPE = { orgId: ORG_UUID };

async function seedSession(repo: MemoryAgentsRepository, lease: string) {
  const profile = await repo.createProfile(SCOPE, {
    name: "impl",
    principalId: "sp_1",
    owner: "team/platform",
    agentType: "implementer",
    harness: "claude-code",
    model: "claude-opus-4-8",
  });
  const session = await repo.createSession(SCOPE, {
    profileId: profile.publicId,
    runKind: "implementation",
    spawnedBy: "usr_rahul",
  });
  await repo.advanceSession(SCOPE, { publicId: session.publicId, to: "provisioning" });
  await repo.advanceSession(SCOPE, { publicId: session.publicId, to: "running", leaseExpiresAt: lease });
  return session;
}

function makeDeps(repo: MemoryAgentsRepository): AgentsDeps {
  return {
    repo,
    async authorize() {
      return true;
    },
    async dispose() {
      /* no-op */
    },
  };
}

describe("AN3: reportLeaseLapse — the timer's decision", () => {
  const NOW = new Date("2026-07-17T12:00:00Z");

  it("reclaims a genuinely lapsed session through the shared sweep path", async () => {
    const repo = new MemoryAgentsRepository();
    const s = await seedSession(repo, new Date(NOW.getTime() - RELAY_LEASE_GRACE_MS - 1000).toISOString());
    const r = await reportLeaseLapse(makeDeps(repo), ORG_UUID, s.publicId, "req_t1", () => NOW);
    expect(r.outcome).toBe("reclaimed");
    const after = await repo.getSession(SCOPE, s.publicId);
    expect(after?.state).toBe("failed");
    expect(after?.sandbox.error).toBe("lease_lost");
  });

  it("re-arms when the lease is still live (a heartbeat landed elsewhere)", async () => {
    const repo = new MemoryAgentsRepository();
    const lease = new Date(NOW.getTime() + 10 * 60 * 1000).toISOString();
    const s = await seedSession(repo, lease);
    const r = await reportLeaseLapse(makeDeps(repo), ORG_UUID, s.publicId, "req_t2", () => NOW);
    expect(r.outcome).toBe("active");
    if (r.outcome === "active") {
      expect(new Date(r.rearmAt).getTime()).toBe(new Date(lease).getTime() + RELAY_LEASE_GRACE_MS);
    }
    expect((await repo.getSession(SCOPE, s.publicId))?.state).toBe("running");
  });

  it("leaves a terminal session alone (raced with its own completion)", async () => {
    const repo = new MemoryAgentsRepository();
    const s = await seedSession(repo, new Date(NOW.getTime() - RELAY_LEASE_GRACE_MS - 1000).toISOString());
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "completing" });
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "completed" });
    const r = await reportLeaseLapse(makeDeps(repo), ORG_UUID, s.publicId, "req_t3", () => NOW);
    expect(r.outcome).toBe("terminal");
    expect((await repo.getSession(SCOPE, s.publicId))?.state).toBe("completed");
  });

  it("reports gone for an unknown session (control plane wins)", async () => {
    const repo = new MemoryAgentsRepository();
    const r = await reportLeaseLapse(makeDeps(repo), ORG_UUID, "as_missing", "req_t4");
    expect(r.outcome).toBe("gone");
  });
});

describe("AN3: the heartbeat arms the object's lease timer", () => {
  it("re-arms via typed RPC on every heartbeat (SDK-class sessions)", async () => {
    const repo = new MemoryAgentsRepository();
    const s = await seedSession(repo, "2099-01-01T00:00:00Z");
    const armed: { orgId: string; lease: string }[] = [];
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        armLease: async (orgId: string, lease: string) => {
          armed.push({ orgId, lease });
        },
      }),
    } as unknown as Env["ATTACH_RELAY"];
    const env = { ENVIRONMENT: "test", ATTACH_RELAY: ns } as Env;
    const res = await route(
      new Request(`https://agents-worker/v1/organizations/${ORG}/agents/sessions/${s.publicId}/heartbeat`, {
        method: "POST",
        headers: {
          "x-actor-subject-id": "sp_1",
          "x-actor-subject-type": "service_principal",
          "x-actor-agent-session-id": s.publicId,
        },
      }),
      env,
      makeDeps(repo),
    );
    expect(res.status).toBe(200);
    expect(armed).toHaveLength(1);
    expect(armed[0]!.orgId).toBe(ORG_UUID);
    expect(new Date(armed[0]!.lease).getTime()).toBeGreaterThan(Date.now());
  });

  it("an arming failure never fails the heartbeat (the backstop owns it)", async () => {
    const repo = new MemoryAgentsRepository();
    const s = await seedSession(repo, "2099-01-01T00:00:00Z");
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        armLease: async () => {
          throw new Error("DO unreachable");
        },
      }),
    } as unknown as Env["ATTACH_RELAY"];
    const env = { ENVIRONMENT: "test", ATTACH_RELAY: ns } as Env;
    const res = await route(
      new Request(`https://agents-worker/v1/organizations/${ORG}/agents/sessions/${s.publicId}/heartbeat`, {
        method: "POST",
        headers: {
          "x-actor-subject-id": "sp_1",
          "x-actor-subject-type": "service_principal",
          "x-actor-agent-session-id": s.publicId,
        },
      }),
      env,
      makeDeps(repo),
    );
    expect(res.status).toBe(200);
  });
});

describe("AN3: body routes ride typed RPC on the SDK class", () => {
  it("poll/ack/stream/input call methods, not URLs", async () => {
    const repo = new MemoryAgentsRepository();
    const s = await seedSession(repo, "2099-01-01T00:00:00Z");
    const calls: string[] = [];
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        pollInputs: async (cursor: number) => {
          calls.push(`pollInputs(${cursor})`);
          return { items: [], cursor: 7 };
        },
        ackInput: async () => {
          calls.push("ackInput");
        },
        streamDelta: async () => {
          calls.push("streamDelta");
        },
        headInput: async (_f: unknown, principal: string) => {
          calls.push(`headInput(${principal})`);
          return { v: 1, t: "ack", ref: "c-1", ok: true };
        },
      }),
    } as unknown as Env["ATTACH_RELAY"];
    const env = { ENVIRONMENT: "test", ATTACH_RELAY: ns } as Env;
    const deps = makeDeps(repo);
    const hdrs = {
      "content-type": "application/json",
      "x-actor-subject-id": "sp_1",
      "x-actor-subject-type": "service_principal",
      "x-actor-agent-session-id": s.publicId,
    };
    const base = `https://agents-worker/v1/organizations/${ORG}/agents/sessions/${s.publicId}`;

    const poll = await route(new Request(`${base}/inputs?cursor=4`, { method: "GET", headers: hdrs }), env, deps);
    expect(((await poll.json()) as { cursor: number }).cursor).toBe(7);

    await route(new Request(`${base}/inputs/ack`, { method: "POST", headers: hdrs, body: JSON.stringify({ v: 1, t: "ack", ref: "c-1", ok: true }) }), env, deps);
    await route(new Request(`${base}/stream`, { method: "POST", headers: hdrs, body: JSON.stringify({ v: 1, t: "delta", text: "x" }) }), env, deps);

    const input = await route(
      new Request(`${base}/input`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-actor-subject-id": "usr_alice", "x-actor-subject-type": "user" },
        body: JSON.stringify({ v: 1, t: "steer", ref: "c-1", text: "hello" }),
      }),
      env,
      deps,
    );
    expect(((await input.json()) as { ok: boolean }).ok).toBe(true);
    expect(calls).toEqual(["pollInputs(4)", "ackInput", "streamDelta", "headInput(usr_alice)"]);
  });
});
