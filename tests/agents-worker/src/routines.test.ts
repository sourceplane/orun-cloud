// Routines (saas-agents-fleet AF6): the cron floor and matcher; registry CRUD
// with the resume-only park latch; firings through the ONE dispatch door
// (enabled+unparked is the authorization, dedupe + caps still bite); the
// scheduler tick's due/misfire windows and the two-failure park.

import { route } from "@agents-worker/router";
import { routineTick } from "@agents-worker/tick";
import { parseCron, cronMatches, dueSince, isHourlyOrCoarser } from "@agents-worker/cron";
import type { AgentsDeps } from "@agents-worker/deps";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";
import type { AgentRoutine, AttentionSummary } from "@saas/contracts/agents";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const SCOPE = { orgId: ORG_UUID };
const env: Env = { ENVIRONMENT: "test" };
const CLOCK = "2026-07-12T09:00:00.000Z";

function makeDeps(overrides?: { allow?: boolean; repo?: MemoryAgentsRepository }): AgentsDeps {
  return {
    repo: overrides?.repo ?? new MemoryAgentsRepository({ now: () => CLOCK }),
    async authorize() {
      return overrides?.allow ?? true;
    },
    async dispose() {},
  };
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://agents-worker${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-actor-subject-id": "usr_rahul",
      "x-actor-subject-type": "user",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(res: Response): Promise<{ data?: unknown; error?: { code: string; message?: string } }> {
  return (await res.json()) as { data?: unknown; error?: { code: string; message?: string } };
}

async function seedProfile(repo: MemoryAgentsRepository) {
  return repo.createProfile(SCOPE, {
    name: "coder-01",
    principalId: "sp_1",
    owner: "usr_elena",
    agentType: "implementer",
    harness: "claude-code",
    model: "claude-opus-4-8",
  });
}

async function seedRoutine(repo: MemoryAgentsRepository, name = "nightly-triage", cron = "0 7 * * *") {
  const p = await seedProfile(repo).catch(async () => (await repo.listProfiles(SCOPE))[0]!);
  return repo.createRoutine(SCOPE, {
    name,
    profileId: p.publicId,
    runKind: "fix",
    triggerKind: "cron",
    triggerConfig: { cron },
    createdBy: "usr_rahul",
  });
}

describe("the cron matcher", () => {
  it("parses and matches the basics", () => {
    const spec = parseCron("0 7 * * *")!;
    expect(cronMatches(spec, new Date("2026-07-12T07:00:00Z"))).toBe(true);
    expect(cronMatches(spec, new Date("2026-07-12T07:01:00Z"))).toBe(false);
    expect(cronMatches(spec, new Date("2026-07-12T08:00:00Z"))).toBe(false);
  });

  it("supports lists, ranges, steps, and dow/dom either-match", () => {
    expect(cronMatches(parseCron("30 9-17 * * 1-5")!, new Date("2026-07-10T12:30:00Z"))).toBe(true); // a Friday
    expect(cronMatches(parseCron("0 */6 * * *")!, new Date("2026-07-12T18:00:00Z"))).toBe(true);
    // Standard cron: restricted dom AND dow → either may match.
    const both = parseCron("0 7 15 * 0")!;
    expect(cronMatches(both, new Date("2026-07-12T07:00:00Z"))).toBe(true); // a Sunday, not the 15th
    expect(cronMatches(both, new Date("2026-07-15T07:00:00Z"))).toBe(true); // the 15th, a Wednesday
    expect(cronMatches(both, new Date("2026-07-14T07:00:00Z"))).toBe(false);
  });

  it("rejects malformed expressions", () => {
    for (const bad of ["", "* * * *", "61 * * * *", "a b c d e", "*/0 * * * *", "5-1 * * * *"]) {
      expect(parseCron(bad)).toBeNull();
    }
  });

  it("the hourly floor: sub-hourly minute fields are not hourly-or-coarser", () => {
    expect(isHourlyOrCoarser(parseCron("0 7 * * *")!)).toBe(true);
    expect(isHourlyOrCoarser(parseCron("15 * * * *")!)).toBe(true);
    expect(isHourlyOrCoarser(parseCron("* * * * *")!)).toBe(false);
    expect(isHourlyOrCoarser(parseCron("*/5 * * * *")!)).toBe(false);
    expect(isHourlyOrCoarser(parseCron("0,30 * * * *")!)).toBe(false);
  });

  it("dueSince covers exactly the window (from, to]", () => {
    const spec = parseCron("0 7 * * *")!;
    expect(dueSince(spec, new Date("2026-07-12T06:58:00Z"), new Date("2026-07-12T07:02:00Z"))).toBe(true);
    expect(dueSince(spec, new Date("2026-07-12T07:00:00Z"), new Date("2026-07-12T07:04:00Z"))).toBe(false); // 07:00 excluded — already fired
    expect(dueSince(spec, new Date("2026-07-12T06:00:00Z"), new Date("2026-07-12T06:59:00Z"))).toBe(false);
  });
});

describe("the routine registry", () => {
  it("creates, lists, and enforces the hourly floor + trigger validation", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    const deps = makeDeps({ repo });

    const subHourly = await route(
      req("POST", `/v1/organizations/${ORG}/agents/routines`, {
        name: "too-hot",
        profileId: p.publicId,
        runKind: "fix",
        triggerKind: "cron",
        triggerConfig: { cron: "*/5 * * * *" },
      }),
      env,
      deps,
    );
    expect(subHourly.status).toBe(422);

    const ok = await route(
      req("POST", `/v1/organizations/${ORG}/agents/routines`, {
        name: "nightly-triage",
        profileId: p.publicId,
        runKind: "fix",
        triggerKind: "cron",
        triggerConfig: { cron: "0 7 * * *" },
      }),
      env,
      deps,
    );
    expect(ok.status).toBe(201);
    const created = (await json(ok)).data as AgentRoutine;
    expect(created.id).toMatch(/^rt_/);
    expect(created.enabled).toBe(true);

    const list = await route(req("GET", `/v1/organizations/${ORG}/agents/routines`), env, deps);
    expect(((await json(list)).data as unknown[]).length).toBe(1);
  });

  it("PATCH is standing-state only: resume works, manual parking is refused", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const r = await seedRoutine(repo);
    await repo.updateRoutineState(SCOPE, {
      publicId: r.publicId,
      parked: true,
      parkedReason: "2 consecutive failures",
      consecutiveFailures: 2,
    });
    const deps = makeDeps({ repo });

    const park = await route(
      req("PATCH", `/v1/organizations/${ORG}/agents/routines/${r.publicId}`, { parked: true }),
      env,
      deps,
    );
    expect(park.status).toBe(422);

    const resume = await route(
      req("PATCH", `/v1/organizations/${ORG}/agents/routines/${r.publicId}`, { parked: false }),
      env,
      deps,
    );
    expect(resume.status).toBe(200);
    const resumed = (await json(resume)).data as AgentRoutine;
    expect(resumed.parked).toBe(false);
    expect(resumed.consecutiveFailures).toBe(0); // a fresh start
    expect(resumed.parkedReason).toBeUndefined();
  });

  it("routine routes are write-gated", async () => {
    const res = await route(
      req("POST", `/v1/organizations/${ORG}/agents/routines`, { name: "x" }),
      env,
      makeDeps({ allow: false }),
    );
    expect(res.status).toBe(403);
  });
});

