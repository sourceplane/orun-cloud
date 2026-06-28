/**
 * Catalog portal Table view (saas-catalog-portal CP1).
 * The 7-column sortable, groupable table from the design.
 */

import * as React from "react";
import { Search, Workflow, ChevronRight } from "lucide-react";
import type { CatalogService } from "@/lib/catalog-portal/model";
import type { DecoratedService } from "@/lib/catalog-portal/model";
import type { CatalogGroup, SortDir, SortKey } from "@/lib/catalog-portal/filter";
import { PathIcon } from "./icon";

const GRID =
  "grid-cols-[minmax(200px,2.3fr)_132px_104px_116px_minmax(132px,1.5fr)_56px_88px]";
const HEAD_CELL = "text-[11px] font-semibold uppercase tracking-[0.05em] text-[#71717a]";

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 border-none bg-transparent p-0 text-left text-[11px] font-semibold uppercase tracking-[0.05em] text-[#a1a1aa]"
    >
      {label}
      <span className="text-[10px] text-[#f59e0b]">{active ? (dir === "asc" ? "↑" : "↓") : ""}</span>
    </button>
  );
}

// Memoized so moving the selection (or typing in search) only re-renders the
// rows whose props actually change — not the whole list (PERF C3). This relies
// on `d` being referentially stable (the portal memoizes decoration per
// dataset) and on the `onSelect`/`onOpen` callbacks being stable identities.
const Row = React.memo(function Row({
  d,
  selected,
  showRefs,
  dense,
  onSelect,
  onOpen,
  onIntent,
}: {
  d: DecoratedService;
  selected: boolean;
  showRefs: boolean;
  dense: boolean;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
  onIntent?: ((key: string) => void) | undefined;
}) {
  return (
    <button
      type="button"
      data-row
      data-entitykey={d.key}
      onMouseEnter={onIntent ? () => onIntent(d.key) : undefined}
      onFocus={onIntent ? () => onIntent(d.key) : undefined}
      onClick={() => onSelect(d.key)}
      onDoubleClick={() => onOpen(d.key)}
      className={`relative grid w-full ${GRID} items-center gap-2.5 border-none border-b border-b-[#141417] pl-3.5 pr-4 text-left transition-colors hover:bg-white/[0.022]`}
      style={{
        ...(selected ? { background: "rgba(245,158,11,.07)" } : {}),
        minHeight: dense ? "44px" : "56px",
        paddingTop: dense ? "6px" : "9px",
        paddingBottom: dense ? "6px" : "9px",
      }}
    >
      <span
        className="absolute bottom-2 left-0 top-2 w-0.5 rounded-[2px]"
        style={{ background: selected ? "#f59e0b" : "transparent" }}
      />
      {/* service */}
      <span className="flex min-w-0 items-center gap-[11px]">
        <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] border border-[#232327] bg-[#161619] text-[#a1a1aa]">
          <PathIcon d={d.iconD} size={17} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-[7px]">
            <span className="truncate text-[13.5px] font-medium text-[#fafafa]">{d.name}</span>
            <span className="shrink-0 rounded border border-[#26262b] px-[5px] text-[10px] text-[#71717a]">
              {d.kindLabel}
            </span>
          </span>
          {showRefs ? <span className="truncate font-mono text-[11px] text-[#52525b]">{d.ref}</span> : null}
        </span>
      </span>
      {/* owner */}
      <span className="flex min-w-0 items-center gap-[7px]">
        <span
          className="grid h-5 w-5 shrink-0 place-items-center rounded-[5px] text-[9px] font-semibold"
          style={{
            background: d.owned ? "#1f1f23" : "transparent",
            border: d.owned ? "1px solid #2a2a2e" : "1px dashed #3a3a40",
            color: d.owned ? "#d4d4d8" : "#52525b",
          }}
        >
          {d.ownerInitials}
        </span>
        <span className="truncate text-[12.5px]" style={{ color: d.owned ? "#d4d4d8" : "#71717a" }}>
          {d.ownerName}
        </span>
      </span>
      {/* lifecycle */}
      <span>
        {d.lifeShow ? (
          <span className="inline-flex h-[21px] items-center gap-1.5 rounded-md border border-[#26262b] px-2">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: d.lifeColor }} />
            <span className="text-[11.5px] capitalize" style={{ color: d.lifeText }}>
              {d.lifeLabel}
            </span>
          </span>
        ) : (
          <span className="text-[12px] text-[#3f3f46]">—</span>
        )}
      </span>
      {/* health */}
      <span className="flex items-center gap-[7px]">
        <span
          className="h-[7px] w-[7px] shrink-0 rounded-full"
          style={{ background: d.healthColor, boxShadow: d.healthKnown ? `0 0 0 3px ${d.healthColor}28` : "none" }}
        />
        <span className="text-[12.5px]" style={{ color: d.healthText }}>
          {d.healthLabel}
        </span>
      </span>
      {/* readiness */}
      <span>
        {d.hasScore ? (
          <span className="flex items-center gap-[9px]">
            <span
              className="inline-flex h-5 items-center gap-[5px] rounded-[5px] px-[7px]"
              style={{ background: d.tierBg, border: `1px solid ${d.tierBorder}` }}
            >
              <span className="text-[10.5px] font-semibold tracking-[0.02em]" style={{ color: d.tierColor }}>
                {d.tierLabel}
              </span>
            </span>
            <span className="h-1 min-w-[34px] flex-1 overflow-hidden rounded-[3px] bg-[#1c1c20]">
              <span
                className="block h-full rounded-[3px]"
                style={{ width: `${d.scorePct}%`, background: d.tierColor }}
              />
            </span>
            <span className="w-5 text-right font-mono text-[11px] text-[#71717a]">{d.scoreNum}</span>
          </span>
        ) : (
          <span className="text-[12px] text-[#3f3f46]">—</span>
        )}
      </span>
      {/* deps */}
      <span className="flex items-center gap-[5px] text-[#71717a]">
        <Workflow className="h-[13px] w-[13px]" />
        <span className="font-mono text-[12.5px]">{d.depsLabel}</span>
      </span>
      {/* updated */}
      <span className="text-[12px] text-[#71717a]">{d.deployLabel}</span>
    </button>
  );
});

