import {
  MemoryAgentsRepository,
  canTransition,
  isProvider,
  isSessionEventKind,
  isTerminal,
  providerSecretRef,
  validateConnectionInput,
  validateProfileInput,
  AgentsError,
  type WorkspaceScope,
} from "@saas/db/agents";

const scope: WorkspaceScope = { orgId: "org_1" };

function repo() {
  return new MemoryAgentsRepository();
}

async function seedProfile(r: MemoryAgentsRepository) {
  return r.createProfile(scope, {
    name: "impl-default",
    principalId: "sp_agent1",
    owner: "team/platform",
    agentType: "implementer",
    harness: "claude-code",
    model: "claude-opus-4-8",
  });
}

describe("agents model", () => {
  it("enforces a mandatory responsible owner on a profile", () => {
    expect(() =>
      validateProfileInput({ name: "x", principalId: "sp_1", owner: "", agentType: "t" }),
    ).toThrow(AgentsError);
  });

  it("session-event vocabulary is closed — no status/lifecycle kind", () => {
    expect(isSessionEventKind("artifact_produced")).toBe(true);
    expect(isSessionEventKind("status_asserted")).toBe(false);
    expect(isSessionEventKind("lifecycle_set")).toBe(false);
  });

  it("guards control-plane transitions and marks terminals", () => {
    expect(canTransition("requested", "provisioning")).toBe(true);
    expect(canTransition("running", "completing")).toBe(true);
    expect(canTransition("completed", "running")).toBe(false); // terminal has no edges
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });
});

