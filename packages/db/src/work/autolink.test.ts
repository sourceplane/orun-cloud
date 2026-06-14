import { describe, expect, it } from "vitest";
import {
  applyAutoLinkPlan,
  AUTOLINK_ACTOR,
  computeAutoLinkPlan,
  materializeAffects,
  parseTaskKeys,
  type AutoLinkPlan,
  type AutoLinkRepo,
  type PullRequestContext,
  type TaskView,
} from "./autolink.js";
import type { CommitOutcome, LinkInput, SetStatusInput, WorkResult } from "./types.js";
import type { WorkEvent } from "./model.js";

const pr = (over: Partial<PullRequestContext> = {}): PullRequestContext => ({
  ref: "sourceplane/orun#412",
  title: "Route catalog reads through objcatalog",
  branch: "feature/route-catalog",
  phase: "opened",
  ...over,
});

const task = (key: string, status: TaskView["status"], affects: string[]): TaskView => ({ key, status, affects });

describe("auto-linker — matching (W2)", () => {
  it("links a task by component overlap and moves backlog → in_progress on open", () => {
    const tasks = [task("ORN-1", "backlog", ["sourceplane/orun/api-edge"])];
    const plan = computeAutoLinkPlan(pr(), ["sourceplane/orun/api-edge", "sourceplane/orun/web"], tasks, "ORN");

    expect(plan.links).toEqual([
      { taskKey: "ORN-1", pr: "sourceplane/orun#412", reason: "component_overlap", matchedComponents: ["sourceplane/orun/api-edge"] },
    ]);
    expect(plan.transitions).toEqual([{ taskKey: "ORN-1", from: "backlog", to: "in_progress" }]);
  });

  it("links a task by key parse from the branch even with no component overlap", () => {
    const tasks = [task("ORN-142", "todo", ["unrelated/comp/x"])];
    const plan = computeAutoLinkPlan(
      pr({ branch: "feature/ORN-142-route-catalog", title: "no key here" }),
      ["sourceplane/orun/api-edge"],
      tasks,
      "ORN",
    );
    expect(plan.links).toEqual([
      { taskKey: "ORN-142", pr: "sourceplane/orun#412", reason: "key_parse", matchedComponents: [] },
    ]);
    expect(plan.transitions).toEqual([{ taskKey: "ORN-142", from: "todo", to: "in_progress" }]);
  });

  it("moves a task to in_review on ready_for_review", () => {
    const tasks = [task("ORN-1", "in_progress", ["c/c/c"])];
    const plan = computeAutoLinkPlan(pr({ phase: "ready_for_review" }), ["c/c/c"], tasks, "ORN");
    expect(plan.transitions).toEqual([{ taskKey: "ORN-1", from: "in_progress", to: "in_review" }]);
  });
});

describe("auto-linker — invariants (W2)", () => {
  it("never touches closed tasks (done/released/canceled)", () => {
    const tasks = [
      task("ORN-1", "done", ["c/c/c"]),
      task("ORN-2", "released", ["c/c/c"]),
      task("ORN-3", "canceled", ["c/c/c"]),
    ];
    const plan = computeAutoLinkPlan(pr(), ["c/c/c"], tasks, "ORN");
    expect(plan.links).toHaveLength(0);
    expect(plan.transitions).toHaveLength(0);
  });

  it("is forward-only: an 'opened' event never regresses a task already in_review", () => {
    const tasks = [task("ORN-1", "in_review", ["c/c/c"])];
    const plan = computeAutoLinkPlan(pr({ phase: "opened" }), ["c/c/c"], tasks, "ORN");
    // Still links (it's an open task), but emits no backward transition.
    expect(plan.links).toHaveLength(1);
    expect(plan.transitions).toHaveLength(0);
  });

  it("attributes everything to automation, never a human (invariant 4)", () => {
    const tasks = [task("ORN-1", "backlog", ["c/c/c"])];
    const plan = computeAutoLinkPlan(pr(), ["c/c/c"], tasks, "ORN");
    expect(plan.actor).toEqual(AUTOLINK_ACTOR);
    expect(plan.actor.type).toBe("automation");
  });

  it("emits no link when neither component nor key matches", () => {
    const tasks = [task("ORN-1", "backlog", ["other/comp/x"])];
    const plan = computeAutoLinkPlan(pr({ branch: "feature/none", title: "none" }), ["sourceplane/orun/api-edge"], tasks, "ORN");
    expect(plan.links).toHaveLength(0);
    expect(plan.transitions).toHaveLength(0);
  });
});

