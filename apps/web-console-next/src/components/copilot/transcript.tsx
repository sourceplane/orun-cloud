"use client";

// The shared copilot transcript vocabulary (saas-copilot-surface, design
// §5.2/§5.3): the ONE set of render primitives every copilot surface draws
// with. The dispatch thread (copilot-thread.tsx) and the delegated-session
// lens (session-lens.tsx) both compose these, so a Workspace Agent turn and a
// session's relayed turn render identically — streaming markdown bubbles,
// collapsible tool cards, an attributed steer bubble, and a sticky composer
// with the same stop/regenerate chrome.
//
// Presentational only: no transport, no fold. The run-owning run door and the
// watch-door session head each keep their own event fold, then hand the same
// TranscriptItem[] shape to these primitives — that is the whole standard.

import * as React from "react";
import ReactMarkdown from "react-markdown";
import { Pill, StatusText } from "@/components/ui/northwind";

export interface ToolCallView {
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
  client: boolean;
}

/** One transcript entry, in arrival order (DD2) — the single chronological
 * item list both copilot surfaces render. A user steer may carry the
 * attributed principal (session heads relay who steered) and, when the
 * Workspace Agent's hand moved (SV2), a `via` disclosure so a dispatcher steer
 * reads distinctly from a human one. */
export type TranscriptItem =
  | { kind: "user"; id: string; text: string; principal?: string; via?: string }
  | { kind: "assistant"; id: string; text: string; error?: boolean }
  | { kind: "tool"; id: string; tool: ToolCallView }
  | { kind: "error"; id: string; text: string }
  | { kind: "note"; id: string; text: string };

export function ToolCard({ t }: { t: ToolCallView }) {
  const [open, setOpen] = React.useState(false);
  if (t.client) {
    // The agent's hands are always on camera (design §3.3).
    return (
      <div className="my-1 flex items-center gap-2 text-[12px]">
        <span className="sr-only">console action</span>
        <Pill tone={t.isError ? "warning" : "info"} dot>
          {t.name.replace(/^ui_/, "").replace(/_/g, " ")}
        </Pill>
        {t.result ? (
          <span className="text-muted-foreground">{t.result}</span>
        ) : (
          <span className="animate-pulse text-muted-foreground">…</span>
        )}
      </div>
    );
  }
  return (
    <div className="my-1 rounded-lg border border-border/50 bg-muted/40 text-[12px]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`tool ${t.name} — ${t.result === undefined ? "running" : t.isError ? "failed" : "done"}`}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-muted-foreground"
      >
        <span>⚙ {t.name}</span>
        <span className={t.isError ? "text-destructive" : ""}>
          {t.result === undefined ? "…" : t.isError ? "failed" : "done"}
        </span>
        <span className="ml-auto text-[10px]" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border/50 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <div className="truncate">args: {t.args || "{}"}</div>
          {t.result !== undefined ? <div className="mt-1 whitespace-pre-wrap break-words">{t.result}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function TranscriptRow({ it, onRetry }: { it: TranscriptItem; onRetry?: () => void }) {
  switch (it.kind) {
    case "user": {
      // SV2: a steer the Workspace Agent's hand sent (via=workspace-agent)
      // reads distinctly from a human steer — "Workspace Agent · steer", the
      // principal (owner on a human-prompted turn, the dispatcher sp_ on a
      // supervisor turn) shown as the smaller attribution beneath.
      const byAgent = it.via === "workspace-agent";
      return (
        <div className="my-2 flex justify-end">
          <div className="max-w-[80%] rounded-2xl bg-foreground px-3.5 py-2 text-[13.5px] text-background">
            {byAgent ? (
              <div className="mb-0.5 text-[10.5px] font-medium opacity-80">Workspace Agent · steer</div>
            ) : null}
            {it.principal ? (
              <div className="mb-0.5 font-mono text-[10.5px] opacity-60">{it.principal}</div>
            ) : null}
            <span className="whitespace-pre-wrap">{it.text}</span>
          </div>
        </div>
      );
    }
    case "assistant":
      return (
        <div className="my-2 flex justify-start">
          <div
            className={`prose-chat max-w-[80%] rounded-2xl border px-3.5 py-2 text-[13.5px] ${it.error ? "border-amber-500/50 bg-amber-500/5" : "border-border/60"}`}
          >
            <ReactMarkdown>{it.text}</ReactMarkdown>
          </div>
        </div>
      );
    case "tool":
      return <ToolCard t={it.tool} />;
    case "error":
      // DD6: durable-looking error bubble with a retry affordance.
      return (
        <div className="my-2 flex justify-start">
          <div className="max-w-[80%] rounded-2xl border border-amber-500/50 bg-amber-500/5 px-3.5 py-2 text-[13.5px]">
            <span>{it.text}</span>
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="ml-2 underline decoration-dotted underline-offset-2 hover:opacity-80"
              >
                Retry
              </button>
            ) : null}
          </div>
        </div>
      );
    case "note":
      return <div className="my-2 text-[12px] italic text-muted-foreground">{it.text}</div>;
  }
}

/** The in-progress streamed turn — a markdown bubble with a blinking caret. */
export function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="my-2 flex justify-start">
      <div className="prose-chat max-w-[80%] rounded-2xl border border-border/60 px-3.5 py-2 text-[13.5px]">
        <ReactMarkdown>{text}</ReactMarkdown>
        <span className="animate-pulse" aria-hidden>
          ▍
        </span>
      </div>
    </div>
  );
}

