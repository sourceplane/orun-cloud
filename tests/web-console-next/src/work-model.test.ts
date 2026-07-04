// Work-lens presentation model (orun-work v2 WP1) — pure logic only, per the
// console test convention (no React render harness).

import { groupTasksBySpec, rungBadgeVariant, rungLabel } from "@web-console-next/lib/work/model";
import type { WorkTaskView } from "@saas/contracts/work";

function task(key: string, spec: string | undefined, rung: WorkTaskView["lifecycle"]["rung"]): WorkTaskView {
  return {
    key,
    spec,
    title: key,
    createdBy: { type: "user", id: "usr_1" },
    lifecycle: { rung, ready: false, blocked: false },
  };
}

describe("work model", () => {
  it("labels and badges every rung", () => {
    expect(rungLabel("in_review")).toBe("In Review");
    expect(rungBadgeVariant("released")).toBe("success");
    expect(rungBadgeVariant("canceled")).toBe("outline");
    expect(rungBadgeVariant("ready")).toBe("secondary");
  });

  it("groups by spec with the inbox last, most-delivered rung first", () => {
    const groups = groupTasksBySpec([
      task("ORN-1", "b-spec", "draft"),
      task("ORN-2", "a-spec", "ready"),
      task("ORN-3", "a-spec", "released"),
      task("ORN-4", undefined, "in_review"),
    ]);
    expect(groups.map((g) => g.spec)).toEqual(["a-spec", "b-spec", null]);
    expect(groups[0]!.tasks.map((t) => t.key)).toEqual(["ORN-3", "ORN-2"]);
  });
});
