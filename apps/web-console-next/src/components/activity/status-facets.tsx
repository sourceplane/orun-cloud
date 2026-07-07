/**
 * Status facet chips (Activities, Northwind design).
 *
 * The design's status chips — All · Running · Succeeded · Failed — each with a
 * tone-coloured dot and a live count over the loaded feed. Pending / Canceled
 * (part of the real run vocabulary) appear only while they have rows, keeping
 * the row quiet without losing the filter. Active chip is the black Chip.
 */

import * as React from "react";
import type { RunStatus } from "@saas/contracts/state";
import type { StatusFacet } from "@/lib/runs-portal/model";
import { Chip, toneDot, type Tone } from "@/components/ui/northwind";
import { cn } from "@/lib/cn";

const FACET_TONE: Record<RunStatus, Tone> = {
  running: "info",
  succeeded: "success",
  failed: "error",
  pending: "neutral",
  canceled: "neutral",
};

/** Facets always shown, even at count 0 (the design's core vocabulary). */
const CORE = new Set<StatusFacet["key"]>(["all", "running", "succeeded", "failed"]);

export function StatusFacets({
  facets,
  onSelect,
}: {
  facets: StatusFacet[];
  onSelect: (key: "all" | RunStatus) => void;
}) {
  return (
    <div className="contents" role="group" aria-label="Filter by status">
      {facets
        .filter((f) => CORE.has(f.key) || f.count > 0 || f.active)
        .map((f) => (
          <Chip key={f.key} active={f.active} aria-pressed={f.active} onClick={() => onSelect(f.key)}>
            {f.key !== "all" ? (
              <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", toneDot[FACET_TONE[f.key]])} />
            ) : null}
            {f.key === "all" ? f.label : `${f.label} · ${f.count}`}
          </Chip>
        ))}
    </div>
  );
}
