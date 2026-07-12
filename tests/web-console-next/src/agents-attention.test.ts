// Attention presentation model (saas-agents-fleet AF5): every source kind in
// the closed vocabulary maps to a tone + label; only a verdict with a pending
// request is answerable in place; ages render in the mock's compact grammar.

import {
  attentionKindLabel,
  attentionTone,
  compactAge,
  isAnswerable,
} from "@web-console-next/lib/agents/attention";
import { ATTENTION_KINDS, type AttentionItem } from "@saas/contracts/agents";

function item(overrides: Partial<AttentionItem>): AttentionItem {
  return {
    kind: "verdict",
    sessionId: "as_1",
    reason: "waiting",
    at: "2026-07-12T09:00:00.000Z",
    ...overrides,
  };
}

describe("attention presentation model", () => {
  it("maps every kind in the closed vocabulary", () => {
    for (const kind of ATTENTION_KINDS) {
      expect(attentionKindLabel(kind).length).toBeGreaterThan(0);
      expect(["success", "warning", "error", "info", "neutral"]).toContain(attentionTone(kind));
    }
  });

  it("blocking asks are warnings; failures and stuck sessions are errors", () => {
    expect(attentionTone("verdict")).toBe("warning");
    expect(attentionTone("failed_retryable")).toBe("error");
    expect(attentionTone("stuck")).toBe("error");
  });

  it("only a verdict carrying its pending request is answerable in place", () => {
    expect(isAnswerable(item({ request: { requestId: "r1", tool: "bash" } }))).toBe(true);
    // Relay behind: the state says awaiting but no ask has landed yet.
    expect(isAnswerable(item({}))).toBe(false);
    // Non-verdict kinds deep-link, never answer.
    expect(
      isAnswerable(item({ kind: "failed_retryable", request: { requestId: "r1", tool: "x" } })),
    ).toBe(false);
  });

  it("renders compact ages in the mock's grammar", () => {
    const now = new Date("2026-07-12T10:00:00.000Z");
    expect(compactAge("2026-07-12T09:59:40.000Z", now)).toBe("now");
    expect(compactAge("2026-07-12T09:54:00.000Z", now)).toBe("6m");
    expect(compactAge("2026-07-12T07:00:00.000Z", now)).toBe("3h");
    expect(compactAge("2026-07-09T10:00:00.000Z", now)).toBe("3d");
    // A future timestamp (clock skew) never renders negative.
    expect(compactAge("2026-07-12T11:00:00.000Z", now)).toBe("now");
  });
});
