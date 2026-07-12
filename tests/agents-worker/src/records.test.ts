// Track record & earned autonomy (saas-agents-fleet AF7): the record is a
// computed read an agent cannot inflate (human verdicts only); promotion is
// suggested by the record and applied only by a human ack with the
// server-computed evidence attached; demotion is automatic on the park
// trigger; and NO agent identity can move any leash — structurally, before
// policy, so no grant misconfiguration opens a self-promotion path.

import { route } from "@agents-worker/router";
import { routineTick } from "@agents-worker/tick";
import { computeRecord } from "@agents-worker/record";
import type { AgentsDeps } from "@agents-worker/deps";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { SessionEvent } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";
import { assessPromotion, type AgentProfile, type AgentRecordsEntry } from "@saas/contracts/agents";

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

function req(method: string, path: string, body?: unknown, actorExtra: Record<string, string> = {}): Request {
  return new Request(`https://agents-worker${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-actor-subject-id": "usr_elena",
      "x-actor-subject-type": "user",
      ...actorExtra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(res: Response): Promise<{ data?: unknown; error?: { code: string } }> {
  return (await res.json()) as { data?: unknown; error?: { code: string } };
}

async function seedProfile(repo: MemoryAgentsRepository, autonomyDefault: "manual" | "assist" | "auto-dispatch" | "full" = "assist") {
  return repo.createProfile(SCOPE, {
    name: "coder-01",
    principalId: "sp_1",
    owner: "usr_elena",
    agentType: "implementer",
    harness: "claude-code",
    model: "claude-opus-4-8",
    autonomyDefault,
  });
}

/** N completed sessions for the profile (through the guarded transitions). */
async function completedSessions(repo: MemoryAgentsRepository, profileId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const s = await repo.createSession(SCOPE, { profileId, runKind: "implementation", spawnedBy: "u" });
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "provisioning" });
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "running" });
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "completing" });
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "completed", prUrl: `https://pr/${i}` });
  }
}

describe("computeRecord (pure)", () => {
  const ev = (seq: number, kind: SessionEvent["kind"], payload: Record<string, unknown>): SessionEvent => ({
    seq,
    kind,
    payload,
    at: CLOCK,
  });

  it("counts states, artifacts, and rates with visible numerators", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    await completedSessions(repo, p.publicId, 3);
    const failedOne = await repo.createSession(SCOPE, { profileId: p.publicId, runKind: "fix", spawnedBy: "u" });
    await repo.advanceSession(SCOPE, { publicId: failedOne.publicId, to: "failed" });

    const record = computeRecord(p.publicId, await repo.listSessions(SCOPE), new Map());
    expect(record.sessions).toBe(4);
    expect(record.byKind).toEqual({ implementation: 3, fix: 1 });
    expect(record.completed).toBe(3);
    expect(record.failed).toBe(1);
    expect(record.completionRate).toBe(0.75);
    expect(record.prProduced).toBe(3);
  });

  it("counts ONLY human verdicts as trust — agent-answered verdicts are excluded", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    const s = await repo.createSession(SCOPE, { profileId: p.publicId, runKind: "fix", spawnedBy: "u" });
    const events = new Map<string, SessionEvent[]>([
      [
        s.publicId,
        [
          ev(0, "approval_requested", { requestId: "r1", tool: "x" }),
          ev(1, "approval_resolved", { requestId: "r1", approved: true, principal: "usr_elena" }),
          ev(2, "approval_requested", { requestId: "r2", tool: "y" }),
          // A service-principal "grant" — a hijacked sibling can't launder trust.
          ev(3, "approval_resolved", { requestId: "r2", approved: true, principal: "sp_evil" }),
          ev(4, "message_user", { text: "steer", principal: "usr_elena" }),
          ev(5, "cost_sample", { tokens: 1200 }),
        ],
      ],
    ]);
    const record = computeRecord(p.publicId, await repo.listSessions(SCOPE), events);
    expect(record.verdictAsks).toBe(2);
    expect(record.verdictGrants).toBe(1);
    expect(record.grantRate).toBe(0.5);
    expect(record.steers).toBe(1);
    expect(record.tokensObserved).toBe(1200);
  });
});

describe("assessPromotion (pure)", () => {
  const base = {
    profileId: "agp_1",
    byKind: {},
    completed: 18,
    failed: 2,
    completionRate: 0.9,
    prProduced: 18,
    verdictAsks: 0,
    verdictGrants: 0,
    grantRate: null,
    steers: 0,
    tokensObserved: 0,
  };

  it("clears the bar → suggests exactly one rung up; never past full", () => {
    const eligible = assessPromotion({ ...base, sessions: 20 }, "assist");
    expect(eligible.eligible).toBe(true);
    expect(eligible.suggested).toBe("auto-dispatch");
    expect(assessPromotion({ ...base, sessions: 20 }, "full").eligible).toBe(false);
  });

  it("misses the bar on volume or rate → not eligible", () => {
    expect(assessPromotion({ ...base, sessions: 19 }, "assist").eligible).toBe(false);
    expect(
      assessPromotion({ ...base, sessions: 30, completionRate: 0.5 }, "assist").eligible,
    ).toBe(false);
    expect(assessPromotion({ ...base, sessions: 30, completionRate: null }, "assist").eligible).toBe(false);
  });
});

