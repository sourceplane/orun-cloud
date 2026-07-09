// Lease-sweep tests (saas-agents AG6, design §4.3). Pinned: lapsed leases and
// stalled provisioning reclaim to failed(lease_lost); the sandbox destroy is
// best-effort (a provider error or missing connection never blocks the
// reclaim); healthy sessions are untouched.

import { sweepLapsedSessions } from "@agents-worker/sweep";
import type { AgentsDeps } from "@agents-worker/deps";
import type { ProviderKeyClient } from "@agents-worker/config-client";
import type { SandboxProvider } from "@saas/contracts/agents";
import { MemoryAgentsRepository, providerSecretRef } from "@saas/db/agents";

const ORG = "org_test";
const NOW = new Date("2026-07-09T12:00:00Z");

function stubProvider(destroyed: string[], failDestroy = false): SandboxProvider {
  return {
    id: "daytona",
    async create() {
      throw new Error("unused");
    },
    async exec() {
      /* unused */
    },
    async snapshot() {
      return "s";
    },
    async resume() {
      throw new Error("unused");
    },
    async destroy(ref) {
      if (failDestroy) throw new Error("410 from provider");
      destroyed.push(ref.id);
    },
    async health() {
      return { healthy: true };
    },
  };
}

const keys: ProviderKeyClient = {
  async store() {
    return true;
  },
  async resolve() {
    return "dtn_key";
  },
};

interface Fixture {
  deps: AgentsDeps;
  repo: MemoryAgentsRepository;
  destroyed: string[];
  make(opts: {
    state: "provisioning" | "running";
    lease?: string;
    sandboxId?: string;
    createdAt?: never; // memory clock is monotonic; use iso() injection below
  }): Promise<string>;
}

function fixture(opts?: { connection?: boolean; failDestroy?: boolean }): Fixture {
  // A real-looking clock so cutoff comparisons are meaningful.
  let tick = 0;
  const repo = new MemoryAgentsRepository({
    now: () => new Date(Date.parse("2026-07-09T10:00:00Z") + tick++ * 1000).toISOString(),
  });
  const destroyed: string[] = [];
  const scope = { orgId: ORG };

  const deps: AgentsDeps = {
    repo,
    async authorize() {
      return true;
    },
    providerKeys: keys,
    sandboxes: (provider) => (provider === "daytona" ? stubProvider(destroyed, opts?.failDestroy) : null),
    async dispose() {
      /* no-op */
    },
  };

  let seeded = false;
  async function seed(): Promise<void> {
    if (seeded) return;
    seeded = true;
    await repo.createProfile(scope, {
      name: "impl",
      principalId: "sp_1",
      owner: "team/platform",
      agentType: "implementer",
      harness: "claude-code",
      model: "claude-opus-4-8",
    });
    if (opts?.connection !== false) {
      await repo.createConnection(scope, {
        provider: "daytona",
        name: "default",
        config: {},
        secretRef: providerSecretRef("daytona", "default"),
        createdBy: "usr_1",
      });
    }
  }

  return {
    deps,
    repo,
    destroyed,
    async make(m) {
      await seed();
      const profile = (await repo.listProfiles(scope))[0]!;
      const s = await repo.createSession(scope, {
        profileId: profile.publicId,
        runKind: "implementation",
        spawnedBy: "usr_1",
      });
      await repo.advanceSession(scope, {
        publicId: s.publicId,
        to: "provisioning",
        ...(m.sandboxId ? { sandbox: { provider: "daytona", id: m.sandboxId } } : {}),
      });
      if (m.state === "running") {
        await repo.advanceSession(scope, {
          publicId: s.publicId,
          to: "running",
          ...(m.lease ? { leaseExpiresAt: m.lease } : {}),
        });
      }
      return s.publicId;
    },
  };
}

describe("lease sweep (AG6 §4.3)", () => {
  it("reclaims a lapsed running session: destroy + failed(lease_lost)", async () => {
    const f = fixture();
    const id = await f.make({ state: "running", lease: "2026-07-09T11:00:00Z", sandboxId: "sb_lapsed" });
    const summary = await sweepLapsedSessions(f.deps, "req_t", () => NOW);

    expect(summary).toEqual({ examined: 1, reclaimed: 1, destroyed: 1, destroyErrors: 0 });
    expect(f.destroyed).toEqual(["sb_lapsed"]);
    const s = await f.repo.getSession({ orgId: ORG }, id);
    expect(s?.state).toBe("failed");
    expect(s?.sandbox.error).toBe("lease_lost");
    expect(s?.sandbox.id).toBe("sb_lapsed"); // the ref survives for audit
  });

  it("reclaims a stalled provisioning session (never earned a lease)", async () => {
    const f = fixture();
    const id = await f.make({ state: "provisioning", sandboxId: "sb_stalled" });
    const summary = await sweepLapsedSessions(f.deps, "req_t", () => NOW);
    expect(summary.reclaimed).toBe(1);
    expect(f.destroyed).toEqual(["sb_stalled"]);
    expect((await f.repo.getSession({ orgId: ORG }, id))?.state).toBe("failed");
  });

  it("leaves healthy sessions alone", async () => {
    const f = fixture();
    const live = await f.make({ state: "running", lease: "2026-07-09T13:00:00Z", sandboxId: "sb_live" });
    const summary = await sweepLapsedSessions(f.deps, "req_t", () => NOW);
    expect(summary.examined).toBe(0);
    expect(f.destroyed).toEqual([]);
    expect((await f.repo.getSession({ orgId: ORG }, live))?.state).toBe("running");
  });

  it("respects the grace window — a just-lapsed lease is not yet reclaimed", async () => {
    const f = fixture();
    // Lapsed 2 minutes ago: inside the 5-minute grace.
    await f.make({ state: "running", lease: "2026-07-09T11:58:00Z", sandboxId: "sb_grace" });
    const summary = await sweepLapsedSessions(f.deps, "req_t", () => NOW);
    expect(summary.examined).toBe(0);
  });

  it("reclaims even when the destroy fails (over-destroy posture)", async () => {
    const f = fixture({ failDestroy: true });
    const id = await f.make({ state: "running", lease: "2026-07-09T11:00:00Z", sandboxId: "sb_gone" });
    const summary = await sweepLapsedSessions(f.deps, "req_t", () => NOW);
    expect(summary).toEqual({ examined: 1, reclaimed: 1, destroyed: 0, destroyErrors: 1 });
    expect((await f.repo.getSession({ orgId: ORG }, id))?.state).toBe("failed");
  });

  it("reclaims even when the workspace has no daytona connection anymore", async () => {
    const f = fixture({ connection: false });
    const id = await f.make({ state: "running", lease: "2026-07-09T11:00:00Z", sandboxId: "sb_orphan" });
    const summary = await sweepLapsedSessions(f.deps, "req_t", () => NOW);
    expect(summary.reclaimed).toBe(1);
    expect(summary.destroyed).toBe(0);
    expect((await f.repo.getSession({ orgId: ORG }, id))?.state).toBe("failed");
  });
});