/** The "working…" placeholder shown between a run start and the first delta. */
export function WorkingLine({ label }: { label: string }) {
  return <div className="my-2 text-[12px] text-muted-foreground">{label}</div>;
}

/** DD12: the "jump to latest" chip shown when the viewer has scrolled up. */
export function JumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <div className="sticky bottom-20 flex justify-center">
      <button
        type="button"
        onClick={onClick}
        className="rounded-full border border-border bg-background px-3 py-1 text-[12px] shadow-sm hover:bg-muted"
      >
        ↓ Jump to latest
      </button>
    </div>
  );
}

/** The sticky composer both copilot surfaces share. `running` swaps Send for
 * Stop (a run the head owns); `onRegenerate` shows the ↻ affordance. Enter
 * sends unless a run is in flight; the parent owns any double-send guard. */
export function Composer({
  value,
  onChange,
  onSend,
  ariaLabel,
  placeholder,
  disabled,
  running,
  onStop,
  onRegenerate,
  canRegenerate,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  ariaLabel: string;
  placeholder: string;
  disabled?: boolean;
  running?: boolean;
  onStop?: () => void;
  onRegenerate?: () => void;
  canRegenerate?: boolean;
  error?: string | null;
}) {
  return (
    <div className="sticky bottom-4 mt-6">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-2 py-1.5 shadow-sm focus-within:border-primary">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!running) onSend();
            }
          }}
          disabled={disabled}
          aria-label={ariaLabel}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent px-2 py-1 text-[13px] outline-none disabled:opacity-50"
        />
        {running && onStop ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] hover:bg-muted"
          >
            Stop
          </button>
        ) : (
          <>
            {canRegenerate && onRegenerate ? (
              <button
                type="button"
                onClick={onRegenerate}
                title="Regenerate the last answer"
                aria-label="Regenerate the last answer"
                className="rounded-lg px-2 py-1.5 text-[12.5px] text-muted-foreground hover:bg-muted"
              >
                ↻
              </button>
            ) : null}
            <button
              type="button"
              onClick={onSend}
              disabled={disabled || !value.trim()}
              className="rounded-lg bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              Send
            </button>
          </>
        )}
      </div>
      {error ? (
        <StatusText tone="error" className="mt-1.5">
          {error}
        </StatusText>
      ) : null}
    </div>
  );
}