describe("the records read + the human ack", () => {
  it("GET /agents/records folds every profile with the workspace bar override", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    await completedSessions(repo, p.publicId, 3);
    // The workspace lowers the bar (F-Q4 is config): 3 sessions suffice.
    await repo.setAutonomy(SCOPE, {
      level: "assist",
      caps: { promotionBar: { minSessions: 3, minCompletionRate: 0.8 } },
    });

    const res = await route(req("GET", `/v1/organizations/${ORG}/agents/records`), env, makeDeps({ repo }));
    expect(res.status).toBe(200);
    const entries = (await json(res)).data as AgentRecordsEntry[];
    expect(entries.length).toBe(1);
    expect(entries[0]!.record.sessions).toBe(3);
    expect(entries[0]!.promotion.eligible).toBe(true);
    expect(entries[0]!.promotion.suggested).toBe("auto-dispatch");
  });

  it("a human promotion stores the server-computed record as the movement's address", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    await completedSessions(repo, p.publicId, 2);

    const res = await route(
      req("PATCH", `/v1/organizations/${ORG}/agents/profiles/${p.publicId}`, {
        autonomyDefault: "auto-dispatch",
      }),
      env,
      makeDeps({ repo }),
    );
    expect(res.status).toBe(200);
    const updated = (await json(res)).data as AgentProfile;
    expect(updated.autonomyDefault).toBe("auto-dispatch");
    const evidence = updated.autonomyEvidence as {
      direction: string;
      from: string;
      to: string;
      by: string;
      record?: { sessions: number };
    };
    expect(evidence.direction).toBe("promoted");
    expect(evidence.from).toBe("assist");
    expect(evidence.by).toBe("usr_elena");
    // Evidence is computed server-side at the moment of the ack.
    expect(evidence.record?.sessions).toBe(2);
  });

  it("NO agent identity can move a leash — structural, before policy", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    // Both an agent-session bearer and a bare service principal are refused
    // even though the stub authorizer grants everything.
    for (const extra of [
      { "x-actor-subject-id": "sp_agent", "x-actor-subject-type": "service_principal" },
      {
        "x-actor-subject-id": "sp_agent",
        "x-actor-subject-type": "service_principal",
        "x-actor-agent-session-id": "as_self",
      },
    ]) {
      const res = await route(
        req("PATCH", `/v1/organizations/${ORG}/agents/profiles/${p.publicId}`, { autonomyDefault: "full" }, extra),
        env,
        makeDeps({ repo, allow: true }),
      );
      expect(res.status).toBe(403);
      expect((await json(res)).error?.code).toBe("agent_autonomy_self_service");
    }
    // The level never moved.
    expect((await repo.listProfiles(SCOPE))[0]!.autonomyDefault).toBe("assist");
  });

  it("a human demotion needs no record; same-level PATCH is a no-op", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo, "auto-dispatch");
    const down = await route(
      req("PATCH", `/v1/organizations/${ORG}/agents/profiles/${p.publicId}`, { autonomyDefault: "manual" }),
      env,
      makeDeps({ repo }),
    );
    expect(down.status).toBe(200);
    const updated = (await json(down)).data as AgentProfile;
    expect((updated.autonomyEvidence as { direction: string }).direction).toBe("demoted");

    const same = await route(
      req("PATCH", `/v1/organizations/${ORG}/agents/profiles/${p.publicId}`, { autonomyDefault: "manual" }),
      env,
      makeDeps({ repo }),
    );
    expect(same.status).toBe(200);
  });
});

describe("automatic demotion on the park trigger", () => {
  it("a parking tick drops the bound profile one rung with the trigger named", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo, "auto-dispatch");
    const routine = await repo.createRoutine(SCOPE, {
      name: "flaky",
      profileId: p.publicId,
      runKind: "fix",
      triggerKind: "cron",
      triggerConfig: { cron: "0 7 * * *" },
      createdBy: "usr_elena",
    });
    for (let i = 0; i < 2; i++) {
      const s = await repo.createSession(SCOPE, {
        profileId: p.publicId,
        runKind: "fix",
        spawnedBy: "svc",
        routineId: routine.publicId,
      });
      await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "failed" });
    }

    const tick = await routineTick(makeDeps({ repo }), "req_t", () => new Date("2026-07-12T07:03:00.000Z"));
    expect(tick.parked).toBe(1);
    expect(tick.demoted).toBe(1);

    const demoted = (await repo.listProfiles(SCOPE))[0]!;
    expect(demoted.autonomyDefault).toBe("assist");
    const evidence = demoted.autonomyEvidence as { direction: string; trigger: string };
    expect(evidence.direction).toBe("demoted");
    expect(evidence.trigger).toBe("routine_parked:flaky");
  });

  it("a profile already at the floor parks the routine but demotes nothing", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo, "manual");
    const routine = await repo.createRoutine(SCOPE, {
      name: "flaky",
      profileId: p.publicId,
      runKind: "fix",
      triggerKind: "cron",
      triggerConfig: { cron: "0 7 * * *" },
      createdBy: "usr_elena",
    });
    for (let i = 0; i < 2; i++) {
      const s = await repo.createSession(SCOPE, {
        profileId: p.publicId,
        runKind: "fix",
        spawnedBy: "svc",
        routineId: routine.publicId,
      });
      await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "failed" });
    }
    const tick = await routineTick(makeDeps({ repo }), "req_t", () => new Date("2026-07-12T07:03:00.000Z"));
    expect(tick.parked).toBe(1);
    expect(tick.demoted).toBe(0);
    expect((await repo.listProfiles(SCOPE))[0]!.autonomyDefault).toBe("manual");
  });
});