describe("auto-linker — key parsing & affects materialization", () => {
  it("parses and dedupes PREFIX-n keys", () => {
    expect(parseTaskKeys("ORN-1 and ORN-12, again ORN-1; ABC-9", "ORN")).toEqual(["ORN-1", "ORN-12"]);
    expect(parseTaskKeys("no keys here", "ORN")).toEqual([]);
  });

  it("rejects a malformed prefix instead of injecting it into the match RegExp", () => {
    // A prefix carrying regex metacharacters (or wrong case) must fail loudly,
    // not silently corrupt matching.
    expect(() => parseTaskKeys("A.1-1", "A.")).toThrow();
    expect(() => parseTaskKeys("orn-1", "orn")).toThrow();
    expect(() => computeAutoLinkPlan(pr(), ["c/c/c"], [task("ORN-1", "backlog", ["c/c/c"])], "A|B")).toThrow();
  });

  it("degrades unresolved affects visibly rather than dropping them (Q-5)", () => {
    const links = materializeAffects("ORN-1", ["a/b/c", "ghost/x/y"], (c) => c === "a/b/c");
    expect(links).toEqual([
      { from: "ORN-1", to: "a/b/c", resolution: "resolved" },
      { from: "ORN-1", to: "ghost/x/y", resolution: "unresolved" },
    ]);
  });

  it("treats affects as resolved when no catalog resolver is supplied", () => {
    const links = materializeAffects("ORN-1", ["a/b/c"]);
    expect(links).toEqual([{ from: "ORN-1", to: "a/b/c", resolution: "resolved" }]);
  });
});

describe("auto-linker — applying the plan (W2)", () => {
  const ok = (key: string): WorkResult<CommitOutcome> => ({
    ok: true,
    value: { event: { eventId: "wev", project: "org/proj", subject: key, kind: "link_added", actor: AUTOLINK_ACTOR, at: "2026-06-11T09:00:00Z", seq: 0 } as WorkEvent, key },
  });

  it("accounts for per-entity failures (task removed between planning and apply)", async () => {
    const plan: AutoLinkPlan = {
      links: [
        { taskKey: "ORN-1", pr: "sourceplane/orun#412", reason: "component_overlap", matchedComponents: ["c/c/c"] },
        { taskKey: "ORN-2", pr: "sourceplane/orun#412", reason: "key_parse", matchedComponents: [] },
      ],
      transitions: [{ taskKey: "ORN-1", from: "backlog", to: "in_progress" }],
      actor: AUTOLINK_ACTOR,
    };
    // ORN-2 was deleted after planning: its link write fails; ORN-1 succeeds.
    const repo: AutoLinkRepo = {
      async addLink(input: LinkInput) {
        return input.to && input.from === "ORN-2"
          ? { ok: false, error: { kind: "not_found", entity: "ORN-2" } }
          : ok(input.from);
      },
      async setStatus(input: SetStatusInput) {
        return ok(input.key);
      },
    };
    const out = await applyAutoLinkPlan(repo, { orgId: "org", projectId: "proj" }, pr(), plan);
    expect(out.applied).toBe(2); // ORN-1 link + ORN-1 transition
    expect(out.rejected).toEqual([{ key: "ORN-2", reason: "not_found: ORN-2" }]);
  });
});
