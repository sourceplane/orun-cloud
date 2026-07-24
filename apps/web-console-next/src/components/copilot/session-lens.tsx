"use client";

// The delegated-session lens (saas-copilot-surface CX4/CX5, design §5.3, §6;
// unified in copilotkit-interface-unify): the session's activity stream through
// the AG-UI watch door, rendered by the SAME transcript vocabulary as the
// dispatch thread (components/copilot/transcript.tsx) — streaming markdown
// bubbles, collapsible tool cards, attributed steers, and honest error cards.
// The lens is now the session's ONE copilot head: it hydrates the durable log
// for ended sessions and rides the watch door's full replay (from=-1) while
// live, so there is no second, differently-styled transcript beneath it.
//
// The in-thread APPROVAL card renders ONLY from server-emitted CUSTOM
// {name:"approval"} events (the fold is fed exclusively by the door's
// EventSource; a forged client-side shape cannot produce one), and
// Approve/Deny resolve through the EXISTING credentialed verdict path the page
// already owns — AN lock 5 survives generative UI.

import * as React from "react";
import type { AguiEvent } from "@saas/contracts/agui";
import type { AgentSessionEventKind } from "@saas/contracts/agents";
import { Pill, StatusDot, type Tone } from "@/components/ui/northwind";
import { sanitizeHarnessError } from "@/lib/agents/harness-error";
import type { ConversationEvent } from "@/lib/agents/conversation";
import { StreamingBubble, TranscriptRow, type TranscriptItem } from "./transcript.js";

export interface LensApproval {
  requestId: string;
  tool?: string;
  reason?: string;
  seq?: number;
  resolved?: boolean;
  approved?: boolean;
}

export interface LensState {
  sessionState: string | null;
  timeline: Array<{ state: string; seq?: number }>;
  tokens: number;
  approvals: LensApproval[];
  /** The single chronological transcript — user steers, agent turns, tool
   * cards, honest activity notes, and error cards, interleaved by arrival
   * (the copilot-thread DD2 posture, shared vocabulary). */
  items: TranscriptItem[];
  streaming: string;
  cursor: number;
}

export function initialLensState(): LensState {
  return {
    sessionState: null,
    timeline: [],
    tokens: 0,
    approvals: [],
    items: [],
    streaming: "",
    cursor: -1,
  };
}

/** A generic (non-chat, non-error) activity line, folded into an honest note
 * — the plane-honest posture: name the kind, keep a compact payload tail. */
function activityNote(kind: string, payload: Record<string, unknown> | undefined): string {
  const summary = payload ? JSON.stringify(payload).slice(0, 140) : "";
  return summary ? `${kind} · ${summary}` : kind;
}

/** foldLensEvent — the lens's pure fold over dialect events (tested). Produces
 * a single chronological transcript plus the session chrome (state timeline,
 * cost, approvals). */
