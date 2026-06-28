/**
 * Catalog portal metric tiles (saas-catalog-portal CP1).
 * Services · Ownership · Production-ready · Needs-attention (a toggle) — the
 * four-up grid from the design, fed by the view-model rollup.
 *
 * Compact variant: label + value only (the per-tile subtext and progress bars
 * are dropped) so the header reclaims vertical space for the list. The detail
 * still lives in the drawer / dedicated page; each value carries a `title`
 * tooltip with the count it summarizes.
 */

import * as React from "react";
import type { CatalogRollup } from "@/lib/catalog-portal/model";
import { ownedColor } from "@/lib/catalog-portal/palette";

const TILE = "rounded-xl border border-border bg-card px-4 py-[11px]";
const LABEL = "font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground/80";
const VALUE = "mt-1.5 text-[22px] font-semibold leading-none";

export function MetricTiles({
  rollup,
  attention,
  onToggleAttention,
}: {
  rollup: CatalogRollup;
  attention: boolean;
  onToggleAttention: () => void;
}) {
  const oc = ownedColor(rollup.ownedPct);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {/* Services */}
      <div className={TILE}>
        <div className={LABEL}>Services</div>
        <div className={`${VALUE} text-foreground`} title={`across ${rollup.systems} systems`}>
          {rollup.total}
        </div>
      </div>

      {/* Ownership */}
      <div className={TILE}>
        <div className={LABEL}>Ownership</div>
        <div className={VALUE} style={{ color: oc }} title={`${rollup.owned} of ${rollup.total} owned`}>
          {rollup.ownedPct}%
        </div>
      </div>

      {/* Production-ready */}
      <div className={TILE}>
        <div className={LABEL}>Production-ready</div>
        <div className={`${VALUE} text-foreground`} title={`${rollup.ready} of ${rollup.scored} services`}>
          {rollup.readyPct}%
        </div>
      </div>

      {/* Needs attention — a toggle */}
      <button
        type="button"
        onClick={onToggleAttention}
        aria-pressed={attention}
        title="unowned · degraded · down"
        className="rounded-xl border px-4 py-[11px] text-left transition-colors"
        style={{
          background: attention ? "hsl(var(--primary) / 0.08)" : "hsl(var(--card))",
          borderColor: attention ? "hsl(var(--primary) / 0.4)" : "hsl(var(--border))",
        }}
      >
        <div
          className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em]"
          style={{ color: attention ? "hsl(var(--primary))" : "hsl(var(--muted-foreground) / 0.8)" }}
        >
          Needs attention <span className="text-[9px]">{attention ? "● filtering" : "›"}</span>
        </div>
        <div className={`${VALUE} text-foreground`}>{rollup.attention}</div>
      </button>
    </div>
  );
}
