"use client";

// v4 hierarchy chips (orun-work-v4 WH2). Two truth sources, two chips:
// intent state is the AUTHORED ladder (who approved what revision) and is
// never rendered without "of what" (V4-2); health/progress are FOLDS with
// named evidence — nothing here accepts input (V4-4).

import * as React from "react";
import type { WorkEpicIntentView, WorkHealth, WorkRung } from "@saas/contracts/work";
import { Pill, type Tone } from "@/components/ui/northwind";

export function shortDigest(rev?: string): string {
  if (!rev) return "";
  const hex = rev.startsWith("sha256:") ? rev.slice(7) : rev;
  return hex.slice(0, 7);
}

const INTENT_LABEL: Record<string, string> = {
  draft: "Draft",
  in_review: "In Review",
  approved: "Approved",
  approved_drifted: "Approved · drifted",
  adopted: "Adopted",
  superseded: "Superseded",
  canceled: "Canceled",
};

const INTENT_TONE: Record<string, Tone> = {
  draft: "neutral",
  in_review: "info",
  approved: "success",
  approved_drifted: "warning",
  adopted: "success",
  superseded: "neutral",
  canceled: "neutral",
};

/** The intent chip pair: `Approved @3f2a by usr_…` beside `drifted (doc now
 *  @9c41)` when stale. The tracker never lies for you — it renders both. */
export function IntentChip({
  intent,
  compact = false,
}: {
  intent: WorkEpicIntentView | undefined;
  /** Pill only (rails, dense rows) — the revision stays, the prose goes. */
  compact?: boolean;
}) {
  if (!intent) return null;
  const label = INTENT_LABEL[intent.state] ?? intent.state;
  const tone = INTENT_TONE[intent.state] ?? "neutral";
  const approval = intent.approval;
  if (compact) {
    return (
      <Pill tone={tone}>
        {label}
        {approval?.revision ? <span className="ml-1 font-mono opacity-80">@{shortDigest(approval.revision)}</span> : null}
      </Pill>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Pill tone={tone}>
        {label}
        {approval?.revision ? <span className="ml-1 font-mono opacity-80">@{shortDigest(approval.revision)}</span> : null}
      </Pill>
      {approval && (intent.state === "approved" || intent.state === "approved_drifted") ? (
        <span className="text-[11.5px] text-muted-foreground" title={approval.at}>
          by {approval.by.id}
        </span>
      ) : null}
      {intent.state === "approved_drifted" ? (
        <span className="text-[11.5px] text-warning-accent">
          {intent.docDrifted && intent.currentRevision
            ? `doc now @${shortDigest(intent.currentRevision)}`
            : intent.ladderDrifted
              ? "milestones changed"
              : "drifted"}
          {" — re-approval required"}
        </span>
      ) : null}
    </span>
  );
}

const HEALTH_LABEL: Record<WorkHealth, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
};

const HEALTH_TONE: Record<WorkHealth, Tone> = {
  on_track: "success",
  at_risk: "warning",
  off_track: "error",
};

/** Derived health with its evidence one hover away. A pinned health renders
 *  BESIDE the derived value, attributed, and auto-expires on catch-up. */
export function HealthChip({
  health,
  evidence,
  pinned,
}: {
  health: WorkHealth | undefined;
  evidence?: string[] | undefined;
  pinned?: { health: WorkHealth; by: { id: string }; note?: string | undefined } | undefined;
}) {
  if (!health) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span title={evidence?.join(" · ")}>
        <Pill tone={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</Pill>
      </span>
      {pinned ? (
        <span
          className="text-[11.5px] text-muted-foreground"
          title={pinned.note ? `“${pinned.note}”` : undefined}
        >
          pinned {HEALTH_LABEL[pinned.health].toLowerCase()} by {pinned.by.id}
        </span>
      ) : null}
    </span>
  );
}

/** The two-band derived progress bar (done+released / active) used at every
 *  level of the drill-down. */
export function ProgressBar({
  counts,
  total,
  className,
}: {
  counts: Partial<Record<WorkRung, number>> | undefined;
  total: number;
  className?: string;
}) {
  if (!total) return null;
  const done = (counts?.done ?? 0) + (counts?.released ?? 0);
  const active = (counts?.in_progress ?? 0) + (counts?.in_review ?? 0);
  return (
    <span
      aria-hidden
      className={`flex h-[5px] w-24 shrink-0 overflow-hidden rounded-[3px] bg-[#EDEDED] dark:bg-secondary ${className ?? ""}`}
    >
      {done > 0 ? <span className="bg-success" style={{ width: `${(done / total) * 100}%` }} /> : null}
      {active > 0 ? <span className="bg-warning-accent" style={{ width: `${(active / total) * 100}%` }} /> : null}
    </span>
  );
}