describe("firing through the dispatch door", () => {
  it("fires an enabled routine (parked without providers), dedupes a live firing", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const r = await seedRoutine(repo);
    const deps = makeDeps({ repo });

    const fire = await route(
      req("POST", `/v1/organizations/${ORG}/agents/dispatch`, { routineId: r.publicId }),
      env,
      deps,
    );
    expect(fire.status).toBe(201);
    const payload = (await json(fire)).data as { session: { id: string; routineId?: string }; provisioned: boolean };
    // No providers connected in the fixture: dispatched-but-parked, honestly.
    expect(payload.provisioned).toBe(false);
    expect(payload.session.routineId).toBe(r.publicId);
    expect((await repo.getRoutine(SCOPE, r.publicId))?.lastFiredAt).toBeDefined();

    // One live run per routine — firing twice gets a conflict, not two runs.
    const again = await route(
      req("POST", `/v1/organizations/${ORG}/agents/dispatch`, { routineId: r.publicId }),
      env,
      deps,
    );
    expect(again.status).toBe(409);
  });

  it("a disabled or parked routine refuses to fire", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const r = await seedRoutine(repo);
    await repo.updateRoutineState(SCOPE, { publicId: r.publicId, enabled: false });
    const deps = makeDeps({ repo });
    const res = await route(
      req("POST", `/v1/organizations/${ORG}/agents/dispatch`, { routineId: r.publicId }),
      env,
      deps,
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("agent_routine_not_live");
  });
});

