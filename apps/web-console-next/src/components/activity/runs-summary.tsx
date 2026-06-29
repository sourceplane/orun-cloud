/**
 * Activities summary strip (Activities redesign).
 *
 * The five-up rollup from the design: Runs today (with a sparkline), Success
 * rate, Running now (with a live dot), Failed (last 24h), and p50 duration.
 * Every value is computed over the loaded feed by the view-model's `summarize`.
 */

import * as React from "react";
import type { RunSummary } from "@/lib/runs-portal/model";
import { RUN_BLUE } from "@/lib/runs-portal/palette";

const CARD = "rounded-xl border border-border bg-card px-4 py-[13px]";
const LABEL = "font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground";
const VALUE = "text-[21px] font-semibold leading-none text-foreground";
const SUB = "mt-1 text-[10.5px] text-muted-foreground/70";

export function RunsSummary({ summary }: { summary: RunSummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-[1.5fr_1fr_1fr_1fr_1fr]">
      {/* Runs today + sparkline */}
      <div className={CARD}>
        <div className={LABEL}>Runs today</div>
        <div className="mt-[7px] flex items-end justify-between gap-3">
          <span className={VALUE}>{summary.today}</span>
          <div className="flex h-[26px] items-end gap-[3px]" aria-hidden="true">
            {summary.spark.map((bar, i) => (
              <span
                key={i}
                className="w-[5px] rounded-[1.5px] bg-muted-foreground"
                style={{ height: bar.h, opacity: bar.op }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Success rate */}
      <div className={CARD}>
        <div className={LABEL}>Success rate</div>
        <div className={`mt-[7px] ${VALUE}`}>{summary.rate}%</div>
        <div className={SUB}>finished runs</div>
      </div>

      {/* Running now */}
      <div className={CARD}>
        <div className={LABEL}>Running now</div>
        <div className="mt-[7px] flex items-center gap-[7px]">
          <span className={VALUE}>{summary.running}</span>
          {summary.running > 0 ? (
            <span
              className="h-[7px] w-[7px] animate-pulse rounded-full"
              style={{ background: RUN_BLUE }}
              aria-hidden="true"
            />
          ) : null}
        </div>
        <div className={SUB}>in progress</div>
      </div>

      {/* Failed */}
      <div className={CARD}>
        <div className={LABEL}>Failed</div>
        <div className={`mt-[7px] ${VALUE}`}>{summary.failed}</div>
        <div className={SUB}>last 24h</div>
      </div>

      {/* p50 duration */}
      <div className={CARD}>
        <div className={LABEL}>p50 duration</div>
        <div className={`mt-[7px] ${VALUE}`}>{summary.p50}</div>
        <div className={SUB}>median</div>
      </div>
    </div>
  );
}