// Mobile card — the table collapses to a stacked, thumb-friendly card on small
// screens (the 7-column grid is unreadable below ~900px and forced an awful
// horizontal scroll). A single tap selects the service and opens the detail
// sheet, mirroring the desktop single-click. Everything the row showed survives,
// re-flowed into a scannable header + meta strip.
const MobileCard = React.memo(function MobileCard({
  d,
  selected,
  onSelect,
  onIntent,
}: {
  d: DecoratedService;
  selected: boolean;
  onSelect: (key: string) => void;
  onIntent?: ((key: string) => void) | undefined;
}) {
  return (
    <button
      type="button"
      data-row
      data-entitykey={d.key}
      onPointerDown={onIntent ? () => onIntent(d.key) : undefined}
      onClick={() => onSelect(d.key)}
      className="relative flex w-full flex-col gap-2.5 border-b border-b-[#141417] px-4 py-3.5 text-left transition-colors active:bg-white/[0.03]"
      style={selected ? { background: "rgba(245,158,11,.07)" } : undefined}
    >
      <span
        className="absolute inset-y-2 left-0 w-0.5 rounded-[2px]"
        style={{ background: selected ? "#f59e0b" : "transparent" }}
      />
      {/* header: icon · name + kind · health */}
      <span className="flex min-w-0 items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-[#232327] bg-[#161619] text-[#a1a1aa]">
          <PathIcon d={d.iconD} size={18} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[15px] font-medium text-[#fafafa]">{d.name}</span>
            <span className="shrink-0 rounded border border-[#26262b] px-[5px] py-px text-[10px] text-[#71717a]">
              {d.kindLabel}
            </span>
          </span>
          <span className="truncate font-mono text-[11.5px] text-[#52525b]">{d.ref}</span>
        </span>
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: d.healthColor, boxShadow: d.healthKnown ? `0 0 0 3px ${d.healthColor}28` : "none" }}
        />
        <ChevronRight className="h-4 w-4 shrink-0 text-[#3f3f46]" />
      </span>
      {/* meta strip */}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-12 text-[11.5px]">
        <span className="flex items-center gap-1.5">
          <span
            className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] text-[8.5px] font-semibold"
            style={{
              background: d.owned ? "#1f1f23" : "transparent",
              border: d.owned ? "1px solid #2a2a2e" : "1px dashed #3a3a40",
              color: d.owned ? "#d4d4d8" : "#52525b",
            }}
          >
            {d.ownerInitials}
          </span>
          <span className="truncate" style={{ color: d.owned ? "#a1a1aa" : "#71717a", maxWidth: "9rem" }}>
            {d.ownerName}
          </span>
        </span>
        {d.lifeShow ? (
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: d.lifeColor }} />
            <span className="capitalize" style={{ color: d.lifeText }}>
              {d.lifeLabel}
            </span>
          </span>
        ) : null}
        {d.hasScore ? (
          <span
            className="inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-[10px] font-semibold"
            style={{ background: d.tierBg, border: `1px solid ${d.tierBorder}`, color: d.tierColor }}
          >
            {d.tierLabel} {d.scoreNum}
          </span>
        ) : null}
        <span className="flex items-center gap-1 text-[#71717a]">
          <Workflow className="h-3 w-3" />
          <span className="font-mono">{d.depsLabel}</span>
        </span>
        <span className="text-[#71717a]">{d.deployLabel}</span>
      </span>
    </button>
  );
});

