"use client";

// Catalog data-quality bar (saas-service-catalog SC4). A compact summary of the
// loaded view — owner coverage plus clickable chips for each gap that, when
// toggled, filter the catalog down to the offending components.

import { cn } from "@/lib/cn";
import { type CatalogInsights, type InsightId, INSIGHT_LABEL } from "@/lib/catalog-insights";

const ORDER: InsightId[] = ["missing-owner", "missing-lifecycle", "dangling-deps"];

export function InsightsBar({
  insights,
  active,
  onToggle,
}: {
  insights: CatalogInsights;
  active: InsightId | null;
  onToggle: (id: InsightId | null) => void;
}) {
  const chips = ORDER.filter((id) => insights.counts[id] > 0);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/40 px-3 py-2 text-xs">
      <span className="font-medium">
        {insights.total} component{insights.total === 1 ? "" : "s"} in view
      </span>
      <span className="text-muted-foreground">·</span>
      <span
        className={cn(
          insights.ownedPct >= 80 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
        )}
      >
        {insights.ownedPct}% owned
      </span>
      {chips.length > 0 ? <span className="text-muted-foreground">·</span> : null}
      {chips.map((id) => {
        const on = active === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onToggle(on ? null : id)}
            aria-pressed={on}
            className={cn(
              "rounded-full border px-2 py-0.5 transition-colors",
              on
                ? "border-primary bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {INSIGHT_LABEL[id]} {insights.counts[id]}
          </button>
        );
      })}
      {active ? (
        <button
          type="button"
          onClick={() => onToggle(null)}
          className="ml-auto text-muted-foreground underline-offset-2 hover:underline"
        >
          Clear
        </button>
      ) : chips.length === 0 ? (
        <span className="ml-auto text-muted-foreground">No gaps in this view.</span>
      ) : null}
    </div>
  );
}
