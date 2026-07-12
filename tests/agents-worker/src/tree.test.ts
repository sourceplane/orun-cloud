// The delegation plane (saas-agents-fleet AF4): the spawn door only ever
// NARROWS — ceiling intersection, hard depth/width caps, parent-from-actor
// (a body-supplied parent is unrepresentable) — and kill is tree-transitive,
// leaf-up, with the orphan sweep converging what a partial kill missed.

import { route } from "@agents-worker/router";
import { subtreeLeafUp } from "@agents-worker/handlers/tree";
import { sweepLapsedSessions } from "@agents-worker/sweep";
import type { AgentsDeps } from "@agents-worker/deps";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";
import type { AgentSession as WireSession } from "@saas/contracts/agents";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const SCOPE = { orgId: ORG_UUID };
const env: Env = { ENVIRONMENT: "test" };

function makeDeps(overrides?: {
  repo?: MemoryAgentsRepository;
  /** actions granted; default grants everything. */
  grants?: string[];
}): AgentsDeps {
  return {
    repo: overrides?.repo ?? new MemoryAgentsRepository(),
    async authorize(action) {
      return overrides?.grants ? overrides.grants.includes(action) : true;
    },
    async dispose() {},
  };
}

function req(method: string, path: string, body?: unknown, actorExtra: Record<string, string> = {}): Request {
  return new Request(`https://agents-worker${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-actor-subject-id": "usr_rahul",
      "x-actor-subject-type": "user",
      ...actorExtra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** A create request authenticated as a running session's own principal —
 * the runtime's agent_spawn re-entering the public API. */
function spawnReq(parentSessionId: string, body: unknown): Request {
  return req("POST", `/v1/organizations/${ORG}/agents/sessions`, body, {
    "x-actor-subject-id": "sp_agent1",
    "x-actor-subject-type": "service_principal",
    "x-actor-agent-session-id": parentSessionId,
  });
}

async function json(res: Response): Promise<{ data?: unknown; error?: { code: string; message?: string } }> {
  return (await res.json()) as { data?: unknown; error?: { code: string; message?: string } };
}

async function seedProfile(
  repo: MemoryAgentsRepository,
  name: string,
  capability?: Record<string, unknown>,
) {
  return repo.createProfile(SCOPE, {
    name,
    principalId: "sp_agent1",
    owner: "usr_elena",
    agentType: name.startsWith("orch") ? "orchestrator" : "implementer",
    harness: "claude-code",
    model: "claude-opus-4-8",
    ...(capability ? { capability } : {}),
  });
}

async function liveSession(repo: MemoryAgentsRepository, profileId: string, parentSessionId?: string) {
  const s = await repo.createSession(SCOPE, {
    profileId,
    runKind: "implementation",
    spawnedBy: "usr_rahul",
    ...(parentSessionId ? { parentSessionId } : {}),
  });
  await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "provisioning" });
  await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "running" });
  return s;
}

describe("the spawn door (AF4 §3.1)", () => {
  it("an agent-session spawn inherits the tree and intersects the ceiling", async () => {
    const repo = new MemoryAgentsRepository();
    const orch = await seedProfile(repo, "orch-01", { tools: ["bash", "git", "deploy"] });
    const coder = await seedProfile(repo, "coder-01", { tools: ["bash", "git", "web"] });
    const parent = await liveSession(repo, orch.publicId);

    const res = await route(
      spawnReq(parent.publicId, { profileId: coder.publicId, runKind: "implementation" }),
      env,
      makeDeps({ repo }),
    );
    expect(res.status).toBe(201);
    const child = (await json(res)).data as WireSession;
    expect(child.parentSessionId).toBe(parent.publicId);
    expect(child.rootSessionId).toBe(parent.publicId);
    expect(child.depth).toBe(1);

    // The applied ceiling is parent ∩ child — "web" (child-only) and
    // "deploy" (parent-only) are both gone. Narrowed, never widened.
    const row = await repo.getSession(SCOPE, child.id);
    expect(row?.sandbox.appliedCeiling).toEqual({ tools: ["bash", "git"] });
  });

  it("spawn requires the spawn grant, not create — deny-by-default", async () => {
    const repo = new MemoryAgentsRepository();
    const p = await seedProfile(repo, "coder-01");
    const parent = await liveSession(repo, p.publicId);
    const res = await route(
      spawnReq(parent.publicId, { profileId: p.publicId, runKind: "implementation" }),
      env,
      // create granted, spawn NOT — the veto that keeps recursion opt-in.
      makeDeps({ repo, grants: ["organization.agent.session.create"] }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error?.code).toBe("agent_spawn_not_allowed");
  });

  it("a human create is untouched by the gates and roots its own tree", async () => {
    const repo = new MemoryAgentsRepository();
    const p = await seedProfile(repo, "coder-01");
    const res = await route(
      req("POST", `/v1/organizations/${ORG}/agents/sessions`, {
        profileId: p.publicId,
        runKind: "design",
      }),
      env,
      makeDeps({ repo, grants: ["organization.agent.session.create"] }),
    );
    expect(res.status).toBe(201);
    const s = (await json(res)).data as WireSession;
    expect(s.parentSessionId).toBeUndefined();
    expect(s.rootSessionId).toBe(s.id);
    expect(s.depth).toBe(0);
  });

  it("refuses past the depth cap", async () => {
    const repo = new MemoryAgentsRepository();
    const p = await seedProfile(repo, "orch-01");
    const root = await liveSession(repo, p.publicId);
    const d1 = await liveSession(repo, p.publicId, root.publicId);
    const d2 = await liveSession(repo, p.publicId, d1.publicId);
    // depth 2 exists; a spawn from it would be depth 3 > cap 2.
    const res = await route(
      spawnReq(d2.publicId, { profileId: p.publicId, runKind: "implementation" }),
      env,
      makeDeps({ repo }),
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("agent_tree_depth_exceeded");
  });

  it("refuses past the per-parent width cap, and dead children free the slot", async () => {
    const repo = new MemoryAgentsRepository();
    const p = await seedProfile(repo, "orch-01");
    const parent = await liveSession(repo, p.publicId);
    for (let i = 0; i < 5; i++) await liveSession(repo, p.publicId, parent.publicId);

    const deps = makeDeps({ repo });
    const over = await route(spawnReq(parent.publicId, { profileId: p.publicId, runKind: "fix" }), env, deps);
    expect(over.status).toBe(409);
    expect((await json(over)).error?.code).toBe("agent_tree_width_exceeded");

    // A completed child no longer counts against the width cap.
    const kids = (await repo.listSessions(SCOPE)).filter((s) => s.parentSessionId === parent.publicId);
    await repo.advanceSession(SCOPE, { publicId: kids[0]!.publicId, to: "completing" });
    await repo.advanceSession(SCOPE, { publicId: kids[0]!.publicId, to: "completed" });
    const retry = await route(spawnReq(parent.publicId, { profileId: p.publicId, runKind: "fix" }), env, deps);
    expect(retry.status).toBe(201);
  });

  it("refuses a spawn from a terminal parent", async () => {
    const repo = new MemoryAgentsRepository();
    const p = await seedProfile(repo, "orch-01");
    const parent = await liveSession(repo, p.publicId);
    await repo.advanceSession(SCOPE, { publicId: parent.publicId, to: "failed" });
    const res = await route(
      spawnReq(parent.publicId, { profileId: p.publicId, runKind: "implementation" }),
      env,
      makeDeps({ repo }),
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("agent_parent_not_live");
  });
});

describe("tree-transitive kill (AF4 §3.2)", () => {
  it("orders the subtree leaf-up", async () => {
    const repo = new MemoryAgentsRepository();
    const p = await seedProfile(repo, "orch-01");
    const root = await liveSession(repo, p.publicId);
    const a = await liveSession(repo, p.publicId, root.publicId);
    const b = await liveSession(repo, p.publicId, root.publicId);
    const aa = await liveSession(repo, p.publicId, a.publicId);

    const sessions = await repo.listSessions(SCOPE);
    const rootRow = sessions.find((s) => s.publicId === root.publicId)!;
    const order = subtreeLeafUp(rootRow, sessions).map((s) => s.publicId);
    // Every child precedes its parent; the target is last.
    expect(order.indexOf(aa.publicId)).toBeLessThan(order.indexOf(a.publicId));
    expect(order.indexOf(a.publicId)).toBeLessThan(order.indexOf(root.publicId));
    expect(order.indexOf(b.publicId)).toBeLessThan(order.indexOf(root.publicId));
    expect(order[order.length - 1]).toBe(root.publicId);
  });

  it("cancels the whole subtree via the route; terminal nodes are skipped", async () => {
    const repo = new MemoryAgentsRepository();
    const p = await seedProfile(repo, "orch-01");
    const root = await liveSession(repo, p.publicId);
    const a = await liveSession(repo, p.publicId, root.publicId);
    const b = await liveSession(repo, p.publicId, root.publicId);
    await repo.advanceSession(SCOPE, { publicId: b.publicId, to: "completing" });
    await repo.advanceSession(SCOPE, { publicId: b.publicId, to: "completed" });

    const res = await route(
      req("POST", `/v1/organizations/${ORG}/agents/sessions/${root.publicId}/cancel`),
      env,
      makeDeps({ repo }),
    );
    expect(res.status).toBe(200);
    const summary = (await json(res)).data as { canceled: number; skipped: number; subtree: number };
    expect(summary.subtree).toBe(3);
    expect(summary.canceled).toBe(2); // root + a; b was already terminal
    expect(summary.skipped).toBe(1);

    expect((await repo.getSession(SCOPE, root.publicId))?.state).toBe("canceled");
    expect((await repo.getSession(SCOPE, a.publicId))?.state).toBe("canceled");
    expect((await repo.getSession(SCOPE, b.publicId))?.state).toBe("completed");
  });

  it("kill is interact-gated — watching a tree is not stopping it", async () => {
    const repo = new MemoryAgentsRepository();
    const p = await seedProfile(repo, "coder-01");
    const s = await liveSession(repo, p.publicId);
    const res = await route(
      req("POST", `/v1/organizations/${ORG}/agents/sessions/${s.publicId}/cancel`),
      env,
      makeDeps({ repo, grants: ["organization.agent.session.read"] }),
    );
    expect(res.status).toBe(403);
  });
});

describe("the orphan sweep (AF4 §3.2)", () => {
  it("converges a live child of a terminal parent past grace; a fresh terminal parent waits", async () => {
    // Pin the clock so grace math is deterministic (memory default is 1970).
    const CLOCK = "2026-07-12T09:00:00.000Z";
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo, "orch-01");
    const root = await liveSession(repo, p.publicId);
    const child = await liveSession(repo, p.publicId, root.publicId);
    await repo.advanceSession(SCOPE, { publicId: root.publicId, to: "failed" }); // endedAt = CLOCK

    const deps = makeDeps({ repo });
    // Within grace (parent ended 1 min ago): the child survives the tick.
    const early = await sweepLapsedSessions(deps, "req_t", () => new Date("2026-07-12T09:01:00.000Z"));
    expect(early.orphaned).toBe(0);
    expect((await repo.getSession(SCOPE, child.publicId))?.state).toBe("running");

    // Past grace: the orphan is failed with the fact recorded.
    const late = await sweepLapsedSessions(deps, "req_t", () => new Date("2026-07-12T09:10:00.000Z"));
    expect(late.orphaned).toBe(1);
    const row = await repo.getSession(SCOPE, child.publicId);
    expect(row?.state).toBe("failed");
    expect(row?.sandbox.error).toBe("orphaned");
  });
});
