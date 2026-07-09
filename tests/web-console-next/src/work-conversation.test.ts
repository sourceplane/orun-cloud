// Pure-lib tests for the conversation helpers (orun-work-v3 PM1).

import { groupThreads, reactionCounts, timelineLabel } from "@web-console-next/lib/work/conversation";
import type { WorkEventView } from "@saas/contracts/work";

const ev = (id: string, kind: string, payload: Record<string, unknown>, actor = "usr_1"): WorkEventView => ({
  eventId: id,
  subject: "ORN-1",
  kind,
  actor: { type: "user", id: actor },
  at: "2026-07-09T00:00:00Z",
  payload,
  seq: 1,
});

describe("groupThreads", () => {
  it("nests replies under parents; unknown parents surface top-level", () => {
    const threads = groupThreads([
      ev("a", "comment_added", { body: "root" }),
      ev("b", "comment_added", { body: "reply", parentEvent: "a" }),
      ev("c", "comment_added", { body: "orphan", parentEvent: "ghost" }),
      ev("d", "pinned", { rung: "done" }),
    ]);
    expect(threads.map((t) => t.event.eventId)).toEqual(["a", "c"]);
    expect(threads[0]!.replies.map((r) => r.event.eventId)).toEqual(["b"]);
  });
});

describe("reactionCounts", () => {
  it("counts adds, cancels same-actor removals, never goes negative", () => {
    const counts = reactionCounts([
      ev("r1", "reaction_added", { targetEvent: "a", emoji: "👍" }, "u1"),
      ev("r2", "reaction_added", { targetEvent: "a", emoji: "👍" }, "u2"),
      ev("r3", "reaction_removed", { targetEvent: "a", emoji: "👍" }, "u1"),
      ev("r4", "reaction_removed", { targetEvent: "a", emoji: "🎉" }, "u3"),
    ]);
    expect(counts.get("a")?.get("👍")).toBe(1);
    expect(counts.get("a")?.get("🎉")).toBeUndefined();
  });
});

describe("timelineLabel", () => {
  it("labels comments by body, events by kind, observations by kind·source", () => {
    expect(timelineLabel({ at: "t", type: "event", event: ev("a", "comment_added", { body: "hi" }) })).toBe("hi");
    expect(timelineLabel({ at: "t", type: "event", event: ev("a", "doc_edited", {}) })).toBe("doc edited");
    expect(
      timelineLabel({
        at: "t",
        type: "observation",
        observation: { obsId: "o", source: "ci", kind: "pr_opened", at: "t", seq: 1 },
      }),
    ).toBe("pr_opened · ci");
  });
});
