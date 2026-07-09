// PM2 board-intent tests (orun-work-v3): labels, priority, estimates, typed
// relations, and saved views against the in-memory repository. Everything a
// mutator writes here is pure intent — the tests assert the envelopes replay
// from the log alone (invariant 1) and that `blocks` relations derive the
// blocked flag in the fold without any stored state.

import { describe, expect, it } from "vitest";
import { MemoryWorkRepository } from "./memory.js";
import { WorkError, fold } from "./model.js";

const SCOPE = { orgId: "org-1" };
const USER = { type: "user" as const, id: "usr_1" };
const clock = () => "2026-07-09T00:00:00Z";

async function repoWithTask() {
  const repo = new MemoryWorkRepository(clock);
  const { key } = await repo.createTask(SCOPE, { prefix: "ORN", title: "board fodder", actor: USER });
  return { repo, key };
}

describe("labels (free-form workspace tags)", () => {
  it("labeled/unlabeled fold into a sorted, deduped tag set", async () => {
    const { repo, key } = await repoWithTask();
    await repo.label(SCOPE, { key, label: "infra", actor: USER });
    await repo.label(SCOPE, { key, label: "api", actor: USER });
    await repo.label(SCOPE, { key, label: "infra", actor: USER }); // idempotent re-add
    let task = repo.envelopes(SCOPE).tasks[0]!;
    expect(task.tags).toEqual(["api", "infra"]);

    await repo.unlabel(SCOPE, { key, label: "infra", actor: USER });
    task = repo.envelopes(SCOPE).tasks[0]!;
    expect(task.tags).toEqual(["api"]);
  });

  it("rejects empty labels and unknown tasks with typed verdicts", async () => {
    const { repo, key } = await repoWithTask();
    await expect(repo.label(SCOPE, { key, label: "  ", actor: USER })).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.label(SCOPE, { key: "ORN-99", label: "x", actor: USER })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("priority and estimate (pure intent — never a rung)", () => {
  it("prioritized folds onto the envelope; none clears", async () => {
    const { repo, key } = await repoWithTask();
    await repo.prioritize(SCOPE, { key, priority: "urgent", actor: USER });
    expect(repo.envelopes(SCOPE).tasks[0]!.priority).toBe("urgent");
    await repo.prioritize(SCOPE, { key, priority: "none", actor: USER });
    expect(repo.envelopes(SCOPE).tasks[0]!.priority).toBeUndefined();
    await expect(
      repo.prioritize(SCOPE, { key, priority: "asap" as never, actor: USER }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("estimated folds points; null clears; negatives rejected", async () => {
    const { repo, key } = await repoWithTask();
    await repo.estimate(SCOPE, { key, points: 5, actor: USER });
    expect(repo.envelopes(SCOPE).tasks[0]!.estimate).toBe(5);
    await repo.estimate(SCOPE, { key, points: null, actor: USER });
    expect(repo.envelopes(SCOPE).tasks[0]!.estimate).toBeUndefined();
    await expect(repo.estimate(SCOPE, { key, points: -1, actor: USER })).rejects.toMatchObject({ code: "invalid" });
  });

  it("priority does not move the rung (the fold never reads it)", async () => {
    const { repo, key } = await repoWithTask();
    await repo.prioritize(SCOPE, { key, priority: "urgent", actor: USER });
    const ws = await repo.getWorkSet(SCOPE);
    expect(fold(ws).lifecycles[key]!.rung).toBe("draft");
  });
});

describe("typed relations (blocks|parent|relates)", () => {
  it("related/unrelated fold onto the subject task's envelope", async () => {
    const repo = new MemoryWorkRepository(clock);
    const a = (await repo.createTask(SCOPE, { prefix: "ORN", title: "a", actor: USER })).key;
    const b = (await repo.createTask(SCOPE, { prefix: "ORN", title: "b", actor: USER })).key;
    await repo.relate(SCOPE, { key: a, rel: "blocks", target: b, actor: USER });
    await repo.relate(SCOPE, { key: a, rel: "relates", target: b, actor: USER });
    let task = repo.envelopes(SCOPE).tasks.find((t) => t.key === a)!;
    expect(task.relations).toEqual([
      { rel: "blocks", target: b },
      { rel: "relates", target: b },
    ]);
    await repo.unrelate(SCOPE, { key: a, rel: "blocks", target: b, actor: USER });
    task = repo.envelopes(SCOPE).tasks.find((t) => t.key === a)!;
    expect(task.relations).toEqual([{ rel: "relates", target: b }]);
  });

  it("a blocks relation raises the target's blocked flag; unrelate clears it", async () => {
    const repo = new MemoryWorkRepository(clock);
    const blocker = (await repo.createTask(SCOPE, { prefix: "ORN", title: "blocker", actor: USER })).key;
    const blocked = (await repo.createTask(SCOPE, { prefix: "ORN", title: "blocked", actor: USER })).key;
    await repo.relate(SCOPE, { key: blocker, rel: "blocks", target: blocked, actor: USER });
    let r = fold(await repo.getWorkSet(SCOPE));
    expect(r.lifecycles[blocked]!.blocked).toBe(true);
    expect(r.lifecycles[blocker]!.blocked).toBe(false);

    await repo.unrelate(SCOPE, { key: blocker, rel: "blocks", target: blocked, actor: USER });
    r = fold(await repo.getWorkSet(SCOPE));
    expect(r.lifecycles[blocked]!.blocked).toBe(false);
  });

  it("a canceled blocker does not block", async () => {
    const repo = new MemoryWorkRepository(clock);
    const blocker = (await repo.createTask(SCOPE, { prefix: "ORN", title: "blocker", actor: USER })).key;
    const blocked = (await repo.createTask(SCOPE, { prefix: "ORN", title: "blocked", actor: USER })).key;
    await repo.relate(SCOPE, { key: blocker, rel: "blocks", target: blocked, actor: USER });
    await repo.cancel(SCOPE, { key: blocker, actor: USER });
    expect(fold(await repo.getWorkSet(SCOPE)).lifecycles[blocked]!.blocked).toBe(false);
  });

  it("rejects self-relations, unknown rels, and unknown targets", async () => {
    const { repo, key } = await repoWithTask();
    await expect(repo.relate(SCOPE, { key, rel: "blocks", target: key, actor: USER })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      repo.relate(SCOPE, { key, rel: "duplicate" as never, target: "ORN-9", actor: USER }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.relate(SCOPE, { key, rel: "blocks", target: "ORN-9", actor: USER })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("relations may join non-task items (initiative → spec membership)", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.createInitiative(SCOPE, { slug: "q3", title: "Q3", actor: USER });
    await repo.createSpec(SCOPE, { slug: "checkout", title: "Checkout", actor: USER });
    const out = await repo.relate(SCOPE, { key: "q3", rel: "parent", target: "checkout", actor: USER });
    expect(out.event.kind).toBe("related");
  });
});

describe("every board mutation appends exactly one coordination event (WP-6)", () => {
  it("counts one event per verb", async () => {
    const { repo, key } = await repoWithTask();
    const before = (await repo.listEvents(SCOPE)).length;
    await repo.label(SCOPE, { key, label: "x", actor: USER });
    await repo.prioritize(SCOPE, { key, priority: "high", actor: USER });
    await repo.estimate(SCOPE, { key, points: 3, actor: USER });
    const after = (await repo.listEvents(SCOPE)).length;
    expect(after - before).toBe(3);
  });
});

describe("saved views (workspace UI intent — beside the logs, no event)", () => {
  it("upserts by key, preserves provenance, lists sorted", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.saveView(SCOPE, {
      key: "my-board",
      name: "My board",
      config: { layout: "board", filters: { tags: ["infra"] } },
      actor: USER,
    });
    const updated = await repo.saveView(SCOPE, {
      key: "my-board",
      name: "Infra board",
      config: { layout: "board" },
      actor: { type: "user", id: "usr_2" },
    });
    expect(updated.name).toBe("Infra board");
    expect(updated.createdBy.id).toBe("usr_1"); // first author sticks
    const views = await repo.listViews(SCOPE);
    expect(views).toHaveLength(1);
    expect(views[0]!.config).toEqual({ layout: "board" });
  });

  it("appends no coordination event (there is no view kind)", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.saveView(SCOPE, { key: "v", name: "V", config: { layout: "list" }, actor: USER });
    expect(await repo.listEvents(SCOPE)).toHaveLength(0);
  });

  it("rejects bad keys and empty names", async () => {
    const repo = new MemoryWorkRepository(clock);
    await expect(
      repo.saveView(SCOPE, { key: "Bad Key", name: "x", config: { layout: "list" }, actor: USER }),
    ).rejects.toBeInstanceOf(WorkError);
    await expect(
      repo.saveView(SCOPE, { key: "ok", name: " ", config: { layout: "list" }, actor: USER }),
    ).rejects.toBeInstanceOf(WorkError);
  });
});