export function foldLensEvent(s: LensState, e: AguiEvent): LensState {
  const cursor = typeof e.seq === "number" && e.seq > s.cursor ? e.seq : s.cursor;
  switch (e.type) {
    case "STATE_SNAPSHOT": {
      const st = typeof e.snapshot?.state === "string" ? (e.snapshot.state as string) : s.sessionState;
      const c = typeof e.snapshot?.cursor === "number" ? Math.max(s.cursor, e.snapshot.cursor as number) : cursor;
      return { ...s, sessionState: st, cursor: c };
    }
    case "STATE_DELTA": {
      const op = e.ops?.find((o) => o.path === "/state");
      if (!op || typeof op.value !== "string") return { ...s, cursor };
      return {
        ...s,
        cursor,
        sessionState: op.value,
        timeline: [...s.timeline, { state: op.value, ...(typeof e.seq === "number" ? { seq: e.seq } : {}) }],
      };
    }
    case "TOOL_CALL_START":
      return {
        ...s,
        cursor,
        items: [
          ...s.items,
          {
            kind: "tool",
            id: String(e.toolCallId),
            // Session tools run in the sandbox — never client (ui_) tools —
            // so they always render as the collapsible tool card.
            tool: { id: String(e.toolCallId), name: String(e.toolCallName ?? "tool"), args: "", client: false },
          },
        ],
      };
    case "TOOL_CALL_ARGS":
      return {
        ...s,
        cursor,
        items: s.items.map((it) =>
          it.kind === "tool" && it.id === e.toolCallId
            ? { ...it, tool: { ...it.tool, args: it.tool.args + String(e.delta ?? "") } }
            : it,
        ),
      };
    case "TOOL_CALL_RESULT":
      return {
        ...s,
        cursor,
        items: s.items.map((it) =>
          it.kind === "tool" && it.id === e.toolCallId
            ? { ...it, tool: { ...it.tool, result: String(e.content ?? ""), ...(e.isError ? { isError: true } : {}) } }
            : it,
        ),
      };
    case "TEXT_MESSAGE_CONTENT":
      return { ...s, cursor, streaming: s.streaming + (e.delta ?? "") };
    case "TEXT_MESSAGE_END":
      // A completed streamed turn becomes a durable-looking bubble — text the
      // user watched arrive must not vanish (the copilot-thread DD2 posture).
      return s.streaming
        ? {
            ...s,
            cursor,
            items: [...s.items, { kind: "assistant", id: String(e.messageId ?? `m_${s.items.length}`), text: s.streaming }],
            streaming: "",
          }
        : { ...s, cursor, streaming: "" };
    case "RUN_ERROR": {
      // A harness/relay error is a transcript artifact, not a dropped event —
      // sanitized, because a misrouted gateway sends entire HTML pages.
      const message = sanitizeHarnessError(String(e.message ?? e.code ?? "run failed"));
      return { ...s, cursor, streaming: "", items: [...s.items, { kind: "error", id: `err_${s.items.length}`, text: message }] };
    }
    case "CUSTOM": {
      if (e.name === "cost") {
        const t = (e.value as { tokens?: unknown } | undefined)?.tokens;
        return { ...s, cursor, tokens: s.tokens + (typeof t === "number" ? t : 0) };
      }
      if (e.name === "approval") {
        // The ONLY producer of an approval card (design §6).
        const v = (e.value ?? {}) as { requestId?: string; tool?: string; reason?: string };
        if (!v.requestId) return { ...s, cursor };
        return {
          ...s,
          cursor,
          approvals: [
            ...s.approvals,
            { requestId: v.requestId, ...(v.tool ? { tool: v.tool } : {}), ...(v.reason ? { reason: v.reason } : {}), ...(typeof e.seq === "number" ? { seq: e.seq } : {}) },
          ],
        };
      }
      if (e.name === "activity") {
        const v = (e.value ?? {}) as { kind?: string; at?: string; payload?: Record<string, unknown> };
        const kind = v.kind ?? "event";
        // A resolution collapses its card — matched by requestId, from the
        // server stream only.
        if (kind === "approval_resolved") {
          const rid = typeof v.payload?.requestId === "string" ? v.payload.requestId : undefined;
          const approved = v.payload?.approved === true;
          return {
            ...s,
            cursor,
            approvals: s.approvals.map((a) => (a.requestId === rid ? { ...a, resolved: true, approved } : a)),
          };
        }
        // Chat-shaped session events become transcript bubbles, not activity
        // noise — the lens is the session's copilot head.
        if (kind === "message_user") {
          const text = typeof v.payload?.text === "string" ? v.payload.text : "";
          if (!text) return { ...s, cursor };
          const principal = typeof v.payload?.principal === "string" ? v.payload.principal : undefined;
          return {
            ...s,
            cursor,
            items: [...s.items, { kind: "user", id: `u_${e.seq ?? s.items.length}`, text, ...(principal ? { principal } : {}) }],
          };
        }
        if (kind === "message_agent") {
          const text = typeof v.payload?.text === "string" ? v.payload.text : "";
          if (!text) return { ...s, cursor };
          // The durable copy of a turn the stream already showed: skip the
          // duplicate bubble (replays re-deliver the durable event only).
          const last = [...s.items].reverse().find((it) => it.kind === "assistant");
          if (last && last.kind === "assistant" && last.text === text) return { ...s, cursor };
          return { ...s, cursor, items: [...s.items, { kind: "assistant", id: `a_${e.seq ?? s.items.length}`, text }] };
        }
        if (kind === "error") {
          // Older runtimes emit tool denials as {tool, error} with no text.
          const raw =
            (typeof v.payload?.text === "string" && v.payload.text) ||
            [v.payload?.tool, v.payload?.error].filter((x): x is string => typeof x === "string" && !!x).join(" ");
          const text = sanitizeHarnessError(raw);
          return { ...s, cursor, items: [...s.items, { kind: "error", id: `err_${e.seq ?? s.items.length}`, text }] };
        }
        return {
          ...s,
          cursor,
          items: [...s.items, { kind: "note", id: `n_${e.seq ?? s.items.length}`, text: activityNote(kind, v.payload) }],
        };
      }
      return { ...s, cursor };
    }
    default:
      return { ...s, cursor };
  }
}

