import { describe, expect, it } from "vitest";
import { gateObservationsFromRunFold, workObservationFromLiveDeployment } from "./delivery.js";
import { fold, type Task } from "./model.js";

const AT = "2026-07-04T12:00:00Z";

describe("run-stream → gate_result (P-3: orun execution truth)", () => {
  it("maps terminal jobs to verdicts, skips running jobs, sorts by job id", () => {
    const drafts = gateObservationsFromRunFold(
      "run_1",
      "sha256:rev1",
      { jobs: { tests: { phase: "succeeded" }, parity: { phase: "failed" }, deploy: { phase: "running" }, cache: { phase: "memoized" } } },
      AT,
    );
    expect(drafts.map((d) => [d.payload!.gate, d.payload!.status])).toEqual([
      ["cache", "green"],
      ["parity", "red"],
      ["tests", "green"],
    ]);
    expect(drafts[0]!.source).toBe("run-stream");
    expect(drafts[0]!.dedupeKey).toBe("run:run_1:cache:memoized");
    expect(drafts.every((d) => d.payload!.revision === "sha256:rev1" && d.payload!.runRef === "run_1")).toBe(true);
  });

  it("yields nothing without git provenance (no revision to bind — honest degradation)", () => {
    expect(gateObservationsFromRunFold("run_1", null, { jobs: { tests: { phase: "succeeded" } } }, AT)).toEqual([]);
  });

  it("a retried job that flips phase lands a new fact whose later seq wins in the fold", () => {
    const red = gateObservationsFromRunFold("run_1", "rev", { jobs: { tests: { phase: "failed" } } }, AT);
    const green = gateObservationsFromRunFold("run_1", "rev", { jobs: { tests: { phase: "succeeded" } } }, AT);
    expect(red[0]!.dedupeKey).not.toBe(green[0]!.dedupeKey);
  });
});

describe("deploy-overlay → revision_live (invariant 5)", () => {
  it("maps a live observation and rejects non-overlay/incomplete shapes", () => {
    const draft = workObservationFromLiveDeployment(
      { source: "overlay", ref: "res_1", environment: "production", revision: "sha256:rev1" },
      AT,
    )!;
    expect(draft.kind).toBe("revision_live");
    expect(draft.dedupeKey).toBe("overlay:sha256:rev1:production");
    expect(workObservationFromLiveDeployment({ source: "attempt" as never, ref: "r", environment: "e", revision: "v" }, AT)).toBeNull();
    expect(workObservationFromLiveDeployment({ source: "overlay", ref: "r", environment: "", revision: "v" }, AT)).toBeNull();
  });
});

describe("the full In Review → Done → Released walk from execution truth", () => {
  it("gates verified by the run stream move Done; the overlay alone moves Released", () => {
    const task: Task = {
      apiVersion: "orun.io/v1",
      kind: "Task",
      key: "ORN-1",
      workspace: "ws",
      title: "ship",
      contract: { goal: "g", affects: ["a/b/c"], doneWhen: ["d"], gates: ["tests", "parity"] },
      createdBy: { type: "user", id: "u" },
    };
    const obs = (kind: string, dedupe: string, payload: Record<string, unknown>, seq: number) => ({
      workspace: "ws",
      source: "x",
      sourceVersion: 1,
      kind: kind as never,
      at: AT,
      dedupeKey: dedupe,
      payload,
      seq,
    });
    const merged = obs("pr_merged", "m", { pr: "o/r#1", revision: "rev", taskKeys: ["ORN-1"] }, 1);
    const gTests = obs("gate_result", "g1", { gate: "tests", revision: "rev", status: "green" }, 2);
    const gParity = obs("gate_result", "g2", { gate: "parity", revision: "rev", status: "green" }, 3);
    const live = obs("revision_live", "l", { revision: "rev", environment: "production" }, 4);

    let r = fold({ tasks: [task], events: [], observations: [merged, gTests] });
    expect(r.lifecycles["ORN-1"]!.rung).toBe("in_review"); // parity unknown to orun
    r = fold({ tasks: [task], events: [], observations: [merged, gTests, gParity] });
    expect(r.lifecycles["ORN-1"]!.rung).toBe("done");
    r = fold({ tasks: [task], events: [], observations: [merged, gTests, gParity, live] });
    expect(r.lifecycles["ORN-1"]!.rung).toBe("released");
    expect(r.lifecycles["ORN-1"]!.evidence).toEqual(["revision rev live in production (PR o/r#1)"]);
  });
});
