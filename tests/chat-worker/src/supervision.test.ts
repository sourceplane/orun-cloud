// The supervision engine (saas-agent-supervision SV3, design §4) — the pure
// loop, fixture-tested vendor-free: N coalesced events → 1 bounded digest;
// reflexive (dispatcher-caused) events don't wake, but terminal/approval
// always do; a storm collapses to one digest; observe mode runs no model;
// approvals become escalation cards and NEVER a verdict.

import {
  WakeAccumulator,
  buildDigest,
  escalationsFrom,
  isReflexive,
  supervisionRunsModel,
  toDigestEntry,
  wakeKindForEvent,
  type WakeInput,
} from "@chat-worker/supervision";
import { DIGEST_ENTRY_CAP, type AgentOrigin } from "@saas/contracts/agents";

const ORIGIN: AgentOrigin = { kind: "dispatch", ref: "ch_1" };

function ev(partial: Partial<WakeInput> & { sessionId: string; eventKind: WakeInput["eventKind"]; seq: number }): WakeInput {
  return { origin: ORIGIN, at: "2026-07-24T00:00:00Z", ...partial };
}

describe("wakeKindForEvent — the closed wake set", () => {
  it("terminal states wake; running does not", () => {
    expect(wakeKindForEvent("state_changed", { state: "completed" })).toBe("terminal");
    expect(wakeKindForEvent("state_changed", { state: "failed" })).toBe("terminal");
    expect(wakeKindForEvent("state_changed", { state: "running" })).toBeNull();
  });
  it("approvals + child_* wake; ticks/deltas/cost do not", () => {
    expect(wakeKindForEvent("approval_requested")).toBe("approval");
    expect(wakeKindForEvent("child_completed")).toBe("child");
    expect(wakeKindForEvent("tool_call")).toBeNull();
    expect(wakeKindForEvent("cost_sample")).toBeNull();
    expect(wakeKindForEvent("message_agent")).toBeNull();
  });
});

describe("buildDigest — coalesce into one bounded digest (§4.2)", () => {
  it("N wake events → 1 digest, deduped by (session, seq), ordered by seq", () => {
    const inputs = [
      ev({ sessionId: "as_2", eventKind: "state_changed", seq: 5, payload: { state: "completed" } }),
      ev({ sessionId: "as_1", eventKind: "child_spawned", seq: 2 }),
      ev({ sessionId: "as_1", eventKind: "child_spawned", seq: 2 }), // dup
      ev({ sessionId: "as_1", eventKind: "tool_call", seq: 3 }), // not wake-worthy
    ];
    const d = buildDigest("ch_1", inputs);
    expect(d.chatId).toBe("ch_1");
    expect(d.entries).toHaveLength(2);
    expect(d.coalesced).toBe(2);
    expect(d.entries.map((e) => e.seq)).toEqual([2, 5]);
    expect(d.entries[1]!.wake).toBe("terminal");
  });

  it("caps progress but always keeps terminal + approval, with an overflow count", () => {
    const inputs: WakeInput[] = [];
    // 20 child (progress) events — past the cap.
    for (let i = 0; i < 20; i++) {
      inputs.push(ev({ sessionId: `as_c${i}`, eventKind: "child_completed", seq: 100 + i }));
    }
    // one terminal + one approval, low seq — must survive the cap.
    inputs.push(ev({ sessionId: "as_t", eventKind: "state_changed", seq: 1, payload: { state: "completed" } }));
    inputs.push(ev({ sessionId: "as_a", eventKind: "approval_requested", seq: 2, payload: { tool: "deploy" } }));

    const d = buildDigest("ch_1", inputs);
    expect(d.entries.length).toBe(DIGEST_ENTRY_CAP);
    expect(d.overflow).toBe(22 - DIGEST_ENTRY_CAP);
    // The always-wake pair is present regardless of the cap.
    expect(d.entries.some((e) => e.wake === "terminal")).toBe(true);
    expect(d.entries.some((e) => e.wake === "approval")).toBe(true);
  });
});