/** sessionEventsToItems — the durable session log (the closed relayed
 * vocabulary from listSessionEvents) folded into the SAME transcript items the
 * live stream produces, so an ended session reads exactly like a live one.
 * This is the one durable-log renderer now that the legacy console-head fold
 * has been decommissioned. */
export function sessionEventsToItems(events: ConversationEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const str = (p: Record<string, unknown> | undefined, k: string): string => {
    const v = p?.[k];
    return typeof v === "string" ? v : "";
  };
  for (const e of events) {
    const p = e.payload;
    const id = `h${e.seq}`;
    switch (e.kind as AgentSessionEventKind | string) {
      case "message_agent":
        items.push({ kind: "assistant", id, text: str(p, "text") });
        break;
      case "message_user": {
        const principal = str(p, "principal");
        items.push({ kind: "user", id, text: str(p, "text"), ...(principal ? { principal } : {}) });
        break;
      }
      case "tool_call": {
        const decision = str(p, "decision");
        items.push({
          kind: "tool",
          id,
          // A durable tool row is settled: render it "done" (result "") with
          // the policy decision as its args, never a spinning "…".
          tool: { id, name: str(p, "tool") || "tool", args: decision, result: "", client: false },
        });
        break;
      }
      case "artifact_produced": {
        const pr = str(p, "pr");
        items.push({ kind: "note", id, text: pr ? `Artifact: ${pr}` : "Artifact produced" });
        break;
      }
      case "approval_resolved": {
        const approved = p?.approved === true;
        const who = str(p, "principal") || "—";
        items.push({ kind: "note", id, text: `Approval ${approved ? "approved" : "denied"} by ${who}` });
        break;
      }
      case "state_changed": {
        const state = str(p, "state");
        if (state) items.push({ kind: "note", id, text: `State: ${state}` });
        break;
      }
      case "harness_event": {
        const phase = str(p, "phase");
        if (phase) items.push({ kind: "note", id, text: `Harness: ${phase}` });
        break;
      }
      case "error": {
        const raw = str(p, "text") || [str(p, "tool"), str(p, "error")].filter(Boolean).join(" ");
        items.push({ kind: "error", id, text: sanitizeHarnessError(raw) });
        break;
      }
      case "child_spawned": {
        const goal = str(p, "goal");
        items.push({ kind: "note", id, text: `Spawned ${str(p, "sessionId") || "child"}${goal ? ` — ${goal}` : ""}` });
        break;
      }
      case "child_completed": {
        const verdict = str(p, "verdict");
        const summary = str(p, "summary");
        items.push({
          kind: "note",
          id,
          text: `Child ${str(p, "sessionId") || "session"} completed${verdict ? ` — verdict: ${verdict}` : ""}${summary ? ` — ${summary}` : ""}`,
        });
        break;
      }
      case "child_failed":
        items.push({
          kind: "note",
          id,
          text: `Child ${str(p, "sessionId") || "session"} failed${str(p, "reason") ? ` — ${str(p, "reason")}` : ""}`,
        });
        break;
      // tool_result (activity clear), approval_requested (the sticky card
      // owns it / the live replay re-emits it), cost_sample (the tokens rail),
      // and unknown kinds carry no transcript bubble.
    }
  }
  return items;
}

/** pendingApprovals — the still-open approval requests folded from the durable
 * event stream (an `approval_requested` with no later `approval_resolved` for
 * the same requestId). These render as sticky, actionable cards; a resolved
 * request drops out here and appears as a settled note in the transcript. */
export function pendingApprovals(events: ConversationEvent[]): LensApproval[] {
  const open = new Map<string, LensApproval>();
  for (const e of events) {
    const p = e.payload;
    const rid = typeof p?.requestId === "string" ? p.requestId : undefined;
    if (!rid) continue;
    if (e.kind === "approval_requested") {
      open.set(rid, {
        requestId: rid,
        ...(typeof p?.tool === "string" ? { tool: p.tool } : {}),
        ...(typeof p?.reason === "string" ? { reason: p.reason } : {}),
      });
    } else if (e.kind === "approval_resolved") {
      open.delete(rid);
    }
  }
  return [...open.values()];
}

