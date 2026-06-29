/**
 * Status facet pills (Activities redesign).
 *
 * The design's status chips — All · Running · Succeeded · Failed · Pending ·
 * Canceled — each with a live count over the loaded feed. The active pill takes
 * the amber primary tint; the rest are quiet outlines.
 */

import * as React from "react";
import type { RunStatus } from "@saas/contracts/state";
import type { StatusFacet } from "@/lib/runs-portal/model";

export function StatusFacets({
  facets,
  onSelect,
}: {
  facets: StatusFacet[];
  onSelect: (key: "all" | RunStatus) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-[5px]" role="group" aria-label="Filter by status">
      {facets.map((f) => (
        <button
          key={f.key}
          type="button"
          data-facet
          aria-pressed={f.active}
          onClick={() => onSelect(f.key)}
          className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] font-medium transition-colors"
          style={{
            borderColor: f.active ? "hsl(var(--primary) / 0.4)" : "hsl(var(--border))",
            background: f.active ? "hsl(var(--primary) / 0.1)" : "transparent",
            color: f.active ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))",
          }}
        >
          {f.label}
          <span
            className="font-mono text-[10.5px]"
            style={{ color: f.active ? "hsl(var(--primary))" : "hsl(var(--muted-foreground) / 0.7)" }}
          >
            {f.count}
          </span>
        </button>
      ))}
    </div>
  );
}
