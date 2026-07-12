// AF9 — the acceptance narrative (design §10) as one executable story. Every
// sentence of the epic's closing narrative that the CLOUD half owns runs
// here end-to-end over the memory repo and the real routes: the design
// competition tree, the fleet-home verdict, the quiet routine, the park +
// demotion, the earned promotion, and the budget mark. The runtime-side
// sentences (tool semantics, sealing, replay) live with orun AF0–AF3.

import { route } from "@agents-worker/router";
import { routineTick } from "@agents-worker/tick";
import type { AgentsDeps } from "@agents-worker/deps";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";
import type {
  AgentProfile,
  AgentRecordsEntry,
  AgentSession as WireSession,
  AttentionSummary,
} from "@saas/contracts/agents";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const SCOPE = { orgId: ORG_UUID };
const env: Env = { ENVIRONMENT: "test" };
const CLOCK = "2026-07-12T09:00:00.000Z";

function deps(repo: MemoryAgentsRepository): AgentsDeps {
  return {
    repo,
    async authorize() {
      return true;
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

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

describe("the §10 acceptance narrative (cloud sentences)", () => {
  it("runs the story end-to-end", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const d = deps(repo);

    // ── Cast: an orchestrator and an implementer, with ceilings. ─────────
    const orch = await repo.createProfile(SCOPE, {
      name: "orchestrator-01",
      principalId: "sp_orch",
      owner: "usr_dana",
      agentType: "orchestrator",
      harness: "claude-code",
      model: "claude-fable-5",
      capability: { tools: ["read", "bash", "git"] },
    });
    const coder = await repo.createProfile(SCOPE, {
      name: "coder-01",
      principalId: "sp_orch",
      owner: "usr_elena",
      agentType: "implementer",
      harness: "claude-code",
      model: "claude-opus-4-8",
      capability: { tools: ["read", "bash", "git", "web"] },
    });
    await repo.setBudget(SCOPE, { grain: "tree", maxTokens: 500_000, createdBy: "usr_elena" });

    // ── "A spec's design competition dispatches orchestrator-01." ────────
    const rootRes = await route(
      req("POST", `/v1/organizations/${ORG}/agents/sessions`, {
        profileId: orch.publicId,
        runKind: "design",
        workRef: `work://${ORG}/init-storefront`,
      }),
      env,
      d,
    );
    const root = await data<WireSession>(rootRes);
    await repo.advanceSession(SCOPE, { publicId: root.id, to: "provisioning" });
    await repo.advanceSession(SCOPE, { publicId: root.id, to: "running" });

    // ── "…one root growing three children." (agent_spawn → the door) ─────
    const children: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await route(
        req(
          "POST",
          `/v1/organizations/${ORG}/agents/sessions`,
          { profileId: coder.publicId, runKind: "design" },
          {
            "x-actor-subject-id": "sp_orch",
            "x-actor-subject-type": "service_principal",
            "x-actor-agent-session-id": root.id,
          },
        ),
        env,
        d,
      );
      const child = await data<WireSession>(res);
      expect(child.rootSessionId).toBe(root.id);
      expect(child.depth).toBe(1);
      children.push(child.id);
      await repo.advanceSession(SCOPE, { publicId: child.id, to: "provisioning" });
      await repo.advanceSession(SCOPE, { publicId: child.id, to: "running" });
    }
    // The ceiling narrowed mechanically: "web" (child-only) is gone.
    expect((await repo.getSession(SCOPE, children[0]!))?.sandbox.appliedCeiling).toEqual({
      tools: ["read", "bash", "git"],
    });

    // ── "One child's draft needs a gated deploy; the verdict card appears
    //     on the fleet home's queue…" ───────────────────────────────────
    await repo.advanceSession(SCOPE, { publicId: children[0]!, to: "awaiting_approval" });
    await repo.appendSessionEvent(SCOPE, {
      sessionPublicId: children[0]!,
      seq: 0,
      kind: "approval_requested",
      payload: { requestId: "req-deploy", tool: "npx wrangler deploy --env preview" },
    });
    let attention = await data<AttentionSummary>(
      await route(req("GET", `/v1/organizations/${ORG}/agents/attention`), env, d),
    );
    expect(attention.counts.verdict).toBe(1);
    expect(attention.items[0]!.request?.requestId).toBe("req-deploy");

    // "…and the answer lands attributed" (the relay leg is AL's; here the
    // resolved fact reaches the log and the queue drains).
    await repo.appendSessionEvent(SCOPE, {
      sessionPublicId: children[0]!,
      seq: 1,
      kind: "approval_resolved",
      payload: { requestId: "req-deploy", approved: true, principal: "usr_elena" },
    });
    await repo.advanceSession(SCOPE, { publicId: children[0]!, to: "running" });
    attention = await data<AttentionSummary>(
      await route(req("GET", `/v1/organizations/${ORG}/agents/attention`), env, d),
    );
    expect(attention.counts.verdict).toBe(0);

    // ── "The tree completes at 61% of its 500k envelope; the comparison
    //     and three draft PRs hang off the parent." ──────────────────────
    for (const [i, cid] of children.entries()) {
      await repo.addSessionTokens(SCOPE, cid, 100_000);
      await repo.appendSessionEvent(SCOPE, {
        sessionPublicId: root.id,
        seq: 10 + i,
        kind: "child_completed",
        payload: { sessionId: cid, verdict: "pass", summary: `draft ${i + 1} green` },
      });
      await repo.advanceSession(SCOPE, { publicId: cid, to: "completing" });
      await repo.advanceSession(SCOPE, { publicId: cid, to: "completed", prUrl: `https://pr/${i}` });
    }
    await repo.addSessionTokens(SCOPE, root.id, 5_000);
    await repo.advanceSession(SCOPE, { publicId: root.id, to: "completing" });
    await repo.advanceSession(SCOPE, { publicId: root.id, to: "completed" });

    // ── "Overnight, nightly-triage fires at 07:00, completes quietly…" ───
    const nightly = await data<{ id: string }>(
      await route(
        req("POST", `/v1/organizations/${ORG}/agents/routines`, {
          name: "nightly-triage",
          profileId: coder.publicId,
          runKind: "fix",
          triggerKind: "cron",
          triggerConfig: { cron: "0 7 * * *" },
        }),
        env,
        d,
      ),
    );
    const night = await routineTick(d, "req_t", () => new Date("2026-07-13T07:02:00.000Z"));
    expect(night.fired).toBe(1);
    const firing = (await repo.listRoutineSessions(SCOPE, nightly.id, 1))[0]!;
    await repo.advanceSession(SCOPE, { publicId: firing.publicId, to: "provisioning" });
    await repo.advanceSession(SCOPE, { publicId: firing.publicId, to: "running" });
    await repo.advanceSession(SCOPE, { publicId: firing.publicId, to: "completing" });
    await repo.advanceSession(SCOPE, { publicId: firing.publicId, to: "completed" });
    // Quiet: nothing on the attention queue from a successful firing.
    attention = await data<AttentionSummary>(
      await route(req("GET", `/v1/organizations/${ORG}/agents/attention`), env, d),
    );
    expect(attention.counts.routine_parked).toBe(0);

    // ── "…the red-gate-fix routine fails twice, parks, and is one
    //     attention item" — and the profile demotes, loudly. ─────────────
    await route(
      req("POST", `/v1/organizations/${ORG}/agents/routines`, {
        name: "red-gate-fix",
        profileId: coder.publicId,
        runKind: "fix",
        triggerKind: "cron",
        triggerConfig: { cron: "0 8 * * *" },
      }),
      env,
      d,
    );
    const fixRoutine = (await repo.listRoutines(SCOPE)).find((r) => r.name === "red-gate-fix")!;
    for (let i = 0; i < 2; i++) {
      const s = await repo.createSession(SCOPE, {
        profileId: coder.publicId,
        runKind: "fix",
        spawnedBy: "agents-worker-routines",
        routineId: fixRoutine.publicId,
      });
      await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "failed", sandbox: { error: "gate_red" } });
    }
    const parkTick = await routineTick(d, "req_t", () => new Date("2026-07-13T08:02:00.000Z"));
    expect(parkTick.parked).toBe(1);
    expect(parkTick.demoted).toBe(1);
    attention = await data<AttentionSummary>(
      await route(req("GET", `/v1/organizations/${ORG}/agents/attention`), env, d),
    );
    expect(attention.counts.routine_parked).toBe(1);

    // ── "By Friday coder-01's record clears the bar; the console suggests
    //     … elena acks; the profile shows the address." ──────────────────
    await repo.setAutonomy(SCOPE, {
      level: "assist",
      caps: { promotionBar: { minSessions: 5, minCompletionRate: 0.6 } },
    });
    const records = await data<AgentRecordsEntry[]>(
      await route(req("GET", `/v1/organizations/${ORG}/agents/records`), env, d),
    );
    const coderEntry = records.find((r) => r.profileId === coder.publicId)!;
    expect(coderEntry.promotion.eligible).toBe(true);
    // (coder-01 sits at assist after the automatic demotion from auto-… no:
    // it was demoted from assist → manual by the park.)
    const suggested = coderEntry.promotion.suggested!;
    const acked = await data<AgentProfile>(
      await route(
        req("PATCH", `/v1/organizations/${ORG}/agents/profiles/${coder.publicId}`, {
          autonomyDefault: suggested,
        }),
        env,
        d,
      ),
    );
    expect(acked.autonomyDefault).toBe(suggested);
    const evidence = acked.autonomyEvidence as { direction: string; by: string; record?: { sessions: number } };
    expect(evidence.direction).toBe("promoted");
    expect(evidence.by).toBe("usr_elena");
    expect(evidence.record!.sessions).toBeGreaterThanOrEqual(5);

    // ── "A month later the workspace budget's 80% mark raises one
    //     attention item." ───────────────────────────────────────────────
    await repo.setBudget(SCOPE, { grain: "workspace", maxTokens: 380_000, createdBy: "usr_elena" });
    attention = await data<AttentionSummary>(
      await route(req("GET", `/v1/organizations/${ORG}/agents/attention`), env, d),
    );
    expect(attention.counts.budget).toBe(1);
    expect(attention.items.find((i) => i.kind === "budget")!.reason).toContain("workspace budget");
  });
});
