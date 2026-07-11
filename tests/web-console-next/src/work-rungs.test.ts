// Work-plane rung glyph tests (orun-work-v5 WV0) — the pure lib plus the
// derived-rendering invariants: RungIcon is a pure function of the fold
// output (V5-E), and a pin renders BESIDE observed truth, never instead of
// it (WV-3).

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkLifecycleView, WorkRung } from "@saas/contracts/work";
import {
  RUNG_LADDER,
  arcDasharray,
  meterSegments,
  milestoneDiamondState,
  pinIntent,
  rungGlyph,
  truthSourceTag,
} from "@web-console-next/lib/work/rungs";
import {
  MilestoneDiamond,
  PinBadge,
  RungIcon,
  TaskRungMark,
  WorkMeter,
} from "@web-console-next/components/ui/northwind-work";

describe("rungGlyph", () => {
  it("walks the ladder: dashed → ring → ½ arc → ¾ arc → disc → disc", () => {
    expect(RUNG_LADDER).toEqual(["draft", "ready", "in_progress", "in_review", "done", "released"]);
    expect(rungGlyph("draft")).toEqual({ kind: "dashed", fraction: 0 });
    expect(rungGlyph("ready")).toEqual({ kind: "ring", fraction: 0 });
    expect(rungGlyph("in_progress")).toEqual({ kind: "arc", fraction: 0.5 });
    expect(rungGlyph("in_review")).toEqual({ kind: "arc", fraction: 0.75 });
    expect(rungGlyph("done")).toEqual({ kind: "disc", fraction: 1 });
    expect(rungGlyph("released")).toEqual({ kind: "disc", fraction: 1 });
    expect(rungGlyph("canceled").kind).toBe("cross");
  });

  it("emits the mock's exact arc dasharrays (½ → 17 34, ¾ → 25.4 34)", () => {
    expect(arcDasharray(0.5)).toBe("17 34");
    expect(arcDasharray(0.75)).toBe("25.4 34");
  });
});

describe("meterSegments", () => {
  it("splits landed (done+released) from in-flight (in_progress+in_review)", () => {
    const seg = meterSegments({ released: 3, done: 3, in_progress: 2, in_review: 1 }, 14);
    expect(seg.doneCount).toBe(6);
    expect(seg.donePct).toBeCloseTo((6 / 14) * 100);
    expect(seg.activePct).toBeCloseTo((3 / 14) * 100);
  });

  it("clamps: segments never exceed 100% together, zero total renders empty", () => {
    const seg = meterSegments({ done: 9, in_progress: 9 }, 10);
    expect(seg.donePct + seg.activePct).toBeLessThanOrEqual(100);
    expect(meterSegments({ done: 3 }, 0)).toEqual({ donePct: 0, activePct: 0, doneCount: 0 });
  });
});

describe("milestoneDiamondState", () => {
  it("folds complete / active / upcoming from counts", () => {
    expect(milestoneDiamondState({ released: 3 }, 3)).toBe("complete");
    expect(milestoneDiamondState({ done: 1, in_progress: 1 }, 3)).toBe("active");
    expect(milestoneDiamondState({}, 2)).toBe("upcoming");
    expect(milestoneDiamondState({}, 0)).toBe("upcoming");
  });
});

function iconHtml(rung: WorkRung): string {
  return renderToStaticMarkup(React.createElement(RungIcon, { rung }));
}

