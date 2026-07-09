// Board helper tests (orun-work-v3 PM2) — the pure lib only, per the
// console test convention. Columns are rungs, filters are AND-of-ORs, and
// the drop classifier is the honest-gesture table executable: cross-column
// is a pin, same-column is an order, dropping back on truth unpins.

import type { WorkTaskView } from "@saas/contracts/work";
import {
  allTags,
  applyFilters,
  boardColumns,
  boardRung,
  dropIntent,
  hasActiveFilters,
  toggled,
  toViewConfig,
  BOARD_RUNGS,
} from "@web-console-next/lib/work/board";

function task(partial: Partial<WorkTaskView> & { key: string }): WorkTaskView {
  return {
    title: partial.key,
    createdBy: { type: "user", id: "usr_1" },
    lifecycle: { rung: "draft", ready: false, blocked: false },
    ...partial,
  } as WorkTaskView;
}

describe("boardColumns", () => {
  it("groups by rung in ladder order and sorts by priority then key", () => {
    const tasks = [
      task({ key: "ORN-2", lifecycle: { rung: "ready", ready: true, blocked: false } }),
      task({ key: "ORN-1", lifecycle: { rung: "ready", ready: true, blocked: false }, priority: "urgent" }),
      task({ key: "ORN-3", lifecycle: { rung: "done", ready: true, blocked: false } }),
    ];
    const columns = boardColumns(tasks);
    expect(columns.map((c) => c.rung)).toEqual(BOARD_RUNGS);
    const ready = columns.find((c) => c.rung === "ready")!;
    expect(ready.tasks.map((t) => t.key)).toEqual(["ORN-1", "ORN-2"]); // urgent first
    expect(columns.find((c) => c.rung === "done")!.tasks).toHaveLength(1);
  });

  it("renders a pinned card in its pinned column (pin-beside-truth)", () => {
    const pinned = task({
      key: "ORN-9",
      lifecycle: {
        rung: "in_review",
        ready: true,
        blocked: false,
        pinned: { rung: "done", by: { type: "user", id: "usr_1" } },
      },
    });
    expect(boardRung(pinned)).toBe("done");
    const columns = boardColumns([pinned]);
    expect(columns.find((c) => c.rung === "done")!.tasks.map((t) => t.key)).toEqual(["ORN-9"]);
    expect(columns.find((c) => c.rung === "in_review")!.tasks).toHaveLength(0);
  });
});

describe("filters", () => {
  const tasks = [
    task({ key: "ORN-1", tags: ["infra"], priority: "high" }),
    task({ key: "ORN-2", tags: ["api"] }),
    task({ key: "ORN-3", spec: "checkout", lifecycle: { rung: "done", ready: true, blocked: false } }),
  ];

  it("ANDs across dimensions and ORs within one", () => {
    expect(applyFilters(tasks, { tags: ["infra", "api"] }).map((t) => t.key)).toEqual(["ORN-1", "ORN-2"]);
    expect(applyFilters(tasks, { tags: ["infra"], priority: ["high"] }).map((t) => t.key)).toEqual(["ORN-1"]);
    expect(applyFilters(tasks, { tags: ["infra"], priority: ["low"] })).toHaveLength(0);
    expect(applyFilters(tasks, { rung: ["done"] }).map((t) => t.key)).toEqual(["ORN-3"]);
    expect(applyFilters(tasks, {})).toHaveLength(3);
  });

  it("treats missing priority as none", () => {
    expect(applyFilters(tasks, { priority: ["none"] }).map((t) => t.key)).toEqual(["ORN-2", "ORN-3"]);
  });

  it("toggled adds, removes, and collapses to undefined", () => {
    expect(toggled(undefined, "a")).toEqual(["a"]);
    expect(toggled(["a"], "b")).toEqual(["a", "b"]);
    expect(toggled(["a"], "a")).toBeUndefined();
  });

  it("collects the tag universe sorted", () => {
    expect(allTags(tasks)).toEqual(["api", "infra"]);
  });

  it("serializes only active filters into a view config", () => {
    expect(toViewConfig("board", {})).toEqual({ layout: "board" });
    expect(hasActiveFilters({ tags: ["x"] })).toBe(true);
    expect(toViewConfig("list", { tags: ["x"] })).toEqual({ layout: "list", filters: { tags: ["x"] } });
  });
});

describe("dropIntent (the honest-gesture table, executable)", () => {
  const plain = task({ key: "ORN-1", lifecycle: { rung: "ready", ready: true, blocked: false } });
  const pinned = task({
    key: "ORN-2",
    lifecycle: {
      rung: "in_review",
      ready: true,
      blocked: false,
      pinned: { rung: "done", by: { type: "user", id: "usr_1" } },
    },
  });

  it("same column → order (pure backlog intent)", () => {
    expect(dropIntent(plain, "ready")).toEqual({ kind: "order" });
  });

  it("another column → pin (attributed override beside truth)", () => {
    expect(dropIntent(plain, "done")).toEqual({ kind: "pin", rung: "done" });
  });

  it("dropping a pinned card back on the fold's own column → unpin", () => {
    expect(dropIntent(pinned, "in_review")).toEqual({ kind: "unpin" });
  });

  it("reordering within the pinned column stays an order", () => {
    expect(dropIntent(pinned, "done")).toEqual({ kind: "order" });
  });
});
