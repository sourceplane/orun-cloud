// Budgets (saas-agents-fleet AF8): ceilings, not advisories. The door
// refuses against an exhausted envelope; ingest accumulates spend on the
// session row and turns a crossing into exactly ONE graceful interrupt on
// the DO return queue; the 80% marks surface on the attention fold; a tree
// shares one envelope.

import { route } from "@agents-worker/router";
import {
  budgetMarks,
  checkDoor,
  envelopeCrossings,
  resolveCeilings,
  treeUsage,
  workspaceUsage,
} from "@agents-worker/budget";
import type { AgentsDeps } from "@agents-worker/deps";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";
import type { AgentBudget, AttentionSummary } from "@saas/contracts/agents";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const SCOPE = { orgId: ORG_UUID };
const env: Env = { ENVIRONMENT: "test" };
const CLOCK = "2026-07-12T09:00:00.000Z";
const NOW = new Date("2026-07-12T10:00:00.000Z");

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
      "x-actor-subject-id": "usr_rahul",
      "x-actor-subject-type": "user",
      ...actorExtra,
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

async function spentSession(repo: MemoryAgentsRepository, profileId: string, tokens: number) {
  const s = await repo.createSession(SCOPE, { profileId, runKind: "implementation", spawnedBy: "u" });
  await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "provisioning" });
  await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "running" });
  if (tokens > 0) await repo.addSessionTokens(SCOPE, s.publicId, tokens);
  return (await repo.getSession(SCOPE, s.publicId))!;
}

describe("budget arithmetic (pure)", () => {
  it("resolves ceilings by grain; routine rows key by ref", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    await repo.setBudget(SCOPE, { grain: "workspace", maxTokens: 1_000_000, createdBy: "u" });
    await repo.setBudget(SCOPE, { grain: "tree", maxTokens: 500_000, createdBy: "u" });
    await repo.setBudget(SCOPE, { grain: "routine", ref: "rt_1", maxTokens: 50_000, createdBy: "u" });
    const c = resolveCeilings(await repo.listBudgets(SCOPE));
    expect(c.workspace).toBe(1_000_000);
    expect(c.tree).toBe(500_000);
    expect(c.routine.get("rt_1")).toBe(50_000);
  });

  it("workspace usage is windowed; tree usage sums the whole tree", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    const root = await spentSession(repo, p.publicId, 100);
    const child = await repo.createSession(SCOPE, {
      profileId: p.publicId,
      runKind: "fix",
      spawnedBy: "u",
      parentSessionId: root.publicId,
    });
    await repo.addSessionTokens(SCOPE, child.publicId, 50);
    const sessions = await repo.listSessions(SCOPE);
    expect(workspaceUsage(sessions, NOW)).toBe(150);
    expect(treeUsage(sessions, root.publicId)).toBe(150);
    // Beyond the 30d window the spend leaves the workspace fold.
    expect(workspaceUsage(sessions, new Date("2026-09-01T00:00:00Z"))).toBe(0);
  });

  it("the door refuses only an EXHAUSTED envelope — nearly-spent still spawns", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    await spentSession(repo, p.publicId, 900);
    await repo.setBudget(SCOPE, { grain: "workspace", maxTokens: 1000, createdBy: "u" });
    const sessions = await repo.listSessions(SCOPE);
    const budgets = await repo.listBudgets(SCOPE);
    expect(checkDoor(budgets, sessions, {}, NOW)).toBeNull();

    await repo.addSessionTokens(SCOPE, sessions[0]!.publicId, 100); // exactly at the ceiling
    expect(checkDoor(budgets, await repo.listSessions(SCOPE), {}, NOW)?.code).toBe("budget_exhausted");
  });

  it("envelopeCrossings fires exactly on the crossing, tightest grain first", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    const s = await spentSession(repo, p.publicId, 0);
    await repo.setBudget(SCOPE, { grain: "session", maxTokens: 100, createdBy: "u" });
    const budgets = await repo.listBudgets(SCOPE);

    let updated = await repo.addSessionTokens(SCOPE, s.publicId, 60);
    expect(envelopeCrossings(budgets, await repo.listSessions(SCOPE), updated, 0)).toBeNull();

    updated = await repo.addSessionTokens(SCOPE, s.publicId, 60); // 120 ≥ 100, prev 60 < 100
    const crossing = envelopeCrossings(budgets, await repo.listSessions(SCOPE), updated, 60);
    expect(crossing).toEqual({ grain: "session", limit: 100, used: 120 });

    // Later samples do NOT re-fire (prev already ≥ limit): one interrupt.
    updated = await repo.addSessionTokens(SCOPE, s.publicId, 10);
    expect(envelopeCrossings(budgets, await repo.listSessions(SCOPE), updated, 120)).toBeNull();
  });

  it("budgetMarks raises the 80% items for live envelopes only", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    const hot = await spentSession(repo, p.publicId, 85);
    const done = await spentSession(repo, p.publicId, 95);
    await repo.advanceSession(SCOPE, { publicId: done.publicId, to: "completing" });
    await repo.advanceSession(SCOPE, { publicId: done.publicId, to: "completed" });
    await repo.setBudget(SCOPE, { grain: "session", maxTokens: 100, createdBy: "u" });

    const marks = budgetMarks(await repo.listBudgets(SCOPE), await repo.listSessions(SCOPE), NOW);
    // Only the live session marks; the finished overspend is history.
    expect(marks.filter((m) => m.grain === "session").map((m) => m.ref)).toEqual([hot.publicId]);
  });
});