describe("reflexivity filter (§4.5)", () => {
  const DISPATCHER = "sp_dispatcher";
  it("drops a dispatcher-caused non-terminal event, keeps a human-caused one", () => {
    const own = ev({ sessionId: "as_1", eventKind: "child_spawned", seq: 1, principal: DISPATCHER });
    const human = ev({ sessionId: "as_2", eventKind: "child_spawned", seq: 2, principal: "usr_x" });
    expect(isReflexive(own, DISPATCHER)).toBe(true);
    expect(isReflexive(human, DISPATCHER)).toBe(false);
    const d = buildDigest("ch_1", [own, human], { dispatcherPrincipal: DISPATCHER });
    expect(d.entries.map((e) => e.sessionId)).toEqual(["as_2"]);
  });

  it("terminal + approval ALWAYS ring even when the dispatcher caused them", () => {
    const term = ev({ sessionId: "as_1", eventKind: "state_changed", seq: 1, payload: { state: "completed" }, principal: DISPATCHER });
    const appr = ev({ sessionId: "as_2", eventKind: "approval_requested", seq: 2, principal: DISPATCHER });
    expect(isReflexive(term, DISPATCHER)).toBe(false);
    expect(isReflexive(appr, DISPATCHER)).toBe(false);
    const d = buildDigest("ch_1", [term, appr], { dispatcherPrincipal: DISPATCHER });
    expect(d.entries).toHaveLength(2);
  });
});

describe("WakeAccumulator — the coalescing window", () => {
  it("a storm of 100 events in the window drains to ONE digest", () => {
    const acc = new WakeAccumulator(5000);
    const t0 = 1_000_000;
    for (let i = 0; i < 100; i++) {
      acc.add(ev({ sessionId: `as_${i % 3}`, eventKind: "child_completed", seq: i }), t0 + i * 10);
    }
    expect(acc.due(t0 + 4000)).toBe(false); // window not elapsed
    expect(acc.due(t0 + 5000)).toBe(true);
    const d = acc.drain("ch_1");
    expect(d.coalesced).toBe(100);
    expect(d.entries.length).toBe(DIGEST_ENTRY_CAP); // bounded
    expect(acc.pending()).toBe(false); // reset after drain
  });

  it("msUntilDue arms the alarm for the remaining window", () => {
    const acc = new WakeAccumulator(5000);
    expect(acc.msUntilDue(0)).toBeNull();
    acc.add(ev({ sessionId: "as_1", eventKind: "child_spawned", seq: 1 }), 1000);
    expect(acc.msUntilDue(1000)).toBe(5000);
    expect(acc.msUntilDue(3000)).toBe(3000);
    expect(acc.msUntilDue(9999)).toBe(0);
  });
});

describe("mode gating + escalation (§4.3/§4.4)", () => {
  it("only `on` runs a model turn; observe/off do not", () => {
    expect(supervisionRunsModel("on")).toBe(true);
    expect(supervisionRunsModel("observe")).toBe(false);
    expect(supervisionRunsModel("off")).toBe(false);
  });

  it("an approval becomes an escalation card with NO verdict field (approvals stay human)", () => {
    const d = buildDigest("ch_1", [
      ev({ sessionId: "as_1", eventKind: "approval_requested", seq: 1, payload: { tool: "wrangler deploy" } }),
      ev({ sessionId: "as_2", eventKind: "state_changed", seq: 2, payload: { state: "completed" } }),
    ]);
    const cards = escalationsFrom(d);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "escalation", sessionId: "as_1", tool: "wrangler deploy" });
    // Structural lock: an escalation card cannot carry a verdict — the type has
    // no such field, and nothing here resolves the request.
    expect((cards[0] as unknown as Record<string, unknown>).approved).toBeUndefined();
    expect((cards[0] as unknown as Record<string, unknown>).verdict).toBeUndefined();
  });
});

describe("toDigestEntry — synthetic budget/stuck pass through", () => {
  it("honors a pre-classified wake kind the index computed", () => {
    const budget = toDigestEntry({ ...ev({ sessionId: "as_1", eventKind: "error", seq: 1 }), wake: "budget" });
    expect(budget?.wake).toBe("budget");
    const stuck = toDigestEntry({ ...ev({ sessionId: "as_1", eventKind: "error", seq: 2 }), wake: "stuck" });
    expect(stuck?.wake).toBe("stuck");
    // A plain non-wake event with no pre-classification drops out.
    expect(toDigestEntry(ev({ sessionId: "as_1", eventKind: "tool_call", seq: 3 }))).toBeNull();
  });
});
