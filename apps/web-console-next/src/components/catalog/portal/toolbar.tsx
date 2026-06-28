/**
 * Catalog portal toolbar (saas-catalog-portal CP1).
 * Search · kind / lifecycle / health selects · group-by · Table/Board/Map
 * tabs — matching the design.
 */

import * as React from "react";
import { List, Columns3, Share2, Search, ListFilter } from "lucide-react";
import type { CatalogFilters } from "@/lib/catalog-portal/filter";
import type { GroupKey } from "@/lib/catalog-portal/filter";

export type PortalView = "list" | "board" | "graph";

function Caret() {
  return (
    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[#52525b]">
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
        className={`h-[34px] appearance-none rounded-lg border border-[#232327] bg-[#0d0d10] py-0 pr-[26px] text-[12.5px] text-[#d4d4d8] outline-none ${
          leftIcon ? "pl-8" : "pl-[11px]"
        }`}
      >
        {children}
      </select>
      {leftIcon ? (
        <ListFilter className="pointer-events-none absolute left-[11px] top-1/2 h-[13px] w-[13px] -translate-y-1/2 text-[#71717a]" />
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

export function CatalogToolbar({
  filters,
  setFilters,
  group,
  setGroup,
  view,
  setView,
}: {
  filters: CatalogFilters;
  setFilters: (patch: Partial<CatalogFilters>) => void;
  group: GroupKey;
  setGroup: (g: GroupKey) => void;
  view: PortalView;
  setView: (v: PortalView) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[#71717a]" />
        <input
          value={filters.query}
          onChange={(e) => setFilters({ query: e.target.value })}
          placeholder="Search services, refs, owners…"
          aria-label="Search services"
          className="h-[34px] w-[260px] rounded-lg border border-[#232327] bg-[#0d0d10] pl-[30px] pr-[11px] text-[13px] text-[#e4e4e7] outline-none placeholder:text-[#52525b]"
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

      <span className="mx-0.5 h-[22px] w-px bg-[#232327]" />

      <PortalSelect ariaLabel="Group by" value={group} onChange={(v) => setGroup(v as GroupKey)} leftIcon>
        <option value="none">No grouping</option>
        <option value="team">Group by team</option>
        <option value="system">Group by system</option>
        <option value="lifecycle">Group by lifecycle</option>
      </PortalSelect>

      <div
        className="ml-auto inline-flex rounded-lg border border-[#232327] bg-[#0d0d10] p-0.5"
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
              className="flex h-7 items-center gap-1.5 rounded-md px-[11px] text-[12.5px] font-medium transition-colors"
              style={{ background: active ? "#26262b" : "transparent", color: active ? "#fafafa" : "#a1a1aa" }}
            >
              {TAB_ICON[v]}
              {TAB_LABEL[v]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
