// v4 hierarchy mutator discipline (orun-work-v4 WH1), proven on the
// in-memory repository (the two-log design taken literally). The Postgres
// repository mirrors these rules with the same validateEvent front door.

import { beforeEach, describe, expect, it } from "vitest";
import { MemoryWorkRepository } from "./memory.js";
import { foldDesignIntent, foldEpicIntent, foldMilestones, sealEpicSnapshot } from "./hierarchy.js";
import { type Actor, type Proposal } from "./model.js";

const scope = { orgId: "org-1" };
const human: Actor = { type: "user", id: "usr_rahul", via: "console" };
const agent: Actor = { type: "agent", id: "sp_designer", via: "mcp" };

let repo: MemoryWorkRepository;
let tick = 0;

beforeEach(() => {
  tick = 0;
  repo = new MemoryWorkRepository(() => `2026-07-11T10:00:${String(tick++ % 60).padStart(2, "0")}Z`);
});

async function epicWithMilestone(slug = "epic-a"): Promise<string> {
  await repo.createSpec(scope, { slug, title: "Epic A", actor: human });
  await repo.editMilestone(scope, { epicKey: slug, op: "create", key: "M1", title: "Foundation", actor: human });
  return slug;
}

describe("milestones", () => {
  it("create/edit/reorder/remove fold into the ladder", async () => {
    const epic = await epicWithMilestone();
    await repo.editMilestone(scope, { epicKey: epic, op: "create", key: "M2", title: "Surface", actor: human });
    await repo.editMilestone(scope, { epicKey: epic, op: "reorder", key: "M2", ordinal: -1, actor: human });
    const events = await repo.listEvents(scope);
    const ladder = foldMilestones(epic, events);
    expect(ladder.map((m) => m.key)).toEqual(["M2", "M1"]);
    await repo.editMilestone(scope, { epicKey: epic, op: "remove", key: "M2", actor: human });
    expect(foldMilestones(epic, await repo.listEvents(scope)).map((m) => m.key)).toEqual(["M1"]);
  });

  it("duplicate create is a conflict — keys are immutable", async () => {
    const epic = await epicWithMilestone();
    await expect(
      repo.editMilestone(scope, { epicKey: epic, op: "create", key: "M1", title: "Again", actor: human }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("remove with open tasks is a conflict verdict; canceled tasks do not block", async () => {
    const epic = await epicWithMilestone();
    const { key } = await repo.createTask(scope, {
      prefix: "WKA",
      specKey: epic,
      milestone: "M1",
      title: "in the milestone",
      actor: human,
    });
    await expect(
      repo.editMilestone(scope, { epicKey: epic, op: "remove", key: "M1", actor: human }),
    ).rejects.toMatchObject({ code: "conflict" });
    await repo.cancel(scope, { key, actor: human });
    await expect(
      repo.editMilestone(scope, { epicKey: epic, op: "remove", key: "M1", actor: human }),
    ).resolves.toBeDefined();
  });

  it("milestone_set validates the ladder and the epic (design §1.2)", async () => {
    const epic = await epicWithMilestone();
    const inbox = await repo.createTask(scope, { prefix: "WKB", title: "inbox task", actor: human });
    await expect(repo.setMilestone(scope, { key: inbox.key, milestone: "M1", actor: human })).rejects.toMatchObject({
      code: "invalid",
    });
    const t = await repo.createTask(scope, { prefix: "WKB", specKey: epic, title: "epic task", actor: human });
    await expect(repo.setMilestone(scope, { key: t.key, milestone: "M9", actor: human })).rejects.toMatchObject({
      code: "not_found",
    });
    await repo.setMilestone(scope, { key: t.key, milestone: "M1", actor: human });
    const { tasks } = repo.envelopes(scope);
    expect(tasks.find((x) => x.key === t.key)?.milestone).toBe("M1");
    await repo.setMilestone(scope, { key: t.key, milestone: null, actor: human });
    expect(repo.envelopes(scope).tasks.find((x) => x.key === t.key)?.milestone).toBeUndefined();
  });
});

describe("review and approval", () => {
  it("agents may review but never approve — server-side, both rejected as verdicts (V4-2)", async () => {
    const epic = await epicWithMilestone();
    await repo.requestReview(scope, { key: epic, actor: agent });
    await repo.submitVerdict(scope, { key: epic, verdict: "approve", actor: agent });
    await expect(repo.approve(scope, { key: epic, actor: agent })).rejects.toMatchObject({ code: "human_only" });
    await expect(repo.approve(scope, { key: epic, actor: { type: "automation", id: "auto" } })).rejects.toMatchObject({
      code: "human_only",
    });
  });

  it("approve requires a milestone ladder (V4-2: you approve doc AND ladder)", async () => {
    await repo.createSpec(scope, { slug: "bare-epic", title: "Bare", actor: human });
    await expect(repo.approve(scope, { key: "bare-epic", actor: human })).rejects.toMatchObject({ code: "invalid" });
  });

  it("approving a stale revision is a conflict — you approve bytes, not vibes", async () => {
    const epic = await epicWithMilestone();
    await repo.putDocRevision(scope, { specKey: epic, body: "# v2\n", actor: human });
    await expect(
      repo.approve(scope, { key: epic, revision: "sha256:stale", actor: human }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("approval folds Approved; later doc edit drifts; re-approval clears; revoke drops it", async () => {
    const epic = await epicWithMilestone();
    await repo.putDocRevision(scope, { specKey: epic, body: "# v1\n", actor: human });
    await repo.approve(scope, { key: epic, actor: human });
    let intent = await foldEpicIntent(epic, await repo.listEvents(scope));
    expect(intent.state).toBe("approved");
    expect(intent.approval?.by.id).toBe(human.id);

    await repo.putDocRevision(scope, { specKey: epic, body: "# v2\n", actor: human });
    intent = await foldEpicIntent(epic, await repo.listEvents(scope));
    expect(intent.state).toBe("approved_drifted");
    expect(intent.docDrifted).toBe(true);

    await repo.approve(scope, { key: epic, actor: human });
    intent = await foldEpicIntent(epic, await repo.listEvents(scope));
    expect(intent.state).toBe("approved");

    await repo.revokeApproval(scope, { key: epic, actor: human });
    intent = await foldEpicIntent(epic, await repo.listEvents(scope));
    expect(intent.state).toBe("draft");
    await expect(repo.revokeApproval(scope, { key: epic, actor: human })).rejects.toMatchObject({ code: "invalid" });
  });

  it("task churn under an approved epic never drifts approval (V4-5)", async () => {
    const epic = await epicWithMilestone();
    await repo.approve(scope, { key: epic, actor: human });
    const t = await repo.createTask(scope, { prefix: "WKC", specKey: epic, milestone: "M1", title: "t1", actor: agent });
    await repo.editContract(scope, {
      key: t.key,
      contract: { goal: "g", affects: ["a/b/c"], doneWhen: ["d"], gates: ["tests"] },
      actor: agent,
    });
    await repo.cancel(scope, { key: t.key, actor: agent });
    const intent = await foldEpicIntent(epic, await repo.listEvents(scope));
    expect(intent.state).toBe("approved");
  });

  it("minApprovals counts distinct human approve verdicts at the revision", async () => {
    const epic = await epicWithMilestone();
    await expect(repo.approve(scope, { key: epic, minApprovals: 2, actor: human })).rejects.toMatchObject({
      code: "invalid",
    });
    await repo.submitVerdict(scope, { key: epic, verdict: "approve", actor: { type: "user", id: "usr_other" } });
    // An agent's approve verdict is advice — it must NOT count.
    await repo.submitVerdict(scope, { key: epic, verdict: "approve", actor: agent });
    await expect(repo.approve(scope, { key: epic, minApprovals: 3, actor: human })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(repo.approve(scope, { key: epic, minApprovals: 2, actor: human })).resolves.toBeDefined();
  });
});

const proposal: Proposal = {
  epics: [
    {
      slug: "minted-epic",
      title: "Minted Epic",
      milestones: [
        { key: "M1", title: "First", goal: "start", ordinal: 0 },
        { key: "M2", title: "Second", ordinal: 1 },
      ],
      taskSkeletons: [
        { milestone: "M1", title: "seed task", contract: { goal: "g", affects: ["a/b/c"], doneWhen: ["d"], gates: [] } },
      ],
    },
    { slug: "second-epic", title: "Second Epic", milestones: [{ key: "S1", title: "Only", ordinal: 0 }] },
  ],
};

describe("designs", () => {
  async function initiativeWithDesign(): Promise<string> {
    await repo.createInitiative(scope, { slug: "ai-native-work", title: "AI-native work", actor: human });
    const { key } = await repo.createDesign(scope, {
      initiativeKey: "ai-native-work",
      title: "Design One",
      proposal,
      actor: agent, // agents propose designs — creation is not a decision
    });
    return key;
  }

  it("designs require an initiative and validate their proposal at write time", async () => {
    await expect(
      repo.createDesign(scope, { initiativeKey: "nope", title: "x", actor: agent }),
    ).rejects.toMatchObject({ code: "not_found" });
    await repo.createInitiative(scope, { slug: "init", title: "I", actor: human });
    await expect(
      repo.createDesign(scope, {
        initiativeKey: "init",
        title: "bad",
        proposal: { epics: [{ slug: "e", title: "E", taskSkeletons: [{ milestone: "GHOST1", title: "t" }] }] },
        actor: agent,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("adoption is human-only and mints epics, milestones, and tasks with via: adoption (V4-4)", async () => {
    const key = await initiativeWithDesign();
    await expect(repo.adoptDesign(scope, { key, actor: agent })).rejects.toMatchObject({ code: "human_only" });

    const outcome = await repo.adoptDesign(scope, { key, actor: human, taskPrefix: "WKD" });
    expect(outcome.minted).toEqual(["minted-epic", "second-epic"]);
    expect(outcome.tasks).toEqual(["WKD-1"]);

    const { specs, tasks } = repo.envelopes(scope);
    const minted = specs.find((s) => s.key === "minted-epic");
    expect(minted?.initiative).toBe("ai-native-work");
    const seeded = tasks.find((t) => t.key === "WKD-1");
    expect(seeded?.spec).toBe("minted-epic");
    expect(seeded?.milestone).toBe("M1");

    const events = await repo.listEvents(scope);
    const ladder = foldMilestones("minted-epic", events);
    expect(ladder.map((m) => m.key)).toEqual(["M1", "M2"]);
    for (const e of events.filter((x) => x.seq >= outcome.event.seq)) {
      expect(e.actor.via).toBe("adoption");
    }

    const intent = foldDesignIntent(key, events);
    expect(intent.state).toBe("adopted");
    expect(intent.minted).toEqual(["minted-epic", "second-epic"]);
    // Minted epics are Draft — adoption is not approval.
    const epicIntent = await foldEpicIntent("minted-epic", events);
    expect(epicIntent.state).toBe("draft");
  });

  it("partial adoption mints the chosen subset; collisions are conflicts", async () => {
    const key = await initiativeWithDesign();
    const outcome = await repo.adoptDesign(scope, { key, epics: ["second-epic"], actor: human });
    expect(outcome.minted).toEqual(["second-epic"]);
    // Re-adopting the same slug collides.
    await expect(repo.adoptDesign(scope, { key, epics: ["second-epic"], actor: human })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("supersede is human-only, terminal, and keeps the adoption record", async () => {
    const key = await initiativeWithDesign();
    await repo.adoptDesign(scope, { key, epics: ["second-epic"], actor: human });
    await expect(repo.supersedeDesign(scope, { key, actor: agent })).rejects.toMatchObject({ code: "human_only" });
    await repo.supersedeDesign(scope, { key, by: "DSG-2", actor: human });
    const intent = foldDesignIntent(key, await repo.listEvents(scope));
    expect(intent.state).toBe("superseded");
    expect(intent.supersededBy).toBe("DSG-2");
    expect(intent.minted).toEqual(["second-epic"]);
  });

  it("designs carry doc chains like epics (V4-6)", async () => {
    const key = await initiativeWithDesign();
    const put = await repo.putDocRevision(scope, { specKey: key, body: "# The design\n", actor: agent });
    expect(put.created).toBe(true);
    const design = await repo.getDesign(scope, key);
    expect(design.docRef).toBe(put.revision);
    const doc = await repo.getDocRevision(scope, key);
    expect(doc.body).toBe("# The design\n");
  });
});

describe("approval seals the frozen brief (WH4)", () => {
  it("approve mints a content-addressed EpicSnapshot in the same mutation and stamps it", async () => {
    const epic = await epicWithMilestone("sealed-epic");
    await repo.putDocRevision(scope, { specKey: epic, body: "# The doc\n", actor: human });
    const t = await repo.createTask(scope, {
      prefix: "WKS",
      specKey: epic,
      milestone: "M1",
      title: "sealed task",
      contract: { goal: "g", affects: ["a/b/c"], doneWhen: ["d"], gates: ["tests"] },
      actor: human,
    });
    const out = await repo.approve(scope, { key: epic, actor: human });
    expect(out.snapshot).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((out.event.payload as { snapshot?: string }).snapshot).toBe(out.snapshot);

    const brief = await repo.getEpicBrief(scope, epic);
    expect(brief.id).toBe(out.snapshot);
    // Content addressing: the id IS the hash of the bytes.
    const bytes = new TextEncoder().encode(brief.canonical);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    let hex = "";
    for (const b of new Uint8Array(hash)) hex += b.toString(16).padStart(2, "0");
    expect(`sha256:${hex}`).toBe(brief.id);

    const parsed = JSON.parse(brief.canonical) as {
      kind: string;
      spec: { key: string; docRef?: string };
      milestones: { key: string }[];
      tasks: { key: string; contract?: unknown }[];
      ladderHash: string;
      approval: { by: { id: string }; revision?: string };
      coordSeq: number;
    };
    expect(parsed.kind).toBe("EpicSnapshot");
    expect(parsed.spec.key).toBe(epic);
    expect(parsed.milestones.map((m) => m.key)).toEqual(["M1"]);
    expect(parsed.tasks.map((x) => x.key)).toEqual([t.key]);
    expect(parsed.approval.by.id).toBe(human.id);
    expect(parsed.ladderHash).toMatch(/^sha256:/);
    // The intent plane cannot carry fold output (invariant 1).
    for (const token of ['"rung"', '"lifecycle"', '"assignees"', '"pinned"']) {
      expect(brief.canonical.includes(token)).toBe(false);
    }
    // The approved event folds with the snapshot id attached.
    const intent = await foldEpicIntent(epic, await repo.listEvents(scope));
    expect(intent.approval?.snapshot).toBe(out.snapshot);
  });

  it("sealing is deterministic: identical inputs seal to identical ids", async () => {
    const input = {
      spec: {
        apiVersion: "orun.io/v1",
        kind: "Spec" as const,
        key: "det-epic",
        workspace: "org-1",
        title: "Det",
        createdBy: human,
        createdAt: "2026-07-11T10:00:00Z",
      },
      milestones: [{ key: "M1", title: "One", ordinal: 0 }],
      tasks: [],
      approval: { revision: "sha256:abc", by: human, at: "2026-07-11T10:00:01Z" },
      coordSeq: 5,
      obsSeq: 2,
    };
    const a = await sealEpicSnapshot(input);
    const b = await sealEpicSnapshot(input);
    expect(a.id).toBe(b.id);
    expect(a.canonical).toBe(b.canonical);
    const c = await sealEpicSnapshot({ ...input, milestones: [{ key: "M1", title: "One (renamed)", ordinal: 0 }] });
    expect(c.id).not.toBe(a.id);
  });

  it("the brief 404s before any approval", async () => {
    const epic = await epicWithMilestone("unapproved-epic");
    await expect(repo.getEpicBrief(scope, epic)).rejects.toMatchObject({ code: "not_found" });
  });
});
