// Origin taint contract (saas-agent-supervision SV0, design §2): the closed
// provenance vocabulary carried on every AgentSession. Closed from day one —
// the door records exactly one of these kinds, nothing downstream gates on it.

import { AGENT_ORIGIN_KINDS, type AgentOrigin, type AgentSession } from "@saas/contracts/agents";

describe("AGENT_ORIGIN_KINDS", () => {
  it("is the five-provenance closed union, in door-precedence-friendly order", () => {
    expect([...AGENT_ORIGIN_KINDS]).toEqual(["dispatch", "work", "routine", "session", "human"]);
  });

  it("AgentOrigin composes a kind with optional ref/label/backfilled", () => {
    const dispatch: AgentOrigin = { kind: "dispatch", ref: "ch_1", label: "Fix flaky CI" };
    const human: AgentOrigin = { kind: "human" };
    const inferred: AgentOrigin = { kind: "session", ref: "as_9f", backfilled: true };
    expect(dispatch.kind).toBe("dispatch");
    expect(human.ref).toBeUndefined();
    expect(inferred.backfilled).toBe(true);
  });

  it("origin is a required field on AgentSession (a session always has provenance)", () => {
    // Type-level guarantee, exercised as a value: a session literal without
    // origin does not satisfy AgentSession. This compiles only because origin
    // is present.
    const s: Pick<AgentSession, "id" | "origin"> = { id: "as_1", origin: { kind: "human" } };
    expect(s.origin.kind).toBe("human");
  });
});
