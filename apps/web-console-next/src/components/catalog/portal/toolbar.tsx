/**
 * Catalog portal toolbar (saas-catalog-portal CP1).
 * Search · kind / lifecycle / health selects · group-by · Table/Board/Map
 * tabs — matching the design.
 */

import * as React from "react";
import { List, Columns3, Share2, Search, ListFilter, SlidersHorizontal, ArrowUpDown, X } from "lucide-react";
import type { CatalogFilters, SortDir, SortKey } from "@/lib/catalog-portal/filter";
import type { GroupKey } from "@/lib/catalog-portal/filter";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

export type PortalView = "list" | "board" | "graph";

function Caret() {
  return (
    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60">
      ▾
    </span>
  );
}

function PortalSelect({
  value,
  onChange,
  children,
  ariaLabel,
  leftIcon,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  ariaLabel: string;
  leftIcon?: boolean;
}) {
  return (
    <span className="relative">
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-[34px] appearance-none rounded-lg border border-border bg-card py-0 pr-[26px] text-[12.5px] text-foreground/90 outline-none ${
          leftIcon ? "pl-8" : "pl-[11px]"
        }`}
      >
        {children}
      </select>
      {leftIcon ? (
        <ListFilter className="pointer-events-none absolute left-[11px] top-1/2 h-[13px] w-[13px] -translate-y-1/2 text-muted-foreground/80" />
      ) : null}
      <Caret />
    </span>
  );
}

const TAB_ICON: Record<PortalView, React.ReactNode> = {
  list: <List className="h-3.5 w-3.5" />,
  board: <Columns3 className="h-3.5 w-3.5" />,
  graph: <Share2 className="h-3.5 w-3.5" />,
};
const TAB_LABEL: Record<PortalView, string> = { list: "Table", board: "Board", graph: "Map" };

function ViewToggle({
  view,
  setView,
  size = "sm",
}: {
  view: PortalView;
  setView: (v: PortalView) => void;
  size?: "sm" | "lg";
}) {
  return (
    <div
      className="inline-flex shrink-0 rounded-lg border border-border bg-card p-0.5"
      role="group"
      aria-label="View"
    >
      {(["list", "board", "graph"] as const).map((v) => {
        const active = view === v;
        return (
          <button
            key={v}
            type="button"
            aria-pressed={active}
            onClick={() => setView(v)}
            className={`flex items-center gap-1.5 rounded-md font-medium transition-colors ${
              size === "lg" ? "h-9 px-3 text-[13px]" : "h-7 px-[11px] text-[12.5px]"
            }`}
            style={{ background: active ? "hsl(var(--input))" : "transparent", color: active ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))" }}
          >
            {TAB_ICON[v]}
            {TAB_LABEL[v]}
          </button>
        );
      })}
    </div>
  );
}

// Full-width labelled select for the mobile filter/sort sheet — native picker
// (best on touch) with a comfortable 44px tap target.
function SheetSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground/80">{label}</span>
      <span className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-full appearance-none rounded-lg border border-border bg-card pl-3 pr-9 text-[14px] text-foreground outline-none"
        >
          {children}
        </select>
        <Caret />
      </span>
    </label>
  );
}

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "health", label: "Health" },
  { value: "readiness", label: "Readiness" },
  { value: "deploy", label: "Updated" },
];

export function CatalogToolbar({
  filters,
  setFilters,
  group,
  setGroup,
  view,
  setView,
  sortKey,
  sortDir,
  onSort,
  isDesktop,
}: {
  filters: CatalogFilters;
  setFilters: (patch: Partial<CatalogFilters>) => void;
  group: GroupKey;
  setGroup: (g: GroupKey) => void;
  view: PortalView;
  setView: (v: PortalView) => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  isDesktop: boolean;
}) {
  const [sheetOpen, setSheetOpen] = React.useState(false);

  // ── Mobile: full-width search + a Filters/Sort sheet + the view toggle ──────
  if (!isDesktop) {
    const activeCount =
      (filters.kind !== "all" ? 1 : 0) +
      (filters.lifecycle !== "all" ? 1 : 0) +
      (filters.health !== "all" ? 1 : 0) +
      (group !== "none" ? 1 : 0);
    return (
      <div className="flex flex-col gap-2.5">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground/80" />
          <input
            value={filters.query}
            onChange={(e) => setFilters({ query: e.target.value })}
            placeholder="Search services, refs, owners…"
            aria-label="Search services"
            className="h-11 w-full rounded-lg border border-border bg-card pl-10 pr-3 text-[15px] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground/90"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground/80" />
            Filter &amp; sort
            {activeCount > 0 ? (
              <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-[10.5px] font-semibold text-primary-foreground">
                {activeCount}
              </span>
            ) : null}
          </button>
          <div className="ml-auto">
            <ViewToggle view={view} setView={setView} size="lg" />
          </div>
        </div>

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" className="max-h-[88dvh] gap-0 rounded-t-[18px] px-0 pb-0">
            <div className="mx-auto mt-1 h-1 w-9 shrink-0 rounded-full bg-input" aria-hidden />
            <div className="flex items-center justify-between px-4 pb-2 pt-3">
              <SheetTitle className="text-[15px] font-semibold text-foreground">Filter &amp; sort</SheetTitle>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label="Close"
                className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground/80"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-1">
              <SheetSelect label="Kind" value={filters.kind} onChange={(v) => setFilters({ kind: v })}>
                <option value="all">All kinds</option>
                <option value="Component">Component</option>
                <option value="API">API</option>
                <option value="Resource">Resource</option>
              </SheetSelect>
              <SheetSelect
                label="Lifecycle"
                value={filters.lifecycle}
                onChange={(v) => setFilters({ lifecycle: v })}
              >
                <option value="all">Any lifecycle</option>
                <option value="production">Production</option>
                <option value="experimental">Experimental</option>
                <option value="deprecated">Deprecated</option>
              </SheetSelect>
              <SheetSelect label="Health" value={filters.health} onChange={(v) => setFilters({ health: v })}>
                <option value="all">Any health</option>
                <option value="healthy">Healthy</option>
                <option value="degraded">Degraded</option>
                <option value="down">Down</option>
              </SheetSelect>
              <SheetSelect label="Group by" value={group} onChange={(v) => setGroup(v as GroupKey)}>
                <option value="none">No grouping</option>
                <option value="team">Group by team</option>
                <option value="system">Group by system</option>
                <option value="lifecycle">Group by lifecycle</option>
              </SheetSelect>
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground/80">Sort by</span>
                <div className="flex gap-2">
                  <span className="relative flex-1">
                    <select
                      value={sortKey}
                      onChange={(e) => {
                        if (e.target.value !== sortKey) onSort(e.target.value as SortKey);
                      }}
                      aria-label="Sort by"
                      className="h-11 w-full appearance-none rounded-lg border border-border bg-card pl-3 pr-9 text-[14px] text-foreground outline-none"
                    >
                      {SORT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <Caret />
                  </span>
                  <button
                    type="button"
                    onClick={() => onSort(sortKey)}
                    aria-label={sortDir === "asc" ? "Ascending" : "Descending"}
                    className="flex h-11 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] text-foreground/90"
                  >
                    <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/80" />
                    {sortDir === "asc" ? "Asc" : "Desc"}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 gap-2.5 border-t border-t-border bg-background px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
              <button
                type="button"
                onClick={() => {
                  setFilters({ kind: "all", lifecycle: "all", health: "all" });
                  setGroup("none");
                }}
                className="h-11 flex-1 rounded-lg border border-border bg-transparent text-[14px] font-medium text-foreground/90"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="h-11 flex-[2] rounded-lg bg-primary text-[14px] font-semibold text-primary-foreground"
              >
                Show results
              </button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground/80" />
        <input
          value={filters.query}
          onChange={(e) => setFilters({ query: e.target.value })}
          placeholder="Search services, refs, owners…"
          aria-label="Search services"
          className="h-[34px] w-[260px] rounded-lg border border-border bg-card pl-[30px] pr-[11px] text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
        />
      </div>

      <PortalSelect ariaLabel="Kind" value={filters.kind} onChange={(v) => setFilters({ kind: v })}>
        <option value="all">All kinds</option>
        <option value="Component">Component</option>
        <option value="API">API</option>
        <option value="Resource">Resource</option>
      </PortalSelect>

      <PortalSelect ariaLabel="Lifecycle" value={filters.lifecycle} onChange={(v) => setFilters({ lifecycle: v })}>
        <option value="all">Any lifecycle</option>
        <option value="production">Production</option>
        <option value="experimental">Experimental</option>
        <option value="deprecated">Deprecated</option>
      </PortalSelect>

      <PortalSelect ariaLabel="Health" value={filters.health} onChange={(v) => setFilters({ health: v })}>
        <option value="all">Any health</option>
        <option value="healthy">Healthy</option>
        <option value="degraded">Degraded</option>
        <option value="down">Down</option>
      </PortalSelect>

      <span className="mx-0.5 h-[22px] w-px bg-border" />

      <PortalSelect ariaLabel="Group by" value={group} onChange={(v) => setGroup(v as GroupKey)} leftIcon>
        <option value="none">No grouping</option>
        <option value="team">Group by team</option>
        <option value="system">Group by system</option>
        <option value="lifecycle">Group by lifecycle</option>
      </PortalSelect>

      <div className="ml-auto">
        <ViewToggle view={view} setView={setView} />
      </div>
    </div>
  );
}
