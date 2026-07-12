// Ceiling intersection (saas-agents-fleet AF4, design §3.1 / risk F2): the
// ONE rule of the delegation plane — a child's effective ceiling is
// parent ∩ child, and the result is ⊆ each input for EVERY input. A bug
// here silently widens a child, the one failure class the plane must never
// have, so the subset property is checked exhaustively over generated
// inputs, not just examples.

import { ceilingOf, intersectCeiling, type CapabilityCeiling } from "@saas/contracts/agents";

const KEYS = ["tools", "mayAffect", "secrets"] as const;

function subsetOf(child: string[] | undefined, parent: string[] | undefined): boolean {
  if (child === undefined) return parent === undefined; // absent stays absent only when both absent
  if (parent === undefined) return true; // parent unrestricted at this level
  const set = new Set(parent);
  return child.every((x) => set.has(x));
}

describe("intersectCeiling", () => {
  it("intersects present keys, passes through one-sided keys, drops both-absent keys", () => {
    const parent: CapabilityCeiling = { tools: ["bash", "git", "deploy"], secrets: ["A"] };
    const child: CapabilityCeiling = { tools: ["bash", "git", "web"], mayAffect: ["svc-a"] };
    expect(intersectCeiling(parent, child)).toEqual({
      tools: ["bash", "git"],
      mayAffect: ["svc-a"],
      secrets: ["A"],
    });
  });

  it("empty parent list means the child gets nothing — narrow beats wide", () => {
    expect(intersectCeiling({ tools: [] }, { tools: ["bash"] })).toEqual({ tools: [] });
  });

  it("is associative — composing down a tree gives one answer regardless of grouping", () => {
    const a: CapabilityCeiling = { tools: ["x", "y", "z"] };
    const b: CapabilityCeiling = { tools: ["y", "z", "w"], secrets: ["S"] };
    const c: CapabilityCeiling = { tools: ["z", "w"], mayAffect: ["m"] };
    expect(intersectCeiling(intersectCeiling(a, b), c)).toEqual(intersectCeiling(a, intersectCeiling(b, c)));
  });

  it("PROPERTY: the result is ⊆ parent and ⊆ child for every generated input", () => {
    // Deterministic exhaustive-ish sweep: every combination of absent /
    // empty / small allowlists per key, both sides. No randomness — a
    // failure is reproducible by construction.
    const pools: (string[] | undefined)[] = [
      undefined,
      [],
      ["a"],
      ["a", "b"],
      ["b", "c"],
      ["a", "b", "c", "d"],
    ];
    let checked = 0;
    for (const pt of pools) {
      for (const ct of pools) {
        for (const pm of pools) {
          for (const cm of pools) {
            const parent: CapabilityCeiling = {
              ...(pt !== undefined ? { tools: pt } : {}),
              ...(pm !== undefined ? { mayAffect: pm } : {}),
            };
            const child: CapabilityCeiling = {
              ...(ct !== undefined ? { tools: ct } : {}),
              ...(cm !== undefined ? { mayAffect: cm } : {}),
            };
            const out = intersectCeiling(parent, child);
            for (const key of KEYS) {
              // Wider-than-parent (when parent restricts) is the fatal class.
              if (parent[key] !== undefined) {
                expect(subsetOf(out[key] ?? [], parent[key])).toBe(true);
              }
              if (child[key] !== undefined) {
                expect(subsetOf(out[key] ?? [], child[key])).toBe(true);
              }
              // Absent output only when both inputs were absent.
              if (out[key] === undefined) {
                expect(parent[key]).toBeUndefined();
                expect(child[key]).toBeUndefined();
              }
            }
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(6 * 6 * 6 * 6);
  });
});

describe("ceilingOf", () => {
  it("reads only the ceiling keys from a capability blob, dropping junk", () => {
    expect(
      ceilingOf({ tools: ["bash", 42, "git"], mayAffect: "not-a-list", note: "x" } as Record<string, unknown>),
    ).toEqual({ tools: ["bash", "git"] });
    expect(ceilingOf(undefined)).toEqual({});
  });
});
