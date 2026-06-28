/**
 * Catalog portal dependency Map view (saas-catalog-portal CP2).
 * System-column layout with SVG edges and positioned nodes, matching the
 * design. Selection highlights touching edges and the node itself.
 */

import * as React from "react";
import type { MapModel } from "@/lib/catalog-portal/layout";
import { PathIcon } from "./icon";

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-[#71717a]">
      <span className="h-[7px] w-[7px] rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

export function MapView({
  model,
  selectedKey,
  onSelect,
  onOpen,
}: {
  model: MapModel;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
}) {
  return (
    <div className="flex min-h-[68dvh] flex-col overflow-hidden rounded-[13px] border border-[#1a1a1e] bg-[#0a0a0d] md:min-h-0 md:flex-1">
      <div className="flex items-center gap-4 border-b border-b-[#18181b] px-4 py-[11px]">
        <span className="text-[12.5px] font-semibold text-[#e4e4e7]">Dependency map</span>
        <span className="text-[11.5px] text-[#71717a]">{model.count} services · grouped by system</span>
        <div className="ml-auto flex items-center gap-3.5">
          <Legend color="#34d399" label="Healthy" />
          <Legend color="#fbbf24" label="Degraded" />
          <Legend color="#f87171" label="Down" />
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {/* system column headers */}
        <div
          className="pointer-events-none absolute inset-0 grid"
          style={{ gridTemplateColumns: `repeat(${model.colCount}, minmax(0, 1fr))` }}
        >
          {model.columns.map((c) => (
            <div
              key={c}
              className="border-l border-l-[#141417] pt-3 text-center font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#3f3f46]"
            >
              {c}
            </div>
          ))}
        </div>
        {/* edges */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          {model.edges.map((e, i) => {
            const sel = e.fromKey === selectedKey || e.toKey === selectedKey;
            return (
              <line
                key={i}
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke={sel ? "rgba(245,158,11,.55)" : "rgba(255,255,255,.07)"}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
        {/* nodes */}
        {model.nodes.map((n) => {
          const sel = n.key === selectedKey;
          return (
            <button
              key={n.key}
              type="button"
              data-gnode
              onClick={() => onSelect(n.key)}
              onDoubleClick={() => onOpen(n.key)}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-[7px] rounded-lg border py-[5px] pl-[7px] pr-[9px] shadow-[0_2px_8px_rgba(0,0,0,.4)] transition-[filter] hover:brightness-125"
              style={{
                left: `${n.x}%`,
                top: `${n.y}%`,
                background: sel ? "rgba(245,158,11,.14)" : "#141417",
                borderColor: sel ? "#f59e0b" : "#26262b",
              }}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: n.healthColor }} />
              <span className="grid place-items-center text-[#a1a1aa]">
                <PathIcon d={n.iconD} size={13} />
              </span>
              <span
                className="whitespace-nowrap text-[11.5px] font-medium"
                style={{ color: sel ? "#fde68a" : "#d4d4d8" }}
              >
                {n.name}
              </span>
            </button>
          );
        })}
        {model.count === 0 ? (
          <div className="absolute inset-0 grid place-items-center text-[13px] text-[#52525b]">
            No services to map for these filters.
          </div>
        ) : null}
      </div>
    </div>
  );
}