describe("RungIcon — a pure function of the fold output (V5-E)", () => {
  it("draft renders the dashed ring", () => {
    const html = iconHtml("draft");
    expect(html).toContain('stroke-dasharray="2.4 2.6"');
    expect(html).toContain('data-rung="draft"');
  });

  it("ready renders the empty ring (no dasharray, no fill)", () => {
    const html = iconHtml("ready");
    expect(html).not.toContain("stroke-dasharray");
    expect(html).toContain('fill="none"');
  });

  it("in_progress renders the half arc on the amber pair", () => {
    const html = iconHtml("in_progress");
    expect(html).toContain('stroke-dasharray="17 34"');
    expect(html).toContain("--warning-accent");
    expect(html).toContain('transform="rotate(-90 7 7)"');
  });

  it("in_review renders the three-quarter arc on the info pair", () => {
    const html = iconHtml("in_review");
    expect(html).toContain('stroke-dasharray="25.4 34"');
    expect(html).toContain("--info");
  });

  it("done and released render filled discs with checks, released in green", () => {
    expect(iconHtml("done")).toContain("--primary");
    expect(iconHtml("done")).toContain("M4.4 7.3");
    expect(iconHtml("released")).toContain("--success");
  });

  it("labels every glyph for assistive tech", () => {
    expect(iconHtml("in_progress")).toContain('aria-label="In Progress"');
  });
});

describe("TaskRungMark — pin beside truth (WV-3)", () => {
  const pinned: WorkLifecycleView = {
    rung: "in_progress",
    ready: true,
    blocked: false,
    pinned: { rung: "done", by: { type: "user", id: "elena" } },
  };

  it("renders the OBSERVED glyph unconditionally when pinned, plus the badge", () => {
    const html = renderToStaticMarkup(React.createElement(TaskRungMark, { lifecycle: pinned }));
    expect(html).toContain('data-rung="in_progress"'); // observed, not the pin's rung
    expect(html).toContain('data-pin="done"');
    expect(html).toContain("pinned done · elena");
  });

  it("renders no badge without a pin", () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskRungMark, { lifecycle: { rung: "ready", ready: true, blocked: false } }),
    );
    expect(html).not.toContain("data-pin");
  });

  it("PinBadge carries the pin note as a title", () => {
    const html = renderToStaticMarkup(
      React.createElement(PinBadge, {
        pin: { rung: "done", by: { type: "user", id: "elena" }, note: "verified manually" },
      }),
    );
    expect(html).toContain("verified manually");
  });
});

describe("MilestoneDiamond / WorkMeter", () => {
  it("diamond states: complete filled, active amber outline, upcoming gray outline", () => {
    const complete = renderToStaticMarkup(React.createElement(MilestoneDiamond, { state: "complete" }));
    const active = renderToStaticMarkup(React.createElement(MilestoneDiamond, { state: "active" }));
    const upcoming = renderToStaticMarkup(React.createElement(MilestoneDiamond, { state: "upcoming" }));
    expect(complete).toContain("--success");
    expect(active).toContain("--warning-accent");
    expect(upcoming).toContain("--work-outline");
    expect(complete).toContain('transform="rotate(45 7 7)"');
  });

  it("meter renders its arithmetic beside the bar (WV-2)", () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkMeter, { donePct: 43, activePct: 21, fraction: "6/14" }),
    );
    expect(html).toContain("6/14");
    expect(html).toContain("width:43%");
    expect(html).toContain("width:21%");
  });
});

describe("pinIntent / truthSourceTag (§3.6 — WV3)", () => {
  const observed = { rung: "in_progress" as const };
  const pinned = {
    rung: "in_progress" as const,
    pinned: { rung: "done" as const, by: { id: "elena" } },
  };

  it("clicking another rung mints a pin; the observed rung is a no-op", () => {
    expect(pinIntent("done", observed)).toEqual({ rung: "done" });
    expect(pinIntent("in_progress", observed)).toBeNull();
  });

  it("clicking the pinned rung (or observed truth) clears the pin", () => {
    expect(pinIntent("done", pinned)).toEqual({ rung: null });
    expect(pinIntent("in_progress", pinned)).toEqual({ rung: null });
    expect(pinIntent("ready", pinned)).toEqual({ rung: "ready" });
  });

  it("the truth-source tag is never absent: observed or attributed pin", () => {
    expect(truthSourceTag(observed)).toBe("observed");
    expect(truthSourceTag(pinned)).toBe("pinned by elena");
  });
});
