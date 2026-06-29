/**
 * Run rows (Activities redesign): the In-progress live cards, the desktop runs
 * table, and the mobile stacked cards. All three render the decorated `RunRow`
 * shape from the view-model and link into the shared run detail route.
 */

import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { RunRow } from "@/lib/runs-portal/model";
import { RUN_BLUE } from "@/lib/runs-portal/palette";
import { StatusMark, ActorChip } from "./run-status-icon";

/** Resolve a row's detail href, or null when its repo slug is unknown. */
export type HrefOf = (row: RunRow) => string | null;

/** The stacked jobs bar (succeeded / failed / running / queued segments). */
function JobsBar({ row }: { row: RunRow }) {
  const j = row.jobs;
  return (
    <div className="flex h-[5px] overflow-hidden rounded-[3px] bg-muted">
      <span style={{ width: `${j.okPct}%`, background: "hsl(var(--success))" }} />
      <span style={{ width: `${j.failPct}%`, background: "hsl(var(--destructive))" }} />
      <span style={{ width: `${j.runPct}%`, background: RUN_BLUE }} />
      <span style={{ width: `${j.queuedPct}%`, background: "hsl(var(--muted-foreground) / 0.35)" }} />
    </div>
  );
}

function JobsSummary({ row }: { row: RunRow }) {
  const j = row.jobs;
  return (
    <span className="font-mono text-[11px] text-muted-foreground">
      {j.succeeded}✓ {j.hasFail ? <span style={{ color: "hsl(var(--destructive))" }}>{j.failed}✗ </span> : null}·{" "}
      {j.total}
    </span>
  );
}

const ENV_BADGE =
  "inline-flex h-5 items-center rounded-[5px] border border-border bg-muted px-2 font-mono text-[11px] text-muted-foreground";

// ── In-progress live cards ───────────────────────────────────

