/**
 * Catalog portal metric tiles (saas-catalog-portal CP1).
 * Services · Ownership · Production-ready · Needs-attention (a toggle) — the
 * four-up grid from the design, fed by the view-model rollup.
 */

import * as React from "react";
import type { CatalogRollup } from "@/lib/catalog-portal/model";
import { ownedColor } from "@/lib/catalog-portal/palette";

const TILE = "rounded-xl border border-[#1c1c20] bg-[#0d0d10] px-4 py-3.5";
const LABEL = "font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#71717a]";

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="mt-[9px] h-1 overflow-hidden rounded-[3px] bg-[#1c1c20]">
      <div className="h-full rounded-[3px]" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

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
        <div className="mt-[7px] flex items-baseline gap-2">
          <span className="text-[27px] font-semibold leading-none text-[#fafafa]">{rollup.total}</span>
          <span className="text-[12px] text-[#71717a]">across {rollup.systems} systems</span>
        </div>
      </div>

      {/* Ownership */}
      <div className={TILE}>
        <div className={LABEL}>Ownership</div>
        <div className="mt-[7px] flex items-baseline gap-2">
          <span className="text-[27px] font-semibold leading-none" style={{ color: oc }}>
            {rollup.ownedPct}%
          </span>
          <span className="text-[12px] text-[#71717a]">
            {rollup.owned} of {rollup.total} owned
          </span>
        </div>
        <Bar pct={rollup.ownedPct} color={oc} />
      </div>

      {/* Production-ready */}
      <div className={TILE}>
        <div className={LABEL}>Production-ready</div>
        <div className="mt-[7px] flex items-baseline gap-2">
          <span className="text-[27px] font-semibold leading-none text-[#fafafa]">{rollup.readyPct}%</span>
          <span className="text-[12px] text-[#71717a]">
            {rollup.ready} of {rollup.scored} services
          </span>
        </div>
        <Bar pct={rollup.readyPct} color="#34d399" />
      </div>

      {/* Needs attention — a toggle */}
      <button
        type="button"
        onClick={onToggleAttention}
        aria-pressed={attention}
        className="rounded-xl border px-4 py-3.5 text-left transition-colors"
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
        <div className="mt-[7px] flex items-baseline gap-2">
          <span className="text-[27px] font-semibold leading-none text-[#fafafa]">{rollup.attention}</span>
          <span className="text-[12px] text-[#71717a]">unowned · degraded · down</span>
        </div>
      </button>
    </div>
  );
}
