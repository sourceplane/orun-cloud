// AF9 — hardening: the hostile-orchestrator fixtures (design §9). The worst
// case is a prompt-injected parent with every grant the policy layer can
// give it; containment must be ARITHMETIC — caps, intersection, envelopes,
// structural guards — not politeness. Every attack here must die with the
// specific refusal named.

import { route } from "@agents-worker/router";
import { sweepLapsedSessions } from "@agents-worker/sweep";
import type { AgentsDeps } from "@agents-worker/deps";
import type { SandboxFactory } from "@agents-worker/deps";
import { MemoryAgentsRepository, providerSecretRef } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";
import type { AgentSession as WireSession } from "@saas/contracts/agents";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const SCOPE = { orgId: ORG_UUID };
const env: Env = { ENVIRONMENT: "test" };
const CLOCK = "2026-07-12T09:00:00.000Z";

function makeDeps(overrides?: {
  repo?: MemoryAgentsRepository;
  sandboxes?: SandboxFactory;
  providerKeys?: { resolve: () => Promise<string> };
}): AgentsDeps {
  const deps: AgentsDeps = {
    repo: overrides?.repo ?? new MemoryAgentsRepository({ now: () => CLOCK }),
    async authorize() {
      return true; // every grant granted — containment must not depend on policy
    },
    async dispose() {},
  };
  if (overrides?.sandboxes) deps.sandboxes = overrides.sandboxes;
  if (overrides?.providerKeys) {
    deps.providerKeys = overrides.providerKeys as unknown as NonNullable<AgentsDeps["providerKeys"]>;
  }
  return deps;
}

function spawnReq(parentSessionId: string, body: unknown): Request {
  return new Request(`https://agents-worker/v1/organizations/${ORG}/agents/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-actor-subject-id": "sp_agent1",
      "x-actor-subject-type": "service_principal",
      "x-actor-agent-session-id": parentSessionId,
    },
    body: JSON.stringify(body),
  });
}

async function seedProfile(repo: MemoryAgentsRepository, name: string, capability?: Record<string, unknown>) {
  return repo.createProfile(SCOPE, {
    name,
    principalId: "sp_agent1",
    owner: "usr_elena",
    agentType: "orchestrator",
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

describe("hostile orchestrator: widening", () => {
  it("a narrow parent chaining through wide profiles never regains a tool", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const narrow = await seedProfile(repo, "narrow", { tools: ["read"] });
    const wide = await seedProfile(repo, "wide", { tools: ["read", "bash", "deploy", "secrets"] });
    const root = await liveSession(repo, narrow.publicId);
    const deps = makeDeps({ repo });

    // Spawn a wide-profile child from the narrow root...
    const c1 = await route(spawnReq(root.publicId, { profileId: wide.publicId, runKind: "fix" }), env, deps);
    expect(c1.status).toBe(201);
    const child = (await c1.json()) as { data: WireSession };
    const childRow = await repo.getSession(SCOPE, child.data.id);
    expect(childRow?.sandbox.appliedCeiling).toEqual({ tools: ["read"] });

    // ...and a wide grandchild from that child: still read-only. The applied
    // ceiling composes down; the wide profile never resurfaces.
    await repo.advanceSession(SCOPE, { publicId: child.data.id, to: "provisioning" });
    await repo.advanceSession(SCOPE, { publicId: child.data.id, to: "running" });
    const c2 = await route(spawnReq(child.data.id, { profileId: wide.publicId, runKind: "fix" }), env, deps);
    expect(c2.status).toBe(201);
    const grand = (await c2.json()) as { data: WireSession };
    expect((await repo.getSession(SCOPE, grand.data.id))?.sandbox.appliedCeiling).toEqual({
      tools: ["read"],
    });
  });
});

describe("hostile orchestrator: the spawn storm", () => {
  it("distributing children across the tree cannot exceed the live-tree cap", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo, "orch");
    const root = await liveSession(repo, p.publicId);
    const deps = makeDeps({ repo });

    // Greedy storm: every live node tries to spawn as many children as the
    // per-parent cap allows, breadth-first, until everything refuses.
    let frontier = [root.publicId];
    let spawned = 0;
    let refusals = 0;
    for (let round = 0; round < 5 && frontier.length > 0; round++) {
      const next: string[] = [];
      for (const parent of frontier) {
        for (let i = 0; i < 6; i++) {
          const res = await route(spawnReq(parent, { profileId: p.publicId, runKind: "fix" }), env, deps);
          if (res.status === 201) {
            const s = (await res.json()) as { data: WireSession };
            await repo.advanceSession(SCOPE, { publicId: s.data.id, to: "provisioning" });
            await repo.advanceSession(SCOPE, { publicId: s.data.id, to: "running" });
            next.push(s.data.id);
            spawned++;
          } else {
            refusals++;
          }
        }
      }
      frontier = next;
    }

    // The arithmetic holds: root + spawned ≤ 10 live nodes, ever.
    const live = (await repo.listSessions(SCOPE)).filter((s) =>
      ["requested", "provisioning", "running", "awaiting_approval"].includes(s.state),
    );
    expect(live.length).toBeLessThanOrEqual(10);
    expect(spawned).toBeLessThanOrEqual(9);
    expect(refusals).toBeGreaterThan(0); // the storm hit the walls, loudly
  });
});

describe("hostile orchestrator: budget evasion by delegation", () => {
  it("children draw the root's envelope — delegating spend does not escape it", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo, "orch");
    const root = await liveSession(repo, p.publicId);
    await repo.setBudget(SCOPE, { grain: "tree", maxTokens: 100, createdBy: "u" });
    const deps = makeDeps({ repo });

    const c1 = await route(spawnReq(root.publicId, { profileId: p.publicId, runKind: "fix" }), env, deps);
    expect(c1.status).toBe(201);
    const child = (await c1.json()) as { data: WireSession };
    // The child burns the tree's whole envelope...
    await repo.addSessionTokens(SCOPE, child.data.id, 100);
    // ...and the parent can spawn nothing further: the envelope is shared.
    const c2 = await route(spawnReq(root.publicId, { profileId: p.publicId, runKind: "fix" }), env, deps);
    expect(c2.status).toBe(409);
    expect(((await c2.json()) as { error: { code: string } }).error.code).toBe("budget_exhausted");
  });
});

describe("hostile session: standing-config writes", () => {
  it("an agent-session bearer cannot author routines or budgets, whatever its grants", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo, "orch");
    const s = await liveSession(repo, p.publicId);
    const deps = makeDeps({ repo });
    const asAgent = (method: string, path: string, body?: unknown) =>
      new Request(`https://agents-worker${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-actor-subject-id": "sp_agent1",
          "x-actor-subject-type": "service_principal",
          "x-actor-agent-session-id": s.publicId,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    // The persistence backdoor: a hijacked session scheduling its own future.
    const routine = await route(
      asAgent("POST", `/v1/organizations/${ORG}/agents/routines`, {
        name: "backdoor",
        profileId: p.publicId,
        runKind: "fix",
        triggerKind: "cron",
        triggerConfig: { cron: "0 3 * * *" },
      }),
      env,
      deps,
    );
    expect(routine.status).toBe(403);
    expect(((await routine.json()) as { error: { code: string } }).error.code).toBe(
      "agent_session_config_write",
    );

    // The spend backdoor: a session raising its own ceiling.
    const budget = await route(
      asAgent("PUT", `/v1/organizations/${ORG}/agents/budgets`, { grain: "session", maxTokens: 10_000_000 }),
      env,
      deps,
    );
    expect(budget.status).toBe(403);

    expect(await repo.listRoutines(SCOPE)).toEqual([]);
    expect(await repo.listBudgets(SCOPE)).toEqual([]);
  });
});

