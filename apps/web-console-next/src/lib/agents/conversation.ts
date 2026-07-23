// Conversation fold (saas-agents-live AL7) — the shared PRESENTATION CONTRACT
// between the console head and the orun TUI head (design decision 5). It folds
// the relayed session-event stream (the closed 11-kind vocabulary) into the
// structured conversation items both surfaces render: attributed user/agent
// turns, collapsible tool cards, note lines, and — sticky and impossible to
// miss — pending approval cards. The fold logic here mirrors
// internal/tui/views/agent.go foldEvent in the Go head, so the two render
// identically (verified by rendering the same fixture sessions).
//
// Pure and dependency-light so it is unit-testable exactly like model.ts.

import type { AgentSessionEventKind } from "@saas/contracts/agents";
import { sanitizeHarnessError } from "./harness-error";

/** One relayed session event (the wire shape from listSessionEvents / the SSE
 * event frame's payload). */
export interface ConversationEvent {
  seq: number;
  kind: AgentSessionEventKind | string;
  at?: string;
  payload?: Record<string, unknown>;
}

export type ConversationItemKind = "agent" | "user" | "tool" | "note";

/** A rendered conversation item. */
export interface ConversationItem {
  key: string;
  kind: ConversationItemKind;
  text: string;
  /** For user turns: the attributed principal. */
  principal?: string;
  /** For tool items: the policy decision (allow/ask/deny). */
  detail?: string;
}

/** A pending approval the head must surface stickily until resolved. */
export interface PendingApproval {
  requestId: string;
  tool: string;
  /** Why the runtime routed this to a human (policy prose), when it says. */
  reason?: string;
}

/** The folded conversation: the ordered items, the still-pending approvals,
 * the live activity line (current tool / cost), and whether the stream has
 * reached a terminal state. */
export interface Conversation {
  items: ConversationItem[];
  pending: PendingApproval[];
  activity: string;
  terminal: boolean;
}

function str(payload: Record<string, unknown> | undefined, key: string): string {
  const v = payload?.[key];
  return typeof v === "string" ? v : "";
}

/**
 * foldConversation folds an ordered event stream into a Conversation. Deltas
 * are NOT part of this stream (they are wire-only and never relayed as
 * events); the console applies them to the activity line separately over SSE.
 */
export function foldConversation(events: ConversationEvent[]): Conversation {
  const items: ConversationItem[] = [];
  let pending: PendingApproval[] = [];
  let activity = "";
  let terminal = false;

  for (const e of events) {
    const p = e.payload;
    const key = `e${e.seq}`;
    switch (e.kind) {
      case "message_agent":
        activity = "";
        items.push({ key, kind: "agent", text: str(p, "text") });
        break;
      case "message_user":
        items.push({ key, kind: "user", text: str(p, "text"), principal: str(p, "principal") });
        break;
      case "tool_call":
        items.push({ key, kind: "tool", text: str(p, "tool"), detail: str(p, "decision") });
        break;
      case "tool_result":
        activity = "";
        break;
      case "approval_requested": {
        const requestId = str(p, "requestId");
        const tool = str(p, "tool");
        const reason = str(p, "reason");
        pending.push({ requestId, tool, ...(reason ? { reason } : {}) });
        items.push({ key, kind: "note", text: `Approval needed: ${tool}`, detail: requestId });
        break;
      }
      case "approval_resolved": {
        const requestId = str(p, "requestId");
        pending = pending.filter((a) => a.requestId !== requestId);
        const approved = p?.approved === true;
        const who = str(p, "principal") || "—";
        items.push({
          key,
          kind: "note",
          text: `Approval ${approved ? "approved" : "denied"} by ${who}`,
        });
        break;
      }
      case "artifact_produced": {
        const pr = str(p, "pr");
        items.push({ key, kind: "note", text: pr ? `Artifact: ${pr}` : "Artifact produced" });
        break;
      }
      case "cost_sample": {
        const tokens = p?.tokens;
        if (typeof tokens === "number") activity = `${tokens} tokens`;
        break;
      }
      case "state_changed": {
        const state = str(p, "state");
        items.push({ key, kind: "note", text: `State: ${state}` });
        if (state && state !== "running") terminal = true;
        break;
      }
      case "harness_event": {
        const phase = str(p, "phase");
        if (phase) items.push({ key, kind: "note", text: `Harness: ${phase}` });
        break;
      }
      case "error":
        // Sanitized: a misrouted gateway relays entire HTML pages here.
        items.push({ key, kind: "note", text: `Error: ${sanitizeHarnessError(str(p, "text"))}` });
        break;
      // Delegation (saas-agents-fleet AF4): the parent's sealed story of its
      // children. Verdict-shaped judge results ride child_completed.
      case "child_spawned": {
        const goal = str(p, "goal");
        items.push({
          key,
          kind: "note",
          text: `Spawned ${str(p, "sessionId") || "child"}${goal ? ` — ${goal}` : ""}`,
        });
        break;
      }
      case "child_completed": {
        const verdict = str(p, "verdict");
        const summary = str(p, "summary");
        items.push({
          key,
          kind: "note",
          text: `Child ${str(p, "sessionId") || "session"} completed${verdict ? ` — verdict: ${verdict}` : ""}${summary ? ` — ${summary}` : ""}`,
          detail: str(p, "sessionId"),
        });
        break;
      }
      case "child_failed":
        items.push({
          key,
          kind: "note",
          text: `Child ${str(p, "sessionId") || "session"} failed${str(p, "reason") ? ` — ${str(p, "reason")}` : ""}`,
          detail: str(p, "sessionId"),
        });
        break;
      // Unknown kinds are ignored (forward compatibility).
    }
  }

  return { items, pending, activity, terminal };
}

/** hasUnattendedApproval reports whether the fold is blocked on a human — the
 * signal the fleet view / topbar renders an attention badge from. */
export function hasUnattendedApproval(c: Conversation): boolean {
  return c.pending.length > 0;
}