describe("MemoryAgentsRepository", () => {
  it("creates + lists profiles, rejecting a duplicate name", async () => {
    const r = repo();
    const p = await seedProfile(r);
    expect(p.publicId).toMatch(/^agp_/);
    expect(p.autonomyDefault).toBe("assist");
    await expect(seedProfile(r)).rejects.toThrow(/exists/);
    expect((await r.listProfiles(scope)).length).toBe(1);
  });

  it("runs a session through its infrastructure lifecycle", async () => {
    const r = repo();
    const p = await seedProfile(r);
    const s = await r.createSession(scope, {
      profileId: p.publicId,
      runKind: "implementation",
      spawnedBy: "usr_rahul",
      taskKey: "ORN-142",
    });
    expect(s.publicId).toMatch(/^as_/);
    expect(s.state).toBe("requested");

    await r.advanceSession(scope, { publicId: s.publicId, to: "provisioning" });
    const running = await r.advanceSession(scope, { publicId: s.publicId, to: "running" });
    expect(running.startedAt).toBeDefined();

    // An illegal jump is refused.
    await expect(
      r.advanceSession(scope, { publicId: s.publicId, to: "requested" }),
    ).rejects.toThrow(/not allowed/);

    await r.advanceSession(scope, { publicId: s.publicId, to: "completing" });
    const done = await r.advanceSession(scope, {
      publicId: s.publicId,
      to: "completed",
      prUrl: "https://github.com/x/y/pull/1",
      snapshotId: "sha256:abc",
    });
    expect(done.state).toBe("completed");
    expect(done.endedAt).toBeDefined();
    expect(done.prUrl).toContain("pull/1");
    expect(done.snapshotId).toBe("sha256:abc");
  });

  it("relays session events with dedupe on (session, seq) and a closed vocabulary", async () => {
    const r = repo();
    const p = await seedProfile(r);
    const s = await r.createSession(scope, { profileId: p.publicId, runKind: "design", spawnedBy: "usr_1" });

    await r.appendSessionEvent(scope, { sessionPublicId: s.publicId, seq: 0, kind: "state_changed", payload: { state: "running" } });
    await r.appendSessionEvent(scope, { sessionPublicId: s.publicId, seq: 1, kind: "artifact_produced", payload: { pr: "x" } });
    // Duplicate seq is a no-op (idempotent relay).
    await r.appendSessionEvent(scope, { sessionPublicId: s.publicId, seq: 1, kind: "artifact_produced" });

    const events = await r.listSessionEvents(scope, s.publicId);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events[1]?.kind).toBe("artifact_produced");

    // A forbidden kind can't enter the relay.
    await expect(
      r.appendSessionEvent(scope, { sessionPublicId: s.publicId, seq: 2, kind: "status_asserted" as never }),
    ).rejects.toThrow(/closed vocabulary/);
  });

  it("joins a session to its profile and touches the lease without a transition (AG6)", async () => {
    const r = repo();
    const p = await seedProfile(r);
    const s = await r.createSession(scope, { profileId: p.publicId, runKind: "design", spawnedBy: "usr_1" });

    const joined = await r.getSessionProfile(scope, s.publicId);
    expect(joined?.publicId).toBe(p.publicId);
    expect(joined?.principalId).toBe("sp_agent1");
    expect(await r.getSessionProfile(scope, "as_missing")).toBeNull();

    const touched = await r.touchSessionLease(scope, s.publicId, "2099-01-01T00:00:00Z");
    expect(touched.leaseExpiresAt).toBe("2099-01-01T00:00:00Z");
    expect(touched.state).toBe("requested"); // no transition happened

    // A terminal session's lease never revives.
    await r.advanceSession(scope, { publicId: s.publicId, to: "canceled" });
    await expect(r.touchSessionLease(scope, s.publicId, "2099-01-01T00:00:00Z")).rejects.toThrow(/revive/);
    await expect(r.touchSessionLease(scope, "as_missing", "2099-01-01T00:00:00Z")).rejects.toThrow(/not found/);
  });

  it("lists lapsed sessions cross-org for the sweep (AG6 §4.3)", async () => {
    const r = repo();
    const otherScope: WorkspaceScope = { orgId: "org_2" };
    const p1 = await seedProfile(r);
    const p2 = await r.createProfile(otherScope, {
      name: "impl",
      principalId: "sp_2",
      owner: "team/platform",
      agentType: "implementer",
      harness: "claude-code",
      model: "claude-opus-4-8",
    });

    // org_1: a running session with a lapsed lease.
    const lapsed = await r.createSession(scope, { profileId: p1.publicId, runKind: "design", spawnedBy: "u" });
    await r.advanceSession(scope, { publicId: lapsed.publicId, to: "provisioning" });
    await r.advanceSession(scope, {
      publicId: lapsed.publicId,
      to: "running",
      leaseExpiresAt: "1970-01-01T00:00:00.000Z",
    });
    // org_1: a healthy running session.
    const live = await r.createSession(scope, { profileId: p1.publicId, runKind: "design", spawnedBy: "u" });
    await r.advanceSession(scope, { publicId: live.publicId, to: "provisioning" });
    await r.advanceSession(scope, { publicId: live.publicId, to: "running", leaseExpiresAt: "2099-01-01T00:00:00Z" });
    // org_2: a stalled provisioning session.
    const stalled = await r.createSession(otherScope, { publicId: undefined, profileId: p2.publicId, runKind: "fix", spawnedBy: "u" } as never);
    await r.advanceSession(otherScope, { publicId: stalled.publicId, to: "provisioning" });

    const found = await r.listLapsedSessions({
      leaseCutoff: "2026-01-01T00:00:00Z",
      provisioningCutoff: "2099-01-01T00:00:00Z",
      limit: 10,
    });
    const ids = found.map((s) => s.publicId).sort();
    expect(ids).toEqual([lapsed.publicId, stalled.publicId].sort());
    // Cross-org: both workspaces' sessions surfaced; the healthy one did not.
    expect(found.map((s) => s.orgId).sort()).toEqual(["org_1", "org_2"]);
  });

  it("upserts autonomy policy per (org, spec)", async () => {
    const r = repo();
    await r.setAutonomy(scope, { level: "assist" }); // workspace default
    await r.setAutonomy(scope, { specKey: "orun-agents", level: "full", caps: { maxConcurrent: 2 } });

    expect((await r.getAutonomy(scope))?.level).toBe("assist");
    const spec = await r.getAutonomy(scope, "orun-agents");
    expect(spec?.level).toBe("full");
    expect(spec?.caps).toEqual({ maxConcurrent: 2 });

    // Re-set updates in place.
    await r.setAutonomy(scope, { specKey: "orun-agents", level: "auto-dispatch" });
    expect((await r.getAutonomy(scope, "orun-agents"))?.level).toBe("auto-dispatch");
  });
});