export function TableView({
  groups,
  flat,
  decorate,
  sortKey,
  sortDir,
  onSort,
  selectedKey,
  onSelect,
  onOpen,
  onIntent,
  showRefs,
  dense,
  onClearFilters,
  isDesktop,
}: {
  groups: CatalogGroup[] | null;
  flat: CatalogService[];
  decorate: (s: CatalogService) => DecoratedService;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
  /** Warm the entity route's data on hover/focus (PERF G3) — optional. */
  onIntent?: (key: string) => void;
  showRefs: boolean;
  dense: boolean;
  onClearFilters: () => void;
  isDesktop: boolean;
}) {
  const isEmpty = (groups ? groups.length === 0 : flat.length === 0);

  const renderRows = (list: CatalogService[]) =>
    list.map((s) => {
      const d = decorate(s);
      return (
        <Row
          key={d.key}
          d={d}
          selected={selectedKey === d.key}
          showRefs={showRefs}
          dense={dense}
          onSelect={onSelect}
          onOpen={onOpen}
          onIntent={onIntent}
        />
      );
    });

  const renderCards = (list: CatalogService[]) =>
    list.map((s) => {
      const d = decorate(s);
      return (
        <MobileCard
          key={d.key}
          d={d}
          selected={selectedKey === d.key}
          onSelect={onSelect}
          onIntent={onIntent}
        />
      );
    });

  const empty = (
    <div className="flex flex-col items-center justify-center gap-2.5 px-5 py-[60px] text-center">
      <Search className="h-[34px] w-[34px] text-[#3f3f46]" strokeWidth={1.6} />
      <span className="text-[14px] font-medium text-[#d4d4d8]">No services match these filters</span>
      <button type="button" onClick={onClearFilters} className="border-none bg-transparent text-[13px] text-[#f59e0b]">
        Clear filters
      </button>
    </div>
  );

  // ── Mobile: stacked card list, naturally scrolling within the page ──────────
  if (!isDesktop) {
    return (
      <div className="overflow-hidden rounded-[13px] border border-[#1a1a1e] bg-[#0c0c0f]">
        {isEmpty ? (
          empty
        ) : groups ? (
          groups.map((g) => (
            <React.Fragment key={g.key}>
              <div className="flex items-center gap-2.5 border-b border-b-[#1a1a1e] bg-[#0a0a0d] px-4 py-2.5">
                <span className="text-[12px] font-semibold text-[#d4d4d8]">{g.label}</span>
                <span className="font-mono text-[11px] text-[#52525b]">{g.count}</span>
                <span className="ml-auto text-[11px] text-[#71717a]">{g.sub}</span>
              </div>
              {renderCards(g.services)}
            </React.Fragment>
          ))
        ) : (
          renderCards(flat)
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[13px] border border-[#1a1a1e] bg-[#0c0c0f]">
      <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
        <div className="flex min-h-0 min-w-[900px] flex-1 flex-col">
          {/* header */}
          <div className={`grid ${GRID} items-center gap-2.5 border-b border-b-[#1a1a1e] bg-[#0e0e12] px-4 py-2.5`}>
            <SortHeader label="Service" active={sortKey === "name"} dir={sortDir} onClick={() => onSort("name")} />
            <span className={HEAD_CELL}>Owner</span>
            <span className={HEAD_CELL}>Lifecycle</span>
            <SortHeader label="Health" active={sortKey === "health"} dir={sortDir} onClick={() => onSort("health")} />
            <SortHeader
              label="Readiness"
              active={sortKey === "readiness"}
              dir={sortDir}
              onClick={() => onSort("readiness")}
            />
            <span className={HEAD_CELL}>Deps</span>
            <SortHeader label="Updated" active={sortKey === "deploy"} dir={sortDir} onClick={() => onSort("deploy")} />
          </div>
          {/* rows */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isEmpty ? (
              empty
            ) : groups ? (
              groups.map((g) => (
                <React.Fragment key={g.key}>
                  <div className="sticky top-0 flex items-center gap-2.5 border-b border-b-[#1a1a1e] bg-[#0a0a0d] px-4 py-[9px]">
                    <span className="text-[12px] font-semibold text-[#d4d4d8]">{g.label}</span>
                    <span className="font-mono text-[11px] text-[#52525b]">{g.count}</span>
                    <span className="ml-auto text-[11px] text-[#71717a]">{g.sub}</span>
                  </div>
                  {renderRows(g.services)}
                </React.Fragment>
              ))
            ) : (
              renderRows(flat)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