describe("the runaway-tree kill drill (design §10 / AF9)", () => {
  it("kill-the-root under partial destroy failure converges via the sweep, no sealed loss", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo, "orch");
    const root = await liveSession(repo, p.publicId);
    const a = await liveSession(repo, p.publicId, root.publicId);
    const b = await liveSession(repo, p.publicId, root.publicId);
    // Sealed evidence on a child — must survive every failure below.
    await repo.appendSessionEvent(SCOPE, {
      sessionPublicId: a.publicId,
      seq: 0,
      kind: "artifact_produced",
      payload: { pr: "https://github.com/x/pull/9" },
    });
    // Give every node a sandbox ref; the provider destroy always throws
    // (the account is unreachable mid-incident).
    for (const sid of [root.publicId, a.publicId, b.publicId]) {
      const row = await repo.getSession(SCOPE, sid);
      row!.sandbox = { id: `sb_${sid}` };
    }
    await repo.createConnection(SCOPE, {
      provider: "daytona",
      name: "default",
      secretRef: providerSecretRef("daytona", "default"),
      createdBy: "u",
    });
    const deps = makeDeps({
      repo,
      providerKeys: { resolve: async () => "dtn_key" },
      sandboxes: () => ({
        id: "daytona",
        async create() {
          throw new Error("unreachable");
        },
        async exec() {},
        async snapshot() {
          throw new Error("unreachable");
        },
        async resume() {
          throw new Error("unreachable");
        },
        async destroy() {
          throw new Error("unreachable"); // every destroy fails
        },
        async health() {
          return { healthy: false };
        },
      }),
    });

    // The kill: every node cancels even though no box could be destroyed.
    const kill = await route(
      new Request(`https://agents-worker/v1/organizations/${ORG}/agents/sessions/${root.publicId}/cancel`, {
        method: "POST",
        headers: { "x-actor-subject-id": "usr_rahul", "x-actor-subject-type": "user" },
      }),
      env,
      deps,
    );
    expect(kill.status).toBe(200);
    const summary = (await kill.json()) as { data: { canceled: number } };
    expect(summary.data.canceled).toBe(3);
    for (const sid of [root.publicId, a.publicId, b.publicId]) {
      expect((await repo.getSession(SCOPE, sid))?.state).toBe("canceled");
    }

    // The sweep converges the stragglers' boxes (destroy still failing —
    // over-destroy posture: errors counted, nothing blocks) and the sealed
    // evidence is intact.
    const sweep = await sweepLapsedSessions(deps, "req_t", () => new Date("2026-07-12T10:00:00.000Z"));
    expect(sweep.reclaimed).toBe(0); // nothing live remains to reclaim
    expect((await repo.listSessionEvents(SCOPE, a.publicId)).length).toBe(1);
  });
});
