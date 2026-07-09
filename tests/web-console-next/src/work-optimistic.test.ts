// Optimistic apply store tests (orun-work-v3 PM4) — the pure lib only. The
// contract under test IS the honesty property: the overlay renders intent
// instantly, but only the server's seq commits it, and a rejection makes the
// fold's last answer show through again (rollback). A patch cannot carry a
// rung — the type has no such field; these tests pin the behavior around it.

import type { WorkTaskView } from "@saas/contracts/work";
import { applyPatch, begin, confirm, overlay, prune, reject, type OptimisticEntry } from "@web-console-next/lib/work/optimistic";

function task(key: string, extra: Partial<WorkTaskView> = {}): WorkTaskView {
  return {
    key,
    title: key,
    createdBy: { type: "user", id: "usr_1" },
    lifecycle: { rung: "ready", ready: true, blocked: false },
    ...extra,
  } as WorkTaskView;
}

describe("applyPatch", () => {
  it("sets and clears the intent fields; none clears priority", () => {
    const t = task("ORN-1", { tags: ["a"], estimate: 3 });
    expect(applyPatch(t, { priority: "high" }).priority).toBe("high");
    expect(applyPatch(t, { priority: "none" }).priority).toBeUndefined();
    expect(applyPatch(t, { estimate: null }).estimate).toBeUndefined();
    expect(applyPatch(t, { cycleKey: "CYC-1" }).cycleKey).toBe("CYC-1");
    expect(applyPatch(t, { addTag: "b" }).tags).toEqual(["a", "b"]);
    expect(applyPatch(t, { removeTag: "a" }).tags).toBeUndefined();
  });

  it("never touches the lifecycle (the patch type has no rung)", () => {
    const t = task("ORN-1");
    const patched = applyPatch(t, { priority: "urgent", addTag: "x" });
    expect(patched.lifecycle).toEqual(t.lifecycle);
  });
});

describe("the begin → confirm → prune lifecycle (SSE catch-up)", () => {
  it("renders intent immediately and prunes once coordSeq reaches the seq", () => {
    let entries: OptimisticEntry[] = [];
    const res = begin(entries, "ORN-1", { priority: "urgent" });
    entries = res.entries;

    let tasks = overlay([task("ORN-1")], entries);
    expect(tasks[0]!.priority).toBe("urgent"); // instant

    entries = confirm(entries, res.id, 42);
    expect(prune(entries, 41)).toHaveLength(1); // server not caught up yet
    expect(prune(entries, 42)).toHaveLength(0); // the fold now includes it

    tasks = overlay([task("ORN-1", { priority: "urgent" })], prune(entries, 42));
    expect(tasks[0]!.priority).toBe("urgent"); // now server truth, no overlay
  });

  it("in-flight entries (no seq yet) survive any prune", () => {
    const { entries } = begin([], "ORN-1", { estimate: 5 });
    expect(prune(entries, 9999)).toHaveLength(1);
  });

  it("reject rolls the overlay back — the fold's answer shows through", () => {
    const { entries, id } = begin([], "ORN-1", { priority: "urgent" });
    expect(overlay([task("ORN-1")], entries)[0]!.priority).toBe("urgent");
    const rolledBack = reject(entries, id);
    expect(overlay([task("ORN-1")], rolledBack)[0]!.priority).toBeUndefined();
  });

  it("stacks multiple pending patches for one task in order", () => {
    let entries: OptimisticEntry[] = [];
    entries = begin(entries, "ORN-1", { addTag: "a" }).entries;
    entries = begin(entries, "ORN-1", { addTag: "b" }).entries;
    entries = begin(entries, "ORN-2", { priority: "low" }).entries;
    const tasks = overlay([task("ORN-1"), task("ORN-2")], entries);
    expect(tasks[0]!.tags).toEqual(["a", "b"]);
    expect(tasks[1]!.priority).toBe("low");
  });
});
