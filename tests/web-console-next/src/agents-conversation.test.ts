// Conversation fold (saas-agents-live AL7): the shared presentation contract
// between the console head and the orun TUI head. The console renders exactly
// what the TUI renders because both fold the same event vocabulary the same
// way; these tests pin that fold.

import {
  foldConversation,
  hasUnattendedApproval,
  type ConversationEvent,
} from "@web-console-next/lib/agents/conversation";

/** A representative interactive session's relayed events, mirroring the
 * fixtures orun's TUI head folds. */
function fixtureEvents(): ConversationEvent[] {
  return [
    { seq: 0, kind: "state_changed", payload: { state: "running" } },
    { seq: 1, kind: "message_agent", payload: { text: "Reading the brief." } },
    { seq: 2, kind: "tool_call", payload: { tool: "work_get", decision: "allow" } },
    { seq: 3, kind: "tool_result", payload: { text: "ORN-142: sweep leases" } },
    { seq: 4, kind: "message_user", payload: { text: "also update the changelog", principal: "usr_alice" } },
    { seq: 5, kind: "message_agent", payload: { text: "Will do." } },
    { seq: 6, kind: "approval_requested", payload: { requestId: "req-1", tool: "contract_propose" } },
  ];
}

describe("foldConversation", () => {
  it("folds turns, tool cards, and a sticky pending approval", () => {
    const c = foldConversation(fixtureEvents());

    // Attributed turns.
    const user = c.items.find((i) => i.kind === "user");
    expect(user?.text).toBe("also update the changelog");
    expect(user?.principal).toBe("usr_alice");
    const agents = c.items.filter((i) => i.kind === "agent").map((i) => i.text);
    expect(agents).toEqual(["Reading the brief.", "Will do."]);

    // Tool card carries its policy decision.
    const tool = c.items.find((i) => i.kind === "tool");
    expect(tool?.text).toBe("work_get");
    expect(tool?.detail).toBe("allow");

    // The approval is pending and sticky.
    expect(c.pending).toEqual([{ requestId: "req-1", tool: "contract_propose" }]);
    expect(hasUnattendedApproval(c)).toBe(true);
    expect(c.terminal).toBe(false);
  });

  it("clears a pending approval on resolution, attributed to the answerer", () => {
    const events = [
      ...fixtureEvents(),
      { seq: 7, kind: "approval_resolved", payload: { requestId: "req-1", approved: true, principal: "usr_bob" } },
    ];
    const c = foldConversation(events);
    expect(c.pending).toHaveLength(0);
    expect(hasUnattendedApproval(c)).toBe(false);
    const resolution = c.items.find((i) => i.kind === "note" && i.text.startsWith("Approval approved"));
    expect(resolution?.text).toBe("Approval approved by usr_bob");
  });

  it("marks terminal on a non-running state change and surfaces the artifact", () => {
    const events: ConversationEvent[] = [
      { seq: 0, kind: "state_changed", payload: { state: "running" } },
      { seq: 1, kind: "artifact_produced", payload: { pr: "https://github.com/x/pull/1" } },
      { seq: 2, kind: "cost_sample", payload: { tokens: 4812 } },
      { seq: 3, kind: "state_changed", payload: { state: "completed" } },
    ];
    const c = foldConversation(events);
    expect(c.terminal).toBe(true);
    expect(c.items.some((i) => i.text === "Artifact: https://github.com/x/pull/1")).toBe(true);
  });

  it("tracks the activity line from cost samples and clears it on a turn", () => {
    const mid = foldConversation([
      { seq: 0, kind: "state_changed", payload: { state: "running" } },
      { seq: 1, kind: "cost_sample", payload: { tokens: 1200 } },
    ]);
    expect(mid.activity).toBe("1200 tokens");
    const afterTurn = foldConversation([
      { seq: 0, kind: "cost_sample", payload: { tokens: 1200 } },
      { seq: 1, kind: "message_agent", payload: { text: "done" } },
    ]);
    expect(afterTurn.activity).toBe("");
  });

  it("ignores unknown event kinds (forward compatibility)", () => {
    const c = foldConversation([
      { seq: 0, kind: "message_agent", payload: { text: "hi" } },
      { seq: 1, kind: "future_kind", payload: { whatever: true } },
    ]);
    expect(c.items).toHaveLength(1);
  });
});

describe("delegation events (saas-agents-fleet AF4)", () => {
  it("folds the parent's child_* story into note lines with the child id as detail", () => {
    const c = foldConversation([
      { seq: 0, kind: "child_spawned", payload: { sessionId: "as_kid1", goal: "draft option A" } },
      { seq: 1, kind: "child_completed", payload: { sessionId: "as_kid1", verdict: "pass", summary: "34 tests green" } },
      { seq: 2, kind: "child_failed", payload: { sessionId: "as_kid2", reason: "sandbox expired" } },
    ]);
    expect(c.items.map((i) => i.kind)).toEqual(["note", "note", "note"]);
    expect(c.items[0]!.text).toBe("Spawned as_kid1 — draft option A");
    expect(c.items[1]!.text).toContain("verdict: pass");
    expect(c.items[1]!.detail).toBe("as_kid1");
    expect(c.items[2]!.text).toContain("sandbox expired");
    // Child lifecycle never flips the parent terminal — infrastructure
    // narration, not a state change.
    expect(c.terminal).toBe(false);
  });
});
