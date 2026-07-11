// The WH5 acceptance run (orun-work-v4 implementation-plan):
// an agent given only the sealed brief plans and executes a milestone
// end-to-end with zero human free-text — its tasks attributed, its
// contracts flagged for review, its progress OBSERVED through the
// unchanged delivery fold. Plus the dispatch precondition and the
// regeneration rules (Q-6) that govern it.

import { beforeEach, describe, expect, it } from "vitest";
import { MemoryWorkRepository } from "./memory.js";
import { foldEpicExecution, foldEpicIntent, foldMilestones } from "./hierarchy.js";
import { fold, type Actor } from "./model.js";
import { openContractProposals } from "./triage.js";

const scope = { orgId: "org-1" };
const human: Actor = { type: "user", id: "usr_rahul", via: "console" };
const agent: Actor = { type: "agent", id: "sp_impl", via: "mcp" };

let repo: MemoryWorkRepository;
let tick = 0;

beforeEach(() => {
  tick = 0;
  repo = new MemoryWorkRepository(() => `2026-07-11T1${String(Math.floor(tick / 60) % 10)}:${String(tick++ % 60).padStart(2, "0")}:00Z`);
});

async function approvedEpic(slug: string): Promise<string> {
  await repo.createSpec(scope, { slug, title: "Handoff Epic", actor: human });
  await repo.putDocRevision(scope, { specKey: slug, body: "# What to build\n", actor: human });
  await repo.editMilestone(scope, { epicKey: slug, op: "create", key: "M1", title: "Ship it", goal: "end to end", actor: human });
  await repo.approve(scope, { key: slug, actor: human });
  return slug;
}