/** The lens's transport: the session AG-UI watch door over EventSource
 * (query bearer — the attach carve-out; native retry does the reconnect,
 * resuming from the folded cursor). Retained for the watch-door fold tests;
 * the live session head now renders from the durable + attach-socket event
 * stream (the proven AL2 transport) so a running session's log always shows. */
export function useSessionLens(target: string, token: string | null, orgId: string, sessionId: string, live: boolean): LensState {
  const [state, setState] = React.useState<LensState>(initialLensState);
  const cursorRef = React.useRef(-1);

  React.useEffect(() => {
    if (!live || !token) return;
    const base = new URL(target);
    base.pathname = `/v1/organizations/${encodeURIComponent(orgId)}/agents/sessions/${encodeURIComponent(sessionId)}/agui/watch`;
    base.search = "";
    base.searchParams.set("from", String(cursorRef.current));
    base.searchParams.set("access_token", token);
    const es = new EventSource(base.toString());
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data as string) as AguiEvent;
        setState((prev) => {
          const next = foldLensEvent(prev, e);
          cursorRef.current = next.cursor;
          return next;
        });
      } catch {
        // torn event — dropped
      }
    };
    return () => es.close();
  }, [target, token, orgId, sessionId, live]);

  return state;
}

function ApprovalCard({ a, onApprove, onDeny, busy }: { a: LensApproval; onApprove: (id: string) => void; onDeny: (id: string) => void; busy: boolean }) {
  if (a.resolved) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-border/50 px-3.5 py-2 text-[12.5px] text-muted-foreground">
        <StatusDot tone={a.approved ? "success" : "neutral"} />
        {a.approved ? "Approved" : "Denied"}
        {a.tool ? <span className="font-mono">· {a.tool}</span> : null}
      </div>
    );
  }
  return (
    <div className="my-2 rounded-xl border border-warning-accent/40 bg-warning-wash px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-[#7A6C4E] dark:text-warning">
        <StatusDot tone="warning" live />
        Approval needed
        {a.tool ? <span className="font-mono text-[12px]">· {a.tool}</span> : null}
      </div>
      {a.reason ? <p className="mt-1 text-[12.5px] text-muted-foreground">{a.reason}</p> : null}
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onApprove(a.requestId)}
          className="rounded-lg bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDeny(a.requestId)}
          className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] hover:bg-muted disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export function SessionLens({
  live,
  events,
  streaming,
  tokens,
  tierLabel,
  tierTone,
  onApprove,
  onDeny,
  interacting,
  emptyHint,
}: {
  live: boolean;
  /** The session log — the durable read merged with the live attach socket
   * (the proven AL2 transport). This IS the transcript, live or ended, so a
   * running session's relayed log always renders. */
  events: ConversationEvent[];
  /** The in-progress turn's streamed delta (attach socket), live only. */
  streaming?: string;
  /** Cost so far (the session record's tokensUsed). */
  tokens?: number;
  /** The trust tier — rendered permanently (DX lock 8, inherited). */
  tierLabel: string;
  tierTone: Tone;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
  interacting: boolean;
  /** Empty-state line — the caller varies it by state. */
  emptyHint?: string;
}) {
  const items = sessionEventsToItems(events);
  const approvals = pendingApprovals(events);
  const showStreaming = live && !!streaming;

  return (
    <div className="min-w-0">
      {/* The permanent tier pill + running cost. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Pill tone={tierTone}>{tierLabel}</Pill>
        {tokens && tokens > 0 ? (
          <span className="ml-auto text-[12px] text-muted-foreground">{tokens.toLocaleString()} tokens</span>
        ) : null}
      </div>

      {approvals.map((a) => (
        <ApprovalCard key={a.requestId} a={a} onApprove={onApprove} onDeny={onDeny} busy={interacting} />
      ))}

      {/* The unified transcript — the SAME rows the dispatch thread renders. */}
      {items.map((it) => (
        <TranscriptRow key={it.id} it={it} />
      ))}

      {showStreaming ? <StreamingBubble text={streaming!} /> : null}

      {items.length === 0 && !showStreaming ? (
        <p className="text-[12.5px] text-muted-foreground">
          {live
            ? emptyHint ?? "The runtime relays its session log here once the sandbox dials home."
            : emptyHint ?? "This session ended without relaying a session log."}
        </p>
      ) : null}
    </div>
  );
}
