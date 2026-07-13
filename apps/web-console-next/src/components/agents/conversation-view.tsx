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
  emptyHint,
}: {
  events: ConversationEvent[];
  /** The live activity line (streamed deltas / cost); overrides the fold's. */
  activity?: string;
  onApprove?: (a: PendingApproval) => void;
  onDeny?: (a: PendingApproval) => void;
  /** True while a verdict/steer is in flight (disables the buttons). */
  interacting?: boolean;
  /** Empty-state line — the caller varies it by state (a terminal session
   * that never relayed a log reads differently than one still dialing home). */
  emptyHint?: string;
}) {
  const convo = React.useMemo(() => foldConversation(events), [events]);
  const activityLine = activity ?? convo.activity;

  return (
    <div className="space-y-4">
      {convo.items.map((it) => {
        switch (it.kind) {
          case "agent":
            return (
              <div key={it.key} className="flex gap-3">
                <AgentAvatar />
                <span className="min-w-0 flex-1 whitespace-pre-wrap pt-0.5 text-[13.5px] leading-relaxed">
                  {it.text}
                </span>
              </div>
            );
          case "user":
            return (
              <div key={it.key} className="flex gap-3">
                <UserAvatar principal={it.principal ?? "you"} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-muted-foreground">
                    {it.principal || "you"} · steer
                  </div>
                  <div className="mt-1 inline-block rounded-lg bg-muted px-3 py-2 text-[13px] leading-relaxed">
                    {it.text}
                  </div>
                </div>
              </div>
            );
          case "tool":
            return (
              <div
                key={it.key}
                className="ml-10 flex items-center gap-2.5 rounded-lg border border-border/70 px-3 py-2"
              >
                <span className="text-[12px] text-muted-foreground" aria-hidden>
                  ⌘
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{it.text}</span>
                {it.detail ? (
                  <Pill tone={decisionTone(it.detail)}>{it.detail}</Pill>
                ) : null}
              </div>
            );
          default:
            // Note lines (state changes, artifacts, harness) — centered, muted,
            // with a small dot, the mock's timeline dividers.
            return (
              <div key={it.key} className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
                <span className="truncate">{it.text}</span>
              </div>
            );
        }
      })}

      {activityLine ? (
        <div className="ml-10 flex items-center gap-2 text-[12px] italic text-muted-foreground">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-info" aria-hidden />
          {activityLine}
        </div>
      ) : null}

      {/* Sticky approval cards — impossible to scroll off while pending. The
          mock's shape: a titled warn-washed card with the command, the policy
          reason prose, then Approve / Deny. */}
      {convo.pending.length > 0 ? (
        <div className="sticky bottom-0 space-y-3 pt-2">
          {convo.pending.map((a) => (
            <div
              key={a.requestId}
              className="rounded-xl border border-warning/40 bg-warning/[0.06] px-4 py-3"
            >
              <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-warning">
                <span aria-hidden>⚠</span> Approval needed
              </div>
              <div className="mt-2 rounded-lg border border-border/70 bg-background px-3 py-2 font-mono text-[12.5px]">
                {a.tool}
              </div>
              {a.reason ? (
                <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{a.reason}</p>
              ) : null}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={interacting}
                  onClick={() => onApprove?.(a)}
                  className="rounded-lg bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={interacting}
                  onClick={() => onDeny?.(a)}
                  className="rounded-lg border border-border px-3.5 py-1.5 text-[12.5px] hover:bg-muted disabled:opacity-50"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {convo.items.length === 0 ? (
        <StatusText tone="neutral">
          {emptyHint ?? "The runtime relays its session log here once the sandbox dials home."}
        </StatusText>
      ) : null}
    </div>
  );
}

/** The agent's square-star avatar (the fleet convention for agent actors). */
function AgentAvatar() {
  return (
    <span
      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[13px] text-primary"
      aria-hidden
    >
      +
    </span>
  );
}

/** A human's round initials avatar. */
function UserAvatar({ principal }: { principal: string }) {
  const initials = principal.replace(/^usr_/, "").slice(0, 2).toUpperCase();
  return (
    <span
      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground"
      aria-hidden
    >
      {initials}
    </span>
  );
}

/** Tool-policy decision → pill tone: allow (calm), ask (warn), deny (error). */
function decisionTone(decision: string): "success" | "warning" | "error" | "neutral" {
  const d = decision.toLowerCase();
  if (d === "allow") return "success";
  if (d === "ask") return "warning";
  if (d === "deny") return "error";
  return "neutral";
}
