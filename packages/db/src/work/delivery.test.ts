import { describe, expect, it } from "vitest";
import type { PullRequestContext } from "./autolink.js";
import {
  DELIVERY_ACTOR,
  RELEASE_ACTOR,
  automationDoneAllowed,
  decideDone,
  decideReleased,
  detectDrift,
  type DeploymentObservation,
  type GateReport,
  type TaskGates,
} from "./delivery.js";

const report = (gates: GateReport["gates"]): GateReport => ({ pr: "sourceplane/orun#412", gates });
const task = (status: TaskGates["status"], gates: string[]): TaskGates => ({ key: "ORN-1", status, gates });

describe("W3 — gate-verified Done", () => {
  it("moves a task to Done when every contract gate is green", () => {
    const d = decideDone(task("in_review", ["tests", "parity"]), report({ tests: "passed", parity: "passed" }));
    expect(d).toEqual({ taskKey: "ORN-1", to: "done", reason: "gates_green" });
    expect(automationDoneAllowed(task("in_review", ["tests"]), report({ tests: "passed" }))).toBe(true);
  });

  it("parks in in_review and surfaces the blocking gate when one is not green", () => {
    const d = decideDone(task("in_review", ["tests", "parity"]), report({ tests: "passed", parity: "failed" }));
    expect(d).toEqual({ taskKey: "ORN-1", to: "in_review", reason: "gate_blocked", blockedGate: "parity" });
    expect(automationDoneAllowed(task("in_review", ["tests", "parity"]), report({ tests: "passed", parity: "failed" }))).toBe(false);
  });

  it("treats a missing or pending gate as blocking", () => {
    expect(decideDone(task("in_review", ["tests"]), report({}))?.blockedGate).toBe("tests");
    expect(decideDone(task("in_review", ["tests"]), report({ tests: "pending" }))?.reason).toBe("gate_blocked");
  });

  it("never auto-Dones a task with no gates — it parks for a human", () => {
    const d = decideDone(task("in_review", []), report({}));
    expect(d).toEqual({ taskKey: "ORN-1", to: "in_review", reason: "no_gates" });
    expect(automationDoneAllowed(task("in_review", []), report({}))).toBe(false);
  });

  it("yields no decision for an already-closed task", () => {
    expect(decideDone(task("done", ["tests"]), report({ tests: "passed" }))).toBeNull();
    expect(decideDone(task("canceled", ["tests"]), report({ tests: "failed" }))).toBeNull();
  });

  it("uses the automation principal, never a human", () => {
    expect(DELIVERY_ACTOR.type).toBe("automation");
  });
});

describe("W3 — Released from the Deployment overlay (invariant 5)", () => {
  const overlay: DeploymentObservation = { source: "overlay", ref: "deploy:prod@abc123", environment: "prod", revision: "abc123" };

  it("releases delivered tasks only from an overlay observation", () => {
    const out = decideReleased(overlay, [{ key: "ORN-1", status: "done" }, { key: "ORN-2", status: "in_review" }]);
    expect(out).toEqual([
      { taskKey: "ORN-1", deploymentRef: "deploy:prod@abc123", environment: "prod" },
      { taskKey: "ORN-2", deploymentRef: "deploy:prod@abc123", environment: "prod" },
    ]);
  });

  it("never releases from a deploy attempt (only live overlay state)", () => {
    const attempt: DeploymentObservation = { ...overlay, source: "attempt" };
    expect(decideReleased(attempt, [{ key: "ORN-1", status: "done" }])).toEqual([]);
  });

  it("leaves already-released or canceled tasks alone", () => {
    const out = decideReleased(overlay, [{ key: "ORN-1", status: "released" }, { key: "ORN-2", status: "canceled" }]);
    expect(out).toEqual([]);
  });

  it("uses the deployment-sourced automation principal", () => {
    expect(RELEASE_ACTOR.via).toBe("deployment-overlay");
  });
});

describe("W3 — drift inbox", () => {
  const merged: PullRequestContext = { ref: "sourceplane/orun#999", title: "drive-by fix", branch: "hotfix/x", phase: "merged" };

  it("raises exactly one drift item for a merged PR with no claiming task", () => {
    const item = detectDrift(merged, ["sourceplane/orun/api-edge"], []);
    expect(item).toEqual({ pr: "sourceplane/orun#999", components: ["sourceplane/orun/api-edge"] });
  });

  it("raises nothing when a task already claims the change", () => {
    expect(detectDrift(merged, ["sourceplane/orun/api-edge"], ["ORN-1"])).toBeNull();
  });

  it("raises nothing for a non-merge phase", () => {
    expect(detectDrift({ ...merged, phase: "opened" }, ["c/c/c"], [])).toBeNull();
  });
});

describe("W3 — the delivery walk (in_review → done → released)", () => {
  it("advances a task purely from delivery events", () => {
    // 1. Merge with green gates → Done.
    const done = decideDone(task("in_review", ["tests"]), report({ tests: "passed" }));
    expect(done?.to).toBe("done");

    // 2. The Deployment overlay shows the revision live → Released.
    const overlay: DeploymentObservation = { source: "overlay", ref: "deploy:prod@r1", environment: "prod", revision: "r1" };
    const released = decideReleased(overlay, [{ key: "ORN-1", status: "done" }]);
    expect(released).toEqual([{ taskKey: "ORN-1", deploymentRef: "deploy:prod@r1", environment: "prod" }]);

    // Released never came from the merge — only the overlay (invariant 5).
    expect(decideReleased({ ...overlay, source: "attempt" }, [{ key: "ORN-1", status: "done" }])).toEqual([]);
  });
});