describe("the budgets registry + attention integration", () => {
  it("PUT upserts (same grain+ref = one ceiling), GET lists, DELETE lifts", async () => {
    const deps = makeDeps();
    const put = await route(
      req("PUT", `/v1/organizations/${ORG}/agents/budgets`, { grain: "workspace", maxTokens: 500_000 }),
      env,
      deps,
    );
    expect(put.status).toBe(200);
    const again = await route(
      req("PUT", `/v1/organizations/${ORG}/agents/budgets`, { grain: "workspace", maxTokens: 900_000 }),
      env,
      deps,
    );
    expect(again.status).toBe(200);
    const list = await route(req("GET", `/v1/organizations/${ORG}/agents/budgets`), env, deps);
    const rows = (await json(list)).data as AgentBudget[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.maxTokens).toBe(900_000);

    const del = await route(req("DELETE", `/v1/organizations/${ORG}/agents/budgets/${rows[0]!.id}`), env, deps);
    expect(del.status).toBe(200);
  });

  it("validates grain/ref shape and gates writes", async () => {
    const deps = makeDeps();
    const badRef = await route(
      req("PUT", `/v1/organizations/${ORG}/agents/budgets`, { grain: "workspace", ref: "x", maxTokens: 10 }),
      env,
      deps,
    );
    expect(badRef.status).toBe(422);
    const routineNoRef = await route(
      req("PUT", `/v1/organizations/${ORG}/agents/budgets`, { grain: "routine", maxTokens: 10 }),
      env,
      deps,
    );
    expect(routineNoRef.status).toBe(422);
    const denied = await route(
      req("PUT", `/v1/organizations/${ORG}/agents/budgets`, { grain: "workspace", maxTokens: 10 }),
      env,
      makeDeps({ allow: false }),
    );
    expect(denied.status).toBe(403);
  });

  it("an 80% envelope raises a budget attention item; raising the ceiling clears it", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    const s = await spentSession(repo, p.publicId, 85);
    await repo.setBudget(SCOPE, { grain: "session", maxTokens: 100, createdBy: "u" });
    const deps = makeDeps({ repo });

    const res = await route(req("GET", `/v1/organizations/${ORG}/agents/attention`), env, deps);
    const { data } = (await res.json()) as { data: AttentionSummary };
    expect(data.counts.budget).toBe(1);
    const item = data.items.find((i) => i.kind === "budget")!;
    expect(item.sessionId).toBe(s.publicId);
    expect(item.reason).toContain("85%");

    // Acting = raising the ceiling; the fact goes false, the item goes away.
    await repo.setBudget(SCOPE, { grain: "session", maxTokens: 1000, createdBy: "u" });
    const after = await route(req("GET", `/v1/organizations/${ORG}/agents/attention`), env, deps);
    expect(((await after.json()) as { data: AttentionSummary }).data.counts.budget).toBe(0);
  });
});

describe("the door + the graceful interrupt", () => {
  it("dispatch refuses against an exhausted workspace envelope", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    await spentSession(repo, p.publicId, 1000);
    await repo.setBudget(SCOPE, { grain: "workspace", maxTokens: 1000, createdBy: "u" });
    await repo.setAutonomy(SCOPE, { level: "auto-dispatch" });

    const res = await route(
      req("POST", `/v1/organizations/${ORG}/agents/dispatch`, { taskKey: "ORN-9" }),
      env,
      makeDeps({ repo }),
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("budget_exhausted");
  });

  it("a delegated spawn refuses when the tree envelope is spent", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    const root = await spentSession(repo, p.publicId, 500);
    await repo.setBudget(SCOPE, { grain: "tree", maxTokens: 500, createdBy: "u" });

    const res = await route(
      req(
        "POST",
        `/v1/organizations/${ORG}/agents/sessions`,
        { profileId: p.publicId, runKind: "implementation" },
        {
          "x-actor-subject-id": "sp_1",
          "x-actor-subject-type": "service_principal",
          "x-actor-agent-session-id": root.publicId,
        },
      ),
      env,
      makeDeps({ repo }),
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("budget_exhausted");
  });

  it("ingest accumulates spend on the session row and enqueues ONE interrupt on the crossing", async () => {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const p = await seedProfile(repo);
    const s = await spentSession(repo, p.publicId, 0);
    await repo.setBudget(SCOPE, { grain: "session", maxTokens: 100, createdBy: "u" });

    // A fake per-session DO namespace capturing /input posts.
    const inputs: string[] = [];
    const fakeNs = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        async fetch(request: Request) {
          inputs.push(await request.text());
          return Response.json({ v: 1, t: "ack", ok: true });
        },
      }),
    } as unknown as Env["SESSION_RELAY"];
    const envWithRelay = { ...env, SESSION_RELAY: fakeNs } as Env;

    const ingest = (seq: number, tokens: number) =>
      route(
        new Request(`https://agents-worker/v1/organizations/${ORG}/agents/sessions/${s.publicId}/events`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-actor-subject-id": "sp_1",
            "x-actor-subject-type": "service_principal",
            "x-actor-agent-session-id": s.publicId,
          },
          body: JSON.stringify([{ seq, kind: "cost_sample", payload: { tokens } }]),
        }),
        envWithRelay,
        makeDeps({ repo }),
      );

    expect((await ingest(0, 60)).status).toBe(200);
    expect(inputs.length).toBe(0);
    expect((await repo.getSession(SCOPE, s.publicId))?.tokensUsed).toBe(60);

    expect((await ingest(1, 60)).status).toBe(200); // crosses 100
    expect(inputs.length).toBe(1);
    const frame = JSON.parse(inputs[0]!) as { t: string; reason: string };
    expect(frame.t).toBe("interrupt");
    expect(frame.reason).toContain("budget_exhausted");

    expect((await ingest(2, 10)).status).toBe(200); // already over: no re-fire
    expect(inputs.length).toBe(1);
    expect((await repo.getSession(SCOPE, s.publicId))?.tokensUsed).toBe(130);
  });
});