describe("the scheduler tick", () => {
  it("fires a due cron once, then not again until the next slot (misfire-once)", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    await seedRoutine(repo, "nightly", "0 7 * * *");
    const deps = makeDeps({ repo });

    // 07:03 — the 07:00 slot is inside the lookback window: fire once.
    const first = await routineTick(deps, "req_t", () => new Date("2026-07-12T07:03:00.000Z"));
    expect(first.fired).toBe(1);

    // A minute later: lastFiredAt bounds the window; the same slot is spent.
    const second = await routineTick(deps, "req_t", () => new Date("2026-07-12T07:04:00.000Z"));
    expect(second.fired).toBe(0);
    expect(second.refused).toBe(0);
  });

  it("a slot older than the lookback is forgotten — predicates, not backlogs", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    await seedRoutine(repo, "nightly", "0 7 * * *");
    const deps = makeDeps({ repo });
    // 09:30, never fired: the 07:00 slot is >60min old — no catch-up burst.
    const tick = await routineTick(deps, "req_t", () => new Date("2026-07-12T09:30:00.000Z"));
    expect(tick.fired).toBe(0);
  });

  it("parks after two consecutive failed firings and stops firing", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const r = await seedRoutine(repo, "flaky", "0 7 * * *");
    // Two failed firings on the record.
    for (let i = 0; i < 2; i++) {
      const s = await repo.createSession(SCOPE, {
        profileId: (await repo.listProfiles(SCOPE))[0]!.publicId,
        runKind: "fix",
        spawnedBy: "agents-worker-routines",
        routineId: r.publicId,
      });
      await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "provisioning" });
      await repo.advanceSession(SCOPE, {
        publicId: s.publicId,
        to: "failed",
        sandbox: { error: "sandbox_unavailable" },
      });
    }
    const deps = makeDeps({ repo });
    const tick = await routineTick(deps, "req_t", () => new Date("2026-07-12T07:03:00.000Z"));
    expect(tick.parked).toBe(1);
    expect(tick.fired).toBe(0); // parked BEFORE the due check — never a third run on this tick

    const parked = await repo.getRoutine(SCOPE, r.publicId);
    expect(parked?.parked).toBe(true);
    expect(parked?.parkedReason).toContain("sandbox_unavailable");

    // Parked routines leave the live scan entirely on the next tick.
    const after = await routineTick(deps, "req_t", () => new Date("2026-07-13T07:03:00.000Z"));
    expect(after.examined).toBe(0);
  });

  it("a parked routine surfaces on the attention fold, and resuming clears it", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const r = await seedRoutine(repo, "flaky", "0 7 * * *");
    await repo.updateRoutineState(SCOPE, {
      publicId: r.publicId,
      parked: true,
      parkedReason: "2 consecutive failures (last: lease_lost)",
    });
    const deps = makeDeps({ repo });

    const res = await route(req("GET", `/v1/organizations/${ORG}/agents/attention`), env, deps);
    const { data } = (await res.json()) as { data: AttentionSummary };
    expect(data.counts.routine_parked).toBe(1);
    const item = data.items.find((i) => i.kind === "routine_parked")!;
    expect(item.routineId).toBe(r.publicId);
    expect(item.reason).toContain("lease_lost");

    await repo.updateRoutineState(SCOPE, { publicId: r.publicId, parked: false, consecutiveFailures: 0 });
    const after = await route(req("GET", `/v1/organizations/${ORG}/agents/attention`), env, deps);
    expect(((await after.json()) as { data: AttentionSummary }).data.counts.routine_parked).toBe(0);
  });
});
