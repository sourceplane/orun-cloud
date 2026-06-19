import { describe, expect, it } from "vitest";

import {
  canonicalizeJobInput,
  memoizationHit,
  type JobInputHashInput,
  type JobResult,
} from "./coordination.js";

const base: JobInputHashInput = {
  steps: [{ run: "build", name: "b" }],
  inputDigests: ["sha256:y", "sha256:x"],
  envKeys: ["B", "A"],
  compositionLockDigest: "sha256:lock",
};

describe("canonicalizeJobInput (C5 — normative cross-language form)", () => {
  it("produces the exact canonical golden string", () => {
    expect(canonicalizeJobInput(base)).toBe(
      '{"compositionLockDigest":"sha256:lock","envKeys":["A","B"],' +
        '"inputDigests":["sha256:x","sha256:y"],"steps":[{"name":"b","run":"build"}]}',
    );
  });

  it("is invariant to inputDigests / envKeys ordering (set-like fields sorted)", () => {
    const reordered: JobInputHashInput = {
      ...base,
      inputDigests: ["sha256:x", "sha256:y"],
      envKeys: ["A", "B"],
    };
    expect(canonicalizeJobInput(reordered)).toBe(canonicalizeJobInput(base));
  });

  it("is invariant to object key order within steps", () => {
    const reorderedKeys: JobInputHashInput = { ...base, steps: [{ name: "b", run: "build" }] };
    expect(canonicalizeJobInput(reorderedKeys)).toBe(canonicalizeJobInput(base));
  });

  it("is sensitive to step order (execution order matters)", () => {
    const twoSteps: JobInputHashInput = { ...base, steps: [{ run: "a" }, { run: "b" }] };
    const swapped: JobInputHashInput = { ...base, steps: [{ run: "b" }, { run: "a" }] };
    expect(canonicalizeJobInput(twoSteps)).not.toBe(canonicalizeJobInput(swapped));
  });
});

describe("memoizationHit (C6 / D1 — opt-in hermetic gate)", () => {
  const result: JobResult = {
    jobInputHash: "sha256:abc",
    outputs: ["sha256:o1"],
    exit: 0,
    logsDigest: "sha256:log",
  };

  it("never memoizes a non-hermetic job, even with an existing result", () => {
    expect(memoizationHit({ hermetic: false, existing: result })).toBeNull();
  });

  it("misses when hermetic but no prior result exists", () => {
    expect(memoizationHit({ hermetic: true, existing: null })).toBeNull();
  });

  it("hits when hermetic and a prior result exists", () => {
    expect(memoizationHit({ hermetic: true, existing: result })).toBe(result);
  });
});
