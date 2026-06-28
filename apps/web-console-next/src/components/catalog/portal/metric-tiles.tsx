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

const TILE = "rounded-xl border border-[#1c1c20] bg-[#0d0d10] px-4 py-[11px]";
const LABEL = "font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#71717a]";
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
        <div className={`${VALUE} text-[#fafafa]`} title={`across ${rollup.systems} systems`}>
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
        <div className={`${VALUE} text-[#fafafa]`} title={`${rollup.ready} of ${rollup.scored} services`}>
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
          background: attention ? "rgba(245,158,11,.08)" : "#0d0d10",
          borderColor: attention ? "rgba(245,158,11,.4)" : "#1c1c20",
        }}
      >
        <div
          className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em]"
          style={{ color: attention ? "#f59e0b" : "#71717a" }}
        >
          Needs attention <span className="text-[9px]">{attention ? "● filtering" : "›"}</span>
        </div>
        <div className={`${VALUE} text-[#fafafa]`}>{rollup.attention}</div>
      </button>
    </div>
  );
}
