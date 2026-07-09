import {
  MemoryAgentsRepository,
  canTransition,
  isSessionEventKind,
  isTerminal,
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
