// Dispatch presentation model (saas-dispatch DX2). The load-bearing test is
// the two-plane guard: a work card and a session card are structurally
// distinct shapes — no model function merges fold rungs and infrastructure
// states into one "status", and this suite fails if one appears.

import type { Situation } from "@saas/contracts/dispatch";
import {
  attentionCard,
  budgetView,
  readyCard,
  sessionCard,
  sessionHref,
  situationCounts,
  unavailableSections,
  workItemHref,
} from "@web-console-next/lib/dispatch/model";

const SITUATION: Situation = {
  ready: [
    { plane: "work", key: "ORN-1", title: "Ship it", evidence: ["contract complete", "deps closed"] },
    { plane: "work", key: "ORN-2", title: "No evidence" },
  ],
  inFlight: [
    { plane: "session", id: "as_1", state: "running", runKind: "implementation", profileId: "agp_1", spawnedBy: "usr_a", taskKey: "ORN-9", tokensUsed: 1200 },
    { plane: "session", id: "as_2", state: "awaiting_approval", runKind: "design", profileId: "agp_1", spawnedBy: "usr_a", depth: 1, parentSessionId: "as_1" },
  ],
  waitingOnMe: [
    { plane: "session", kind: "verdict", reason: "wants to deploy", at: "2026-07-20T10:00:00Z", sessionId: "as_2", request: { requestId: "apr_1", tool: "bash" } },
    { plane: "governance", kind: "routine_parked", reason: "2 failures", at: "2026-07-20T09:00:00Z", routineId: "rt_1" },
  ],
  counts: { verdict: 1, running: 1 },
  budget: { plane: "governance", workspaceMaxTokens: 10000, liveTokens: 1200, softMark: 0.8 },
  cursor: "w42.17",
  sections: { ready: {}, inFlight: {}, waitingOnMe: { unavailable: true }, budget: {} },
};

describe("situationCounts (the DX1 report payload)", () => {
  it("reports aggregate numerals only — no item content", () => {
    const counts = situationCounts(SITUATION);
    expect(counts).toEqual({ ready: 2, inFlight: 2, waitingOnMe: 2, running: 1 });
    for (const v of Object.values(counts)) expect(typeof v).toBe("number");
  });
});

describe("two-plane separation (D5 guard)", () => {
  it("a work card carries fold facts and NO session state field", () => {
    const card = readyCard(SITUATION.ready[0]!);
    expect(card.plane).toBe("work");
    expect(card.evidenceLine).toBe("contract complete · deps closed");
    expect("state" in card).toBe(false);
    expect("runKind" in card).toBe(false);
  });

  it("a session card carries infrastructure facts and NO rung/lifecycle field", () => {
    const card = sessionCard(SITUATION.inFlight[0]!);
    expect(card.plane).toBe("session");
    expect(card.state).toBe("running");
    expect("rung" in card).toBe(false);
    expect("lifecycle" in card).toBe(false);
    expect("evidence" in card).toBe(false);
    // The work pointer is a LINK, not a merged status.
    expect(card.taskKey).toBe("ORN-9");
  });

  it("a child session renders as a child, never flattened", () => {
    expect(sessionCard(SITUATION.inFlight[1]!).isChild).toBe(true);
    expect(sessionCard(SITUATION.inFlight[0]!).isChild).toBe(false);
  });
});

describe("attention cards (lock 5)", () => {
  it("a verdict is human-gated and lands on the session page", () => {
    const card = attentionCard(SITUATION.waitingOnMe[0]!);
    expect(card.humanGated).toBe(true);
    expect(card.href("acme")).toBe("/orgs/acme/agents/as_2");
  });
  it("a routine item is not human-gated-by-verdict and lands on the fleet home", () => {
    const card = attentionCard(SITUATION.waitingOnMe[1]!);
    expect(card.humanGated).toBe(false);
    expect(card.href("acme")).toBe("/orgs/acme/agents");
  });
});

describe("budget view", () => {
  it("maps live spend under the soft mark to success", () => {
    const v = budgetView({ plane: "governance", workspaceMaxTokens: 10000, liveTokens: 1200, softMark: 0.8 });
    expect(v).toMatchObject({ hasCeiling: true, pct: 12, tone: "success" });
  });
  it("warns past the soft mark and errors at the ceiling, clamped", () => {
    expect(budgetView({ plane: "governance", workspaceMaxTokens: 10000, liveTokens: 8500, softMark: 0.8 }).tone).toBe("warning");
    const over = budgetView({ plane: "governance", workspaceMaxTokens: 10000, liveTokens: 15000, softMark: 0.8 });
    expect(over.tone).toBe("error");
    expect(over.pct).toBe(100);
  });
  it("renders honestly with no ceiling set", () => {
    const v = budgetView({ plane: "governance", workspaceMaxTokens: null, liveTokens: 500, softMark: 0.8 });
    expect(v.hasCeiling).toBe(false);
    expect(v.tone).toBe("neutral");
  });
});

describe("degradation + links", () => {
  it("names unavailable sections for the honest chip", () => {
    expect(unavailableSections(SITUATION)).toEqual(["waitingOnMe"]);
  });
  it("URL helpers stay org-scoped", () => {
    expect(sessionHref("acme", "as_1")).toBe("/orgs/acme/agents/as_1");
    expect(workItemHref("acme", "ORN-1")).toBe("/orgs/acme/work?item=ORN-1");
  });
});

describe("DD4: honest liveness", () => {
  it("partitions requested sessions out of in-flight", async () => {
    const { partitionInFlight } = await import("@web-console-next/lib/dispatch/model");
    const { active, queued } = partitionInFlight([
      { plane: "session", id: "as_1", state: "running", runKind: "interactive", profileId: "p", spawnedBy: "u" },
      { plane: "session", id: "as_2", state: "requested", runKind: "interactive", profileId: "p", spawnedBy: "u" },
      { plane: "session", id: "as_3", state: "provisioning", runKind: "interactive", profileId: "p", spawnedBy: "u" },
    ]);
    expect(active.map((s) => s.id)).toEqual(["as_1", "as_3"]);
    expect(queued.map((s) => s.id)).toEqual(["as_2"]);
  });

  it("humanizes durations — '1163m' can never render", async () => {
    const { humanizeDurationMs, queuedAge } = await import("@web-console-next/lib/dispatch/model");
    expect(humanizeDurationMs(1163 * 60_000)).toBe("19 h");
    expect(humanizeDurationMs(42 * 60_000)).toBe("42 m");
    expect(humanizeDurationMs(3 * 24 * 3_600_000)).toBe("3 d");
    expect(humanizeDurationMs(20_000)).toBe("under a minute");
    expect(humanizeDurationMs(Number.NaN)).toBe("—");
    expect(
      queuedAge(
        { plane: "session", id: "as_2", state: "requested", runKind: "interactive", profileId: "p", spawnedBy: "u", createdAt: "2026-07-21T12:00:00Z" },
        new Date("2026-07-22T07:23:00Z"),
      ),
    ).toBe("19 h");
  });
});