describe("dispatch preconditions (design §3)", () => {
  it("an agent cannot be dispatched into an unapproved epic; a human override is attributed", async () => {
    await repo.createSpec(scope, { slug: "draft-epic", title: "Draft", actor: human });
    const t = await repo.createTask(scope, { prefix: "WKH", specKey: "draft-epic", title: "t", actor: human });

    // Agent self-assign (dispatch-is-assignment) → verdict, always.
    await expect(
      repo.assign(scope, { key: t.key, subject: "sp_impl", actor: agent }),
    ).rejects.toMatchObject({ code: "invalid" });
    // Human without a note → verdict (the teaching moment).
    await expect(
      repo.assign(scope, { key: t.key, subject: "sp_impl", actor: human }),
    ).rejects.toMatchObject({ code: "invalid" });
    // Human WITH a note → allowed, and the note rides the attributed event.
    const out = await repo.assign(scope, {
      key: t.key,
      subject: "sp_impl",
      override: "prototype spike — approving after",
      actor: human,
    });
    expect((out.event.payload as { override?: string }).override).toContain("prototype spike");
    // Agents even with a note → still a verdict (V4-2).
    await expect(
      repo.assign(scope, { key: t.key, subject: "sp_other", override: "please", actor: agent }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("dispatch into an approved epic needs no ceremony; humans assigning humans are never gated", async () => {
    const epic = await approvedEpic("approved-epic");
    const t = await repo.createTask(scope, { prefix: "WKH", specKey: epic, milestone: "M1", title: "t", actor: human });
    await expect(repo.assign(scope, { key: t.key, subject: "sp_impl", actor: agent })).resolves.toBeDefined();
    const inbox = await repo.createTask(scope, { prefix: "WKH", title: "no epic", actor: human });
    await expect(repo.assign(scope, { key: inbox.key, subject: "usr_other", actor: human })).resolves.toBeDefined();
  });
});

describe("regeneration (V4-5 + Q-6)", () => {
  it("replaces planned tasks, keeps in-flight ones, and flags agent contracts for review", async () => {
    const epic = await approvedEpic("regen-epic");
    const planned = await repo.createTask(scope, { prefix: "WKR", specKey: epic, milestone: "M1", title: "old plan", actor: agent });
    const inflight = await repo.createTask(scope, {
      prefix: "WKR",
      specKey: epic,
      milestone: "M1",
      title: "already moving",
      contract: { goal: "g", affects: ["a/b/c"], doneWhen: ["d"], gates: ["tests"] },
      actor: agent,
    });
    // The world observed a branch for the in-flight task — it survives.
    await repo.ingestObservation(scope, {
      workspace: scope.orgId,
      source: "github-webhook",
      sourceVersion: 1,
      kind: "branch_seen",
      at: "2026-07-11T11:00:00Z",
      dedupeKey: "gh:branch:regen",
      payload: { branch: `feat/${inflight.key}-x`, taskKeys: [inflight.key] },
    });

    const out = await repo.regenerateTasks(scope, {
      epicKey: epic,
      milestone: "M1",
      prefix: "WKR",
      tasks: [
        { title: "new plan a", contract: { goal: "ga", affects: ["a/b/c"], doneWhen: ["da"], gates: ["tests"] } },
        { title: "new plan b" },
      ],
      actor: agent,
    });
    expect(out.canceled).toEqual([planned.key]);
    expect(out.kept).toEqual([inflight.key]);
    expect(out.created).toHaveLength(2);

    // Approval never drifts on task churn (V4-5).
    const intent = await foldEpicIntent(epic, await repo.listEvents(scope));
    expect(intent.state).toBe("approved");

    // The agent-proposed contract is applied AND flagged (triage lane).
    const proposals = openContractProposals(await repo.listEvents(scope));
    expect(proposals.some((p) => p.key === out.created[0])).toBe(true);

    // A human's regenerate does not flag.
    const human2 = await repo.regenerateTasks(scope, {
      epicKey: epic,
      milestone: "M1",
      prefix: "WKR",
      tasks: [{ title: "hand-planned", contract: { goal: "g", affects: ["a/b/c"], doneWhen: ["d"], gates: [] } }],
      actor: human,
    });
    const after = openContractProposals(await repo.listEvents(scope));
    expect(after.some((p) => p.key === human2.created[0])).toBe(false);
  });
});

describe("the acceptance run: brief → plan → execute → observed done", () => {
  it("an agent works a milestone end-to-end from the sealed brief with zero human free-text", async () => {
    const epic = await approvedEpic("acceptance-epic");

    // 1. The dispatch artifact: the brief approval sealed.
    const brief = await repo.getEpicBrief(scope, epic);
    const parsed = JSON.parse(brief.canonical) as {
      spec: { key: string };
      milestones: { key: string; goal?: string }[];
    };
    expect(parsed.spec.key).toBe(epic);
    const milestone = parsed.milestones[0]!.key;

    // 2. The agent plans the milestone from the brief alone (regenerate =
    //    plan generation over an empty milestone).
    const plan = await repo.regenerateTasks(scope, {
      epicKey: parsed.spec.key,
      milestone,
      prefix: "WKX",
      tasks: [
        { title: "wire the fold", contract: { goal: "wire it", affects: ["a/b/c"], doneWhen: ["fold green"], gates: [], gatesDefined: true } },
        { title: "ship the surface", contract: { goal: "ship it", affects: ["a/b/web"], doneWhen: ["page renders"], gates: [], gatesDefined: true } },
      ],
      actor: agent,
    });
    expect(plan.created).toHaveLength(2);

    // 3. The agent claims its own seat on an APPROVED epic — no ceremony.
    for (const key of plan.created) {
      await repo.assign(scope, { key, subject: "sp_impl", actor: agent });
    }

    // 4. Progress is OBSERVED, never asserted: branches open, PRs merge.
    let seq = 0;
    for (const key of plan.created) {
      await repo.ingestObservation(scope, {
        workspace: scope.orgId,
        source: "github-webhook",
        sourceVersion: 1,
        kind: "pr_merged",
        at: `2026-07-11T12:0${seq}:00Z`,
        dedupeKey: `gh:pr:o/r#${100 + seq}:merged`,
        payload: { pr: `o/r#${100 + seq}`, revision: `sha256:rev${seq}`, taskKeys: [key] },
      });
      seq++;
    }

    // 5. The unchanged delivery fold rolls the milestone to complete.
    const ws = await repo.getWorkSet(scope);
    const ladder = foldMilestones(epic, ws.events);
    const execution = foldEpicExecution(ws, epic, ladder, fold(ws));
    expect(execution.milestones?.[0]?.total).toBe(2);
    expect(execution.milestones?.[0]?.complete).toBe(2);

    // 6. Nothing in the walk let the agent assert a rung, pin, approve, or
    //    adopt — the categories stay unrepresentable.
    const kinds = new Set(ws.events.map((e) => `${e.actor.type}:${e.kind}`));
    expect(kinds.has("agent:approved")).toBe(false);
    expect(kinds.has("agent:pinned")).toBe(false);
    expect(kinds.has("agent:design_adopted")).toBe(false);
  });
});
