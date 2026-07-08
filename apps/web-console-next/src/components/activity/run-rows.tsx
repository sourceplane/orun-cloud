/**
 * Run rows (Activities, Northwind design): the "In progress" live cards and the
 * "Earlier" runs table. Both render the decorated `RunRow` shape from the
 * view-model and link into the shared run detail route.
 */

import * as React from "react";
import Link from "next/link";
import { Bot } from "lucide-react";
import type { RunStatus } from "@saas/contracts/state";
import { cn } from "@/lib/cn";
import type { RunRow } from "@/lib/runs-portal/model";
import type { ActorAvatar } from "@/lib/runs-portal/palette";
import {
  PersonAvatar,
  RowChevron,
  RunProgress,
  StatusDot,
  toneDot,
  type Tone,
} from "@/components/ui/northwind";

/** Resolve a row's detail href, or null when its repo slug is unknown. */
export type HrefOf = (row: RunRow) => string | null;

/** Run status → Northwind tone (dots, pills, tinted text). */
export const RUN_TONE: Record<RunStatus, Tone> = {
  succeeded: "success",
  failed: "error",
  running: "info",
  pending: "neutral",
  canceled: "neutral",
};

/** 17px actor mark: neutral person avatar for humans, bot square for automation. */
export function ActorBadge({ actor, size = 17 }: { actor: ActorAvatar; size?: number }) {
  if (actor.bot) {
    return (
      <span
        aria-hidden
        title={actor.name}
        className="grid shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground"
        style={{ width: size, height: size }}
      >
        <Bot strokeWidth={2} style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62) }} />
      </span>
    );
  }
  return <PersonAvatar name={actor.name} size={size} />;
}

// ── In-progress live cards ───────────────────────────────────

export function LiveRuns({ rows, hrefOf }: { rows: RunRow[]; hrefOf: HrefOf }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-[22px]">
      <div className="mb-[9px] flex items-center gap-2">
        <StatusDot tone="info" live />
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-info">In progress</span>
      </div>
      <div className="flex flex-col gap-[9px]">
        {rows.map((r) => {
          const href = hrefOf(r);
          const finished = r.jobs.succeeded + r.jobs.failed;
          const inner = (
            <>
              <div className="flex items-center gap-[11px]">
                <span className="min-w-0 truncate text-[13.5px] font-semibold">{r.repo}</span>
                <span className="hidden min-w-0 truncate font-mono text-[11.5px] text-muted-foreground md:inline">
                  {r.shortId} · {r.provenance}
                </span>
                <span className="ml-auto shrink-0 text-xs tabular-nums text-info">
                  {r.status === "pending" ? "queued" : `${r.duration} elapsed`}
                </span>
              </div>
              <RunProgress
                className="mt-[13px]"
                donePercent={r.jobs.okPct + r.jobs.failPct}
                runningPercent={r.jobs.runPct}
              />
              <div className="mt-[10px] flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                <span>
                  {finished} of {r.jobs.total} jobs finished
                </span>
                <span aria-hidden className="hidden sm:inline">
                  ·
                </span>
                <span>
                  {r.jobs.running} running · {r.jobs.queued} queued
                  {r.jobs.failed > 0 ? <span className="text-destructive"> · {r.jobs.failed} failed</span> : null}
                </span>
                <span className="ml-auto flex min-w-0 items-center gap-1.5">
                  <ActorBadge actor={r.actor} />
                  <span className="truncate">
                    {r.actor.name} · via {r.sourceLabel}
                  </span>
                </span>
              </div>
            </>
          );
          const cls = "block rounded-xl border border-info/30 bg-card px-5 py-4 text-left transition-colors";
          return href ? (
            <Link key={r.key} href={href} data-runrow className={cn(cls, "hover:border-info/60")}>
              {inner}
            </Link>
          ) : (
            <div key={r.key} data-runrow className={cls}>
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Earlier runs table ───────────────────────────────────────

const COLS = "16px minmax(180px,1.4fr) minmax(160px,1.2fr) 110px 90px 90px 34px";

export function RunsTable({ rows, hrefOf }: { rows: RunRow[]; hrefOf: HrefOf }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          {rows.map((r) => {
            const href = hrefOf(r);
            const failed = r.status === "failed";
            const cells = (
              <>
                <span
                  aria-hidden
                  className={cn("h-2 w-2 justify-self-start rounded-full", toneDot[RUN_TONE[r.status]])}
                />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-foreground">{r.repo}</span>
                  <span className="mt-px block truncate font-mono text-[11px] text-muted-foreground/85">
                    {r.shortId}
                    {r.branch ? ` · ${r.branch}` : ""}
                  </span>
                </span>
                <span className="truncate font-mono text-[11.5px] text-muted-foreground">{r.commit7 ?? "—"}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-secondary-foreground">
                  <ActorBadge actor={r.actor} />
                  <span className="truncate">{r.actor.name}</span>
                </span>
                <span className={cn("text-xs tabular-nums", failed ? "text-destructive" : "text-muted-foreground")}>
                  {r.duration}
                </span>
                <span className="whitespace-nowrap text-xs text-muted-foreground">{r.rel}</span>
                <span className="grid place-items-center">
                  <RowChevron className="ml-0" />
                </span>
              </>
            );
            const cls = cn(
              "grid items-center gap-3 border-b border-border/50 px-5 py-[13px] transition-colors last:border-b-0",
              failed ? "bg-destructive-wash" : href && "hover:bg-muted",
              href && "group cursor-pointer",
            );
            return href ? (
              <Link key={r.key} href={href} data-runrow className={cls} style={{ gridTemplateColumns: COLS }}>
                {cells}
              </Link>
            ) : (
              <div key={r.key} data-runrow className={cls} style={{ gridTemplateColumns: COLS }}>
                {cells}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
