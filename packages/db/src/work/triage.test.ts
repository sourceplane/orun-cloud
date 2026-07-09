// PM5 triage tests (orun-work-v3): the contract-review lane's state is a
// fold over the conversation — no flag column exists, so these tests prove
// the lifecycle from events alone: an agent proposal is OPEN until a human
// answers in the log (a reviewing comment or a human contract edit).

import { describe, expect, it } from "vitest";
import { MemoryWorkRepository } from "./memory.js";
import { fold } from "./model.js";
import { foldAssignees, openContractProposals, recentMentions, reviewParkedKeys } from "./triage.js";

const SCOPE = { orgId: "org-1" };
const USER = { type: "user" as const, id: "usr_1" };
const AGENT = { type: "agent" as const, id: "sp_1" };
const clock = () => "2026-07-09T00:00:00Z";

async function seed() {
  const repo = new MemoryWorkRepository(clock);
  const { key } = await repo.createTask(SCOPE, {
    prefix: "ORN",
    title: "t",
    contract: { goal: "original", affects: ["a"], doneWhen: ["d"], gatesDefined: true },
    actor: USER,
  });
  return { repo, key };
}

describe("openContractProposals (the agent-governance lane)", () => {
  it("an agent contract edit opens a proposal carrying the revert target", async () => {
    const { repo, key } = await seed();
    const out = await repo.editContract(SCOPE, {
      key,
      contract: { goal: "wider", affects: ["a", "b"], doneWhen: ["d"], gatesDefined: true },
      actor: AGENT,
    });
    const proposals = openContractProposals(await repo.listEvents(SCOPE));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      key,
      eventId: out.event.eventId,
      proposedBy: AGENT,
      contract: { goal: "wider" },
      previousContract: { goal: "original" },
    });
  });

  it("a human comment reviewing the proposal (Accept) clears it", async () => {
    const { repo, key } = await seed();
    const out = await repo.editContract(SCOPE, { key, contract: { goal: "wider" }, actor: AGENT });
    await repo.comment(SCOPE, { key, body: "looks right", reviewsEvent: out.event.eventId, actor: USER });
    expect(openContractProposals(await repo.listEvents(SCOPE))).toHaveLength(0);
  });

  it("a human contract edit (Revert/supersede) clears every open proposal on the task", async () => {
    const { repo, key } = await seed();
    await repo.editContract(SCOPE, { key, contract: { goal: "wider" }, actor: AGENT });
    await repo.editContract(SCOPE, { key, contract: { goal: "wider still" }, actor: AGENT });
    await repo.editContract(SCOPE, { key, contract: { goal: "original" }, actor: USER });
    expect(openContractProposals(await repo.listEvents(SCOPE))).toHaveLength(0);
  });

  it("an agent comment or a comment reviewing nothing clears nothing", async () => {
    const { repo, key } = await seed();
    const out = await repo.editContract(SCOPE, { key, contract: { goal: "wider" }, actor: AGENT });
    await repo.comment(SCOPE, { key, body: "self-approval attempt", reviewsEvent: out.event.eventId, actor: AGENT });
    await repo.comment(SCOPE, { key, body: "unrelated chatter", actor: USER });
    expect(openContractProposals(await repo.listEvents(SCOPE))).toHaveLength(1); // agents can't review themselves
  });
});

describe("reviewParkedKeys (honest degradation surfaces, P-7)", () => {
  it("collects merged-but-parked tasks and ignores plain in_review", async () => {
    const { repo, key } = await seed();
    // Merge with a gate orun has no record of → parked In Review.
    await repo.ingestObservation(SCOPE, {
      workspace: SCOPE.orgId,
      source: "github-webhook",
      sourceVersion: 1,
      kind: "pr_merged",
      at: "2026-07-09T01:00:00Z",
      dedupeKey: "pr:1",
      payload: { pr: "o/r#1", revision: "sha256:aa", taskKeys: [key] },
    });
    // Re-declare gates so the merge parks on an unknown gate.
    await repo.editContract(SCOPE, {
      key,
      contract: { goal: "g", affects: ["a"], doneWhen: ["d"], gates: ["tests"] },
      actor: USER,
    });
    const r = fold(await repo.getWorkSet(SCOPE));
    expect(r.lifecycles[key]!.rung).toBe("in_review");
    expect(reviewParkedKeys(r.lifecycles)).toEqual([key]);
  });
});

describe("recentMentions and foldAssignees", () => {
  it("returns mentioning comments newest first, capped", async () => {
    const { repo, key } = await seed();
    await repo.comment(SCOPE, { key, body: "no handles here", actor: USER });
    await repo.comment(SCOPE, { key, body: "@rahul first", actor: USER });
    await repo.comment(SCOPE, { key, body: "@team/platform second", actor: AGENT });
    const mentions = recentMentions(await repo.listEvents(SCOPE), 1);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.handles).toEqual(["team/platform"]);
  });

  it("folds assign/unassign into current seats — sp_ subjects included", async () => {
    const { repo, key } = await seed();
    await repo.assign(SCOPE, { key, subject: "usr_2", actor: USER });
    await repo.assign(SCOPE, { key, subject: "sp_agent", actor: USER });
    await repo.unassign(SCOPE, { key, subject: "usr_2", actor: USER });
    const assignees = foldAssignees(await repo.listEvents(SCOPE));
    expect(assignees.get(key)).toEqual(["sp_agent"]);
  });
});
