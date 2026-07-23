"use client";

// The delegated-session lens (saas-copilot-surface CX4/CX5, design §5.3, §6):
// the session's activity stream through the AG-UI watch door, rendered by the
// same component vocabulary as the dispatch thread — a state timeline
// (STATE_DELTA), tool cards on the shared lanes, cost ticks, plane-honest
// activity lines, and the in-thread APPROVAL card. The card renders ONLY
// from server-emitted CUSTOM {name:"approval"} events (the fold is fed
// exclusively by the door's EventSource; a forged client-side shape cannot
// produce one), and Approve/Deny resolve through the EXISTING credentialed
// verdict path the page already owns — AN lock 5 survives generative UI.

import * as React from "react";
import ReactMarkdown from "react-markdown";
import type { AguiEvent } from "@saas/contracts/agui";
import { Pill, StatusDot, type Tone } from "@/components/ui/northwind";
import { sessionTone, sessionLabel } from "@/lib/agents/model";
import { sanitizeHarnessError } from "@/lib/agents/harness-error";

export interface LensToolCall {
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
}

export interface LensApproval {
  requestId: string;
  tool?: string;
  reason?: string;
  seq?: number;
  resolved?: boolean;
  approved?: boolean;
}

/** A transcript bubble the lens renders chronologically — the session's chat
 * story on the copilot engine (user steers, agent turns, error cards). */
export type LensThreadItem =
  | { kind: "user"; id: string; text: string; principal?: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "error"; id: string; text: string };

export interface LensState {
  sessionState: string | null;
  timeline: Array<{ state: string; seq?: number }>;
  tools: LensToolCall[];
  activity: Array<{ kind: string; at?: string; seq?: number; summary: string }>;
  tokens: number;
  approvals: LensApproval[];
  /** The chronological transcript (user/agent/error bubbles). */
  items: LensThreadItem[];
  streaming: string;
  cursor: number;
}

export function initialLensState(): LensState {
  return {
    sessionState: null,
    timeline: [],
    tools: [],
    activity: [],
    tokens: 0,
    approvals: [],
    items: [],
    streaming: "",
    cursor: -1,
  };
}

/** foldLensEvent — the lens's pure fold over dialect events (tested). */
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
      return { ...s, cursor, tools: [...s.tools, { id: String(e.toolCallId), name: String(e.toolCallName ?? "tool"), args: "" }] };
    case "TOOL_CALL_ARGS":
      return { ...s, cursor, tools: s.tools.map((t) => (t.id === e.toolCallId ? { ...t, args: t.args + (e.delta ?? "") } : t)) };
    case "TOOL_CALL_RESULT":
      return {
        ...s,
        cursor,
        tools: s.tools.map((t) => (t.id === e.toolCallId ? { ...t, result: e.content ?? "", ...(e.isError ? { isError: true } : {}) } : t)),
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
          if (last && last.text === text) return { ...s, cursor };
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
        const summary = v.payload ? JSON.stringify(v.payload).slice(0, 140) : "";
        return {
          ...s,
          cursor,
          activity: [...s.activity, { kind, ...(v.at ? { at: v.at } : {}), ...(typeof e.seq === "number" ? { seq: e.seq } : {}), summary }],
        };
      }
      return { ...s, cursor };
    }
    default:
      return { ...s, cursor };
  }
}

/** The lens's transport: the session AG-UI watch door over EventSource
 * (query bearer — the attach carve-out; native retry does the reconnect,
 * resuming from the folded cursor). */
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
  target,
  token,
  orgId,
  sessionId,
  live,
  tierLabel,
  tierTone,
  onApprove,
  onDeny,
  interacting,
}: {
  target: string;
  token: string | null;
  orgId: string;
  sessionId: string;
  live: boolean;
  /** The trust tier — rendered permanently (DX lock 8, inherited). */
  tierLabel: string;
  tierTone: Tone;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
  interacting: boolean;
}) {
  const lens = useSessionLens(target, token, orgId, sessionId, live);

  return (
    <div className="min-w-0">
      {/* The state timeline + the permanent tier pill. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Pill tone={tierTone}>{tierLabel}</Pill>
        {lens.timeline.map((t, i) => (
          <React.Fragment key={`${t.state}${t.seq ?? i}`}>
            {i > 0 || lens.timeline.length > 0 ? <span className="text-[11px] text-muted-foreground/50">→</span> : null}
            <Pill tone={sessionTone(t.state as never)} dot live={t.state === "running"}>
              {sessionLabel(t.state as never)}
            </Pill>
          </React.Fragment>
        ))}
        {lens.tokens > 0 ? <span className="ml-auto text-[12px] text-muted-foreground">{lens.tokens.toLocaleString()} tokens</span> : null}
      </div>

      {lens.approvals.map((a) => (
        <ApprovalCard key={a.requestId} a={a} onApprove={onApprove} onDeny={onDeny} busy={interacting} />
      ))}

      {/* The transcript (CX4 upgraded): user steers, agent turns, and error
          cards folded from the AG-UI stream — chat bubbles, not activity
          lines, so the lens reads as the session's copilot head. */}
      {lens.items.map((it) =>
        it.kind === "user" ? (
          <div key={it.id} className="my-2 flex justify-end">
            <div className="max-w-[85%] rounded-xl bg-secondary px-3.5 py-2 text-[13px]">
              {it.principal ? (
                <div className="mb-0.5 font-mono text-[10.5px] text-muted-foreground">{it.principal}</div>
              ) : null}
              <span className="whitespace-pre-wrap">{it.text}</span>
            </div>
          </div>
        ) : it.kind === "assistant" ? (
          <div key={it.id} className="my-2 flex justify-start">
            <div className="prose-chat max-w-[85%] rounded-2xl border border-border/60 px-3.5 py-2 text-[13px]">
              <ReactMarkdown>{it.text}</ReactMarkdown>
            </div>
          </div>
        ) : (
          <div
            key={it.id}
            className="my-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-2 text-[12.5px] text-destructive"
          >
            {it.text}
          </div>
        ),
      )}

      {lens.tools.map((t) => (
        <div key={t.id} className="my-1 rounded-lg border border-border/50 bg-muted/40 px-3 py-1.5 font-mono text-[12px] text-muted-foreground">
          <span className="mr-2">⚙ {t.name}</span>
          <span className={t.isError ? "text-destructive" : ""}>{t.result === undefined ? "…" : t.result || "done"}</span>
        </div>
      ))}

      {lens.activity.map((a, i) => (
        <div key={`${a.seq ?? i}`} className="my-1 flex items-baseline gap-2 text-[12px] text-muted-foreground">
          <span className="font-mono text-[11px] text-muted-foreground/70">{a.kind}</span>
          <span className="truncate">{a.summary}</span>
        </div>
      ))}

      {lens.streaming ? (
        <p className="mt-2 whitespace-pre-wrap text-[13px] italic text-muted-foreground">
          {lens.streaming}
          <span className="animate-pulse">▍</span>
        </p>
      ) : null}

      {!live && lens.items.length === 0 && lens.activity.length === 0 && lens.tools.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">This session's stream has ended; the durable log below is the record.</p>
      ) : null}
    </div>
  );
}