export function LiveRuns({ rows, hrefOf }: { rows: RunRow[]; hrefOf: HrefOf }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-[9px]">
      <div className="flex items-center gap-2">
        <span className="h-[6px] w-[6px] animate-pulse rounded-full" style={{ background: RUN_BLUE }} />
        <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          In progress
        </span>
      </div>
      {rows.map((r) => {
        const href = hrefOf(r);
        const inner = (
          <>
            <div className="flex items-center gap-[10px]">
              <StatusMark vis={r.vis} box={28} glyph={15} radius={8} strokeWidth={2.2} />
              <span className="text-[13px] font-medium text-foreground">{r.repo}</span>
              <span className="min-w-0 truncate text-[13px] text-muted-foreground">{r.title}</span>
              <span className={`ml-auto shrink-0 ${ENV_BADGE}`}>{r.envLabel}</span>
              <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground/70">{r.duration}</span>
            </div>
            <div className="mt-[11px] h-[5px] overflow-hidden rounded-[3px] bg-muted">
              <div
                className="h-full animate-pulse rounded-[3px]"
                style={{ width: `${r.jobs.progress}%`, background: RUN_BLUE }}
              />
            </div>
            <div className="mt-[9px] flex items-center gap-2">
              <span className="flex items-center gap-1.5">
                <ActorChip actor={r.actor} box={17} />
                <span className="font-mono text-[11.5px] text-muted-foreground">
                  {r.shortId} · {r.provenance} · {r.sourceLabel}
                </span>
              </span>
              <span className="ml-auto font-mono text-[11.5px] text-muted-foreground/70">
                {r.jobs.succeeded} done · {r.jobs.running} running · {r.jobs.queued} queued
              </span>
            </div>
          </>
        );
        const cls =
          "block rounded-[11px] border border-border bg-card p-[13px_15px] text-left transition-colors hover:border-input";
        return href ? (
          <Link key={r.key} href={href} data-runrow className={cls}>
            {inner}
          </Link>
        ) : (
          <div key={r.key} data-runrow className={cls}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

// ── Desktop table ────────────────────────────────────────────

const COLS = "minmax(150px,1.3fr) minmax(120px,1fr) minmax(150px,1.2fr) 116px minmax(140px,1fr) 96px 92px 30px";
const HEAD = "text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground";

export function RunsTable({ rows, hrefOf }: { rows: RunRow[]; hrefOf: HrefOf }) {
  return (
    <div className="overflow-hidden rounded-[13px] border border-border bg-card">
      <div className="overflow-x-auto">
        <div className="min-w-[1040px]">
          {/* header */}
          <div
            className="grid items-center gap-3 border-b border-border bg-muted/40 px-4 py-[10px]"
            style={{ gridTemplateColumns: COLS }}
          >
            <span className={HEAD}>Run</span>
            <span className={HEAD}>Repo</span>
            <span className={HEAD}>Trigger</span>
            <span className={HEAD}>Environment</span>
            <span className={HEAD}>Jobs</span>
            <span className={HEAD}>Duration</span>
            <span className={HEAD}>Created</span>
            <span />
          </div>
          {rows.map((r) => {
            const href = hrefOf(r);
            const cells = (
              <>
                {/* run id + title */}
                <span className="flex min-w-0 items-center gap-[9px]">
                  <StatusMark vis={r.vis} box={24} glyph={13} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] text-foreground">{r.title}</span>
                    <span className="font-mono text-[11px] text-muted-foreground/70">{r.shortId}</span>
                  </span>
                </span>
                {/* repo */}
                <span className="truncate text-[13px] text-foreground/90">{r.repo}</span>
                {/* trigger */}
                <span className="flex min-w-0 items-center gap-[7px]">
                  <ActorChip actor={r.actor} box={18} />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[12px] text-muted-foreground">{r.sourceLabel}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground/70">{r.provenance}</span>
                  </span>
                </span>
                {/* env */}
                <span>
                  <span className={ENV_BADGE}>{r.envLabel}</span>
                </span>
                {/* jobs */}
                <span className="flex min-w-0 flex-col gap-[5px]">
                  <JobsBar row={r} />
                  <JobsSummary row={r} />
                </span>
                {/* duration */}
                <span className="font-mono text-[12px] text-muted-foreground">{r.duration}</span>
                {/* created */}
                <span className="whitespace-nowrap font-mono text-[12px] text-muted-foreground/70">{r.rel}</span>
                {/* chevron */}
                <span className="grid place-items-center text-muted-foreground/50" data-rowgo>
                  <ChevronRight className="h-3.5 w-3.5" />
                </span>
              </>
            );
            const cls = "grid items-center gap-3 border-b border-border/60 px-4 py-[11px] transition-colors";
            return href ? (
              <Link
                key={r.key}
                href={href}
                data-runrow
                className={`${cls} hover:bg-muted/40`}
                style={{ gridTemplateColumns: COLS }}
              >
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

// ── Mobile stacked cards ─────────────────────────────────────

export function RunCards({ rows, hrefOf }: { rows: RunRow[]; hrefOf: HrefOf }) {
  return (
    <div className="space-y-3">
      {rows.map((r) => {
        const href = hrefOf(r);
        const inner = (
          <>
            <div className="flex items-start gap-[10px]">
              <StatusMark vis={r.vis} box={26} glyph={14} radius={7} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-foreground">{r.title}</div>
                <div className="font-mono text-[11px] text-muted-foreground/70">{r.repo} · {r.shortId}</div>
              </div>
              <span className={ENV_BADGE}>{r.envLabel}</span>
            </div>
            <div className="mt-[10px] flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="flex items-center gap-1.5">
                <ActorChip actor={r.actor} box={16} />
                <span className="font-mono text-[11px] text-muted-foreground">
                  {r.sourceLabel} · {r.provenance}
                </span>
              </span>
              <JobsSummary row={r} />
              <span className="ml-auto font-mono text-[11px] text-muted-foreground/70">{r.rel}</span>
            </div>
          </>
        );
        const cls = "block rounded-[11px] border border-border bg-card p-4 text-left";
        return href ? (
          <Link key={r.key} href={href} className={cls}>
            {inner}
          </Link>
        ) : (
          <div key={r.key} className={cls}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