describe("provider connections (AG12)", () => {
  it("derives the reserved secret ref and validates inputs", () => {
    expect(providerSecretRef("daytona", "default")).toBe("agents/providers/daytona/default/API_KEY");
    expect(isProvider("daytona")).toBe(true);
    expect(isProvider("openai")).toBe(false);
    expect(() => validateConnectionInput({ provider: "openai", name: "default" })).toThrow(AgentsError);
    expect(() => validateConnectionInput({ provider: "daytona", name: "Bad Name" })).toThrow(AgentsError);
    expect(() => validateConnectionInput({ provider: "anthropic", name: "team-a" })).not.toThrow();
  });

  it("creates, lists (filtered), gets, and deletes connections per workspace", async () => {
    const r = repo();
    const c = await r.createConnection(scope, {
      provider: "daytona",
      name: "default",
      config: { apiUrl: "https://eu.daytona.io/api" },
      secretRef: providerSecretRef("daytona", "default"),
      keyHint: "…wxyz",
      createdBy: "usr_1",
    });
    expect(c.publicId).toMatch(/^apc_/);
    expect(c.status).toBe("unverified");
    await r.createConnection(scope, {
      provider: "anthropic",
      name: "default",
      config: {},
      secretRef: providerSecretRef("anthropic", "default"),
      createdBy: "usr_1",
    });

    expect((await r.listConnections(scope)).length).toBe(2);
    expect((await r.listConnections(scope, "daytona")).map((x) => x.provider)).toEqual(["daytona"]);
    expect((await r.getConnection(scope, c.publicId))?.name).toBe("default");
    // Another workspace sees nothing.
    expect((await r.listConnections({ orgId: "org_other" })).length).toBe(0);

    expect(await r.deleteConnection(scope, c.publicId)).toBe(true);
    expect(await r.deleteConnection(scope, c.publicId)).toBe(false);
    expect((await r.listConnections(scope)).length).toBe(1);
  });

  it("rejects a duplicate (provider, name) in a workspace", async () => {
    const r = repo();
    const input = {
      provider: "daytona" as const,
      name: "default",
      config: {},
      secretRef: providerSecretRef("daytona", "default"),
      createdBy: "usr_1",
    };
    await r.createConnection(scope, input);
    await expect(r.createConnection(scope, input)).rejects.toThrow(/already connected/);
  });

  it("tracks verification status; verified stamps lastVerifiedAt", async () => {
    const r = repo();
    const c = await r.createConnection(scope, {
      provider: "anthropic",
      name: "default",
      config: {},
      secretRef: providerSecretRef("anthropic", "default"),
      createdBy: "usr_1",
    });

    const invalid = await r.setConnectionStatus(scope, {
      publicId: c.publicId,
      status: "invalid",
      statusReason: "401 from provider",
    });
    expect(invalid.status).toBe("invalid");
    expect(invalid.statusReason).toBe("401 from provider");
    expect(invalid.lastVerifiedAt).toBeUndefined();

    const verified = await r.setConnectionStatus(scope, { publicId: c.publicId, status: "verified" });
    expect(verified.status).toBe("verified");
    expect(verified.lastVerifiedAt).toBeDefined();
    expect(verified.statusReason).toBeUndefined();

    await expect(
      r.setConnectionStatus(scope, { publicId: "apc_missing", status: "verified" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("delegation tree (saas-agents-fleet AF4)", () => {
  it("a child inherits the parent's root and depth+1; a root is its own root", async () => {
    const r = repo();
    const p = await seedProfile(r);
    const root = await r.createSession(scope, {
      profileId: p.publicId,
      runKind: "design",
      spawnedBy: "usr_1",
    });
    expect(root.rootSessionId).toBe(root.publicId);
    expect(root.depth).toBe(0);
    expect(root.parentSessionId).toBeUndefined();

    const child = await r.createSession(scope, {
      profileId: p.publicId,
      runKind: "implementation",
      spawnedBy: root.publicId,
      parentSessionId: root.publicId,
      sandbox: { appliedCeiling: { tools: ["bash"] } },
    });
    expect(child.parentSessionId).toBe(root.publicId);
    expect(child.rootSessionId).toBe(root.publicId);
    expect(child.depth).toBe(1);
    expect(child.sandbox.appliedCeiling).toEqual({ tools: ["bash"] });

    const grand = await r.createSession(scope, {
      profileId: p.publicId,
      runKind: "fix",
      spawnedBy: child.publicId,
      parentSessionId: child.publicId,
    });
    expect(grand.rootSessionId).toBe(root.publicId);
    expect(grand.depth).toBe(2);
  });

  it("refuses a child of a missing parent", async () => {
    const r = repo();
    const p = await seedProfile(r);
    await expect(
      r.createSession(scope, {
        profileId: p.publicId,
        runKind: "fix",
        spawnedBy: "usr_1",
        parentSessionId: "as_missing",
      }),
    ).rejects.toThrow(AgentsError);
  });

  it("listOrphanedSessions finds live children of terminal parents past the cutoff, cross-org", async () => {
    const r = new MemoryAgentsRepository({ now: () => "2026-07-12T09:00:00.000Z" });
    const p = await seedProfile(r);
    const root = await r.createSession(scope, { profileId: p.publicId, runKind: "design", spawnedBy: "u" });
    const child = await r.createSession(scope, {
      profileId: p.publicId,
      runKind: "implementation",
      spawnedBy: root.publicId,
      parentSessionId: root.publicId,
    });
    await r.advanceSession(scope, { publicId: root.publicId, to: "failed" });

    // Cutoff before the parent's end: nothing yet.
    expect(await r.listOrphanedSessions({ parentEndedCutoff: "2026-07-12T08:00:00.000Z", limit: 10 })).toEqual([]);
    // Cutoff after: the live child surfaces.
    const orphans = await r.listOrphanedSessions({ parentEndedCutoff: "2026-07-12T10:00:00.000Z", limit: 10 });
    expect(orphans.map((s) => s.publicId)).toEqual([child.publicId]);
    // A terminal child never surfaces.
    await r.advanceSession(scope, { publicId: child.publicId, to: "failed" });
    expect(await r.listOrphanedSessions({ parentEndedCutoff: "2026-07-12T10:00:00.000Z", limit: 10 })).toEqual([]);
  });
});
