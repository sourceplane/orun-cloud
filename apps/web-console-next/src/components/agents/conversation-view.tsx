"use client";

// ConversationView (saas-agents-live AL7): renders the folded session
// conversation — attributed turns, collapsible tool cards, note lines, and
// sticky approval cards — the console head's stage. It renders exactly what
// the orun TUI head renders because both fold the same event vocabulary
// through the shared contract (lib/agents/conversation.ts).

import * as React from "react";
import { Pill, StatusText } from "@/components/ui/northwind";
import { foldConversation, type ConversationEvent, type PendingApproval } from "@/lib/agents/conversation";

export function ConversationView({
  events,
  activity,
  onApprove,
  onDeny,
  interacting,
}: {
  events: ConversationEvent[];
  /** The live activity line (streamed deltas / cost); overrides the fold's. */
  activity?: string;
  onApprove?: (a: PendingApproval) => void;
  onDeny?: (a: PendingApproval) => void;
  /** True while a verdict/steer is in flight (disables the buttons). */
  interacting?: boolean;
}) {
  const convo = React.useMemo(() => foldConversation(events), [events]);
  const activityLine = activity ?? convo.activity;

  return (
    <div className="space-y-3">
      {convo.items.map((it) => {
        switch (it.kind) {
          case "agent":
            return (
              <div key={it.key} className="flex gap-2.5">
                <span className="shrink-0 pt-0.5 text-[12px] font-semibold text-primary">agent</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap text-[13px]">{it.text}</span>
              </div>
            );
          case "user":
            return (
              <div key={it.key} className="flex gap-2.5">
                <span className="shrink-0 pt-0.5 text-[12px] font-semibold text-foreground">
                  {it.principal || "you"}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap text-[13px]">{it.text}</span>
              </div>
            );
          case "tool":
            return (
              <div key={it.key} className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span aria-hidden>⚙</span>
                <span className="font-mono">{it.text}</span>
                {it.detail ? <span className="opacity-70">({it.detail})</span> : null}
              </div>
            );
          default:
            return (
              <div key={it.key} className="text-[12px] text-muted-foreground">
                {it.text}
              </div>
            );
        }
      })}

      {activityLine ? (
        <div className="text-[12px] italic text-muted-foreground">{activityLine} …</div>
      ) : null}

      {/* Sticky approval cards — impossible to scroll off while pending. */}
      {convo.pending.length > 0 ? (
        <div className="sticky bottom-0 space-y-2 border-t border-border/60 bg-background/95 py-3 backdrop-blur">
          {convo.pending.map((a) => (
            <div
              key={a.requestId}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2"
            >
              <Pill tone="warning">approval</Pill>
              <span className="font-mono text-[12.5px]">{a.tool}</span>
              <span className="text-[11.5px] text-muted-foreground">({a.requestId})</span>
              <span className="ml-auto flex gap-1.5">
                <button
                  type="button"
                  disabled={interacting}
                  onClick={() => onApprove?.(a)}
                  className="rounded-md border border-success/50 px-2.5 py-1 text-[12px] text-success hover:bg-success/10 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={interacting}
                  onClick={() => onDeny?.(a)}
                  className="rounded-md border border-error/50 px-2.5 py-1 text-[12px] text-error hover:bg-error/10 disabled:opacity-50"
                >
                  Deny
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {convo.items.length === 0 ? (
        <StatusText tone="neutral">The runtime relays its session log here once the sandbox dials home.</StatusText>
      ) : null}
    </div>
  );
}
