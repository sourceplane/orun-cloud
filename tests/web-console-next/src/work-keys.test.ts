// Work-home keyboard grammar tests (orun-work-v5 WV5) — the pure key map
// plus the palette-wording invariant: there is a verb that pins and a verb
// that creates; there is NO verb that "marks as" anything (design.md §4 —
// the vocabulary of the keyboard is the vocabulary of the model).

import {
  createKindForLens,
  isEditableTarget,
  nextNavIndex,
  workKeyAction,
} from "@web-console-next/lib/work/keys";
import { buildBaseCommands } from "@web-console-next/components/shell/command-registry";

const plain = { metaKey: false, ctrlKey: false, altKey: false };

describe("workKeyAction", () => {
  it("1/2/3 switch lens; j/k and arrows rove; c/f/d act", () => {
    expect(workKeyAction({ key: "1", ...plain })).toEqual({ type: "lens", lens: "initiatives" });
    expect(workKeyAction({ key: "2", ...plain })).toEqual({ type: "lens", lens: "epics" });
    expect(workKeyAction({ key: "3", ...plain })).toEqual({ type: "lens", lens: "tasks" });
    expect(workKeyAction({ key: "j", ...plain })).toEqual({ type: "focus-next" });
    expect(workKeyAction({ key: "ArrowUp", ...plain })).toEqual({ type: "focus-prev" });
    expect(workKeyAction({ key: "c", ...plain })).toEqual({ type: "create" });
    expect(workKeyAction({ key: "f", ...plain })).toEqual({ type: "filter" });
    expect(workKeyAction({ key: "d", ...plain })).toEqual({ type: "display" });
    expect(workKeyAction({ key: "x", ...plain })).toBeNull();
  });

  it("yields to modifier chords and editable targets", () => {
    expect(workKeyAction({ key: "1", metaKey: true, ctrlKey: false, altKey: false })).toBeNull();
    expect(workKeyAction({ key: "c", ...plain }, { tagName: "INPUT" })).toBeNull();
    expect(workKeyAction({ key: "c", ...plain }, { tagName: "div", isContentEditable: true })).toBeNull();
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "LI" })).toBe(false);
  });

  it("creation follows attention: c creates for the current lens", () => {
    expect(createKindForLens("initiatives")).toBe("initiative");
    expect(createKindForLens("epics")).toBe("spec");
    expect(createKindForLens("tasks")).toBe("task");
  });

  it("roving focus clamps at the edges (no wrap)", () => {
    expect(nextNavIndex(-1, 1, 5)).toBe(0);
    expect(nextNavIndex(-1, -1, 5)).toBe(4);
    expect(nextNavIndex(4, 1, 5)).toBe(4);
    expect(nextNavIndex(0, -1, 5)).toBe(0);
    expect(nextNavIndex(2, 1, 0)).toBe(-1);
  });
});

describe("⌘K Work verbs (U5 registry)", () => {
  const ctx = {
    orgSlug: "acme",
    projectSlug: null,
    isLocked: false,
    targets: [],
    hasSession: true,
  } as Parameters<typeof buildBaseCommands>[0];

  it("registers the three lenses as navigation verbs", () => {
    const ids = buildBaseCommands(ctx).map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining(["nav.work-initiatives", "nav.work-epics", "nav.work-tasks"]),
    );
    const lensVerb = buildBaseCommands(ctx).find((c) => c.id === "nav.work-epics");
    expect(lensVerb?.kind).toBe("navigate");
    if (lensVerb?.kind === "navigate") expect(lensVerb.to).toContain("lens=epics");
  });

  it("no verb can write a rung: nothing is worded 'Mark as…' or 'Set status…'", () => {
    for (const c of buildBaseCommands(ctx)) {
      expect(c.label).not.toMatch(/mark as/i);
      expect(c.label).not.toMatch(/set status/i);
      expect(c.label).not.toMatch(/move to (done|released|review)/i);
    }
  });
});
