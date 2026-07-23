/**
 * Catalog portal Table view (saas-catalog-portal CP1), Northwind design.
 * A white card with CSS-grid rows: Entity · Owner · Lifecycle · Health ·
 * SLO 30d · Maturity · chevron. Needs-attention rows carry a warn wash.
 */

import * as React from "react";
import Link from "next/link";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Search, ChevronRight } from "lucide-react";
import type { CatalogService } from "@/lib/catalog-portal/model";
import type { DecoratedService } from "@/lib/catalog-portal/model";
import { needsAttention } from "@/lib/catalog-portal/model";
import type { CatalogGroup, SortDir, SortKey } from "@/lib/catalog-portal/filter";
import { OwnerAvatar, RowChevron } from "@/components/ui/northwind";

/** Above this row count the desktop table windows its rows (IC8). Small
 *  catalogs keep the plain DOM — zero behavior change where it isn't needed. */
export const VIRTUALIZE_THRESHOLD = 100;
/** Estimated desktop row height (measured: 55px incl the border). */
const ROW_ESTIMATE_PX = 55;
const GROUP_HEADER_ESTIMATE_PX = 38;

// Mock grid: Entity / Owner / Lifecycle / Health / SLO 30d / Maturity / chevron.
const GRID =
  "grid-cols-[minmax(220px,1.6fr)_minmax(110px,1fr)_110px_110px_80px_90px_34px]";
const HEAD_CELL = "text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/70";

// Maturity tier → literal ink from the mock (no theme token for these metals).
const TIER_INK: Record<string, string> = {
  Gold: "#9A7B2D",
  Silver: "#737373",
  Bronze: "#A6906B",
};

/** The lifecycle cell ink: experimental/beta reads mauve, others muted ink. */
function lifecycleInk(d: DecoratedService): string {
  return d.lifeKey === "experimental" ? "#7A648F" : "hsl(var(--secondary-foreground))";
}

/** The SLO % from the service's runtime signal, or an em-dash when absent. */
function sloLabel(s: CatalogService): string {
  return s.slo != null ? `${s.slo}%` : "—";
}

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
      className={`flex items-center gap-1.5 border-none bg-transparent p-0 text-left ${HEAD_CELL}`}
    >
      {label}
      <span className="text-[10px] text-foreground/50">{active ? (dir === "asc" ? "↑" : "↓") : ""}</span>
    </button>
  );
}

// Memoized so moving the selection (or typing in search) only re-renders the
// rows whose props actually change — not the whole list (PERF C3).
const Row = React.memo(function Row({
  d,
  href,
  selected,
  onQuickView,
  onIntent,
}: {
  d: DecoratedService;
  /** IC8: the row IS a link — cmd/middle-click, copy-link, and a11y come
   *  free. `prefetch={false}` so a thousand rows don't fire a thousand
   *  auto-prefetches; hover intent warms route+data, deduped, instead. */
  href: string;
  selected: boolean;
  onQuickView?: ((key: string) => void) | undefined;
  onIntent?: ((key: string) => void) | undefined;
}) {
  const attention = needsAttention(d.svc);
  const tierInk = d.tier ? TIER_INK[d.tier] : undefined;
  return (
    <div className="group relative">
      <Link
        href={href}
        prefetch={false}
        data-row
        data-entitykey={d.key}
        {...(onIntent ? { onMouseEnter: () => onIntent(d.key), onFocus: () => onIntent(d.key) } : {})}
        {...(onQuickView ? { onDoubleClick: () => onQuickView(d.key) } : {})}
        className={`relative grid w-full ${GRID} items-center gap-3 border-b border-b-border/60 px-[22px] py-[13px] text-left transition-colors ${
          attention ? "bg-warning-wash hover:bg-warning-wash/70" : "hover:bg-foreground/[0.022]"
        }`}
        {...(selected ? { style: { boxShadow: "inset 2px 0 0 hsl(var(--primary))" } } : {})}
      >
        {/* entity — name + mono ref subline */}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] font-medium text-foreground">{d.name}</span>
          <span className="mt-px truncate font-mono text-[11px] text-muted-foreground/70">{d.ref}</span>
        </span>
        {/* owner */}
        <span className="flex min-w-0 items-center gap-[7px]">
          {d.owned ? (
            <OwnerAvatar name={d.ownerName} size={18} />
          ) : (
            <OwnerAvatar name={d.ownerName} size={18} unowned />
          )}
          <span
            className="truncate text-[12.5px]"
            style={{ color: d.owned ? "hsl(var(--secondary-foreground))" : "hsl(var(--warning))" }}
          >
            {d.ownerName}
          </span>
        </span>
        {/* lifecycle */}
        <span>
          {d.lifeShow ? (
            <span className="text-[12px] capitalize" style={{ color: lifecycleInk(d) }}>
              {d.lifeLabel}
            </span>
          ) : (
            <span className="text-[12px] text-muted-foreground/45">—</span>
          )}
        </span>
        {/* health */}
        <span className="flex items-center gap-1.5">
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ background: d.healthColor }}
          />
          <span className="text-[12px]" style={{ color: d.healthText }}>
            {d.healthLabel}
          </span>
        </span>
        {/* SLO 30d */}
        <span className="text-[12.5px] tabular-nums" style={{ color: d.svc.slo != null ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground) / 0.6)" }}>
          {sloLabel(d.svc)}
        </span>
        {/* maturity */}
        <span>
          {tierInk ? (
            <span className="text-[12px] font-medium" style={{ color: tierInk }}>
              {d.tierLabel}
            </span>
          ) : (
            <span className="text-[12px] text-muted-foreground/45">—</span>
          )}
        </span>
        {/* chevron — revealed on row hover, the Northwind idiom */}
        <RowChevron className="ml-0" />
      </Link>
    </div>
  );
});

// Mobile card — the table collapses to a stacked, thumb-friendly card on small
// screens. A single tap opens the full service page.
const MobileCard = React.memo(function MobileCard({
  d,
  href,
  selected,
  onIntent,
}: {
  d: DecoratedService;
  href: string;
  selected: boolean;
  onIntent?: ((key: string) => void) | undefined;
}) {
  const attention = needsAttention(d.svc);
  const tierInk = d.tier ? TIER_INK[d.tier] : undefined;
  return (
    <Link
      href={href}
      prefetch={false}
      data-row
      data-entitykey={d.key}
      {...(onIntent ? { onPointerDown: () => onIntent(d.key) } : {})}
      className={`relative flex w-full flex-col gap-2.5 border-b border-b-border/60 px-4 py-3.5 text-left transition-colors ${
        attention ? "bg-warning-wash active:bg-warning-wash/70" : "active:bg-foreground/[0.03]"
      }`}
      {...(selected ? { style: { boxShadow: "inset 2px 0 0 hsl(var(--primary))" } } : {})}
    >
      {/* header: name + ref · health · chevron */}
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] font-medium text-foreground">{d.name}</span>
          <span className="truncate font-mono text-[11.5px] text-muted-foreground/60">{d.ref}</span>
        </span>
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.healthColor }} />
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/45" />
      </span>
      {/* meta strip */}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px]">
        <span className="flex items-center gap-1.5">
          <OwnerAvatar name={d.ownerName} size={18} unowned={!d.owned} />
          <span
            className="truncate"
            style={{ color: d.owned ? "hsl(var(--muted-foreground))" : "hsl(var(--warning))", maxWidth: "9rem" }}
          >
            {d.ownerName}
          </span>
        </span>
        {d.lifeShow ? (
          <span className="capitalize" style={{ color: lifecycleInk(d) }}>
            {d.lifeLabel}
          </span>
        ) : null}
        <span style={{ color: d.healthText }}>{d.healthLabel}</span>
        {d.svc.slo != null ? <span className="tabular-nums text-muted-foreground">{sloLabel(d.svc)}</span> : null}
        {tierInk ? (
          <span className="font-medium" style={{ color: tierInk }}>
            {d.tierLabel}
          </span>
        ) : null}
      </span>
    </Link>
  );
});

/** Flattened render stream for the virtualizer: group headers interleaved
 *  with rows, one entry per DOM block. */
type VirtualItem =
  | { type: "header"; key: string; label: string; count: number; sub: string }
  | { type: "row"; key: string; svc: CatalogService };

function flattenItems(groups: CatalogGroup[] | null, flat: CatalogService[], keyOf: (s: CatalogService) => string): VirtualItem[] {
  if (!groups) return flat.map((s) => ({ type: "row", key: keyOf(s), svc: s }));
  const out: VirtualItem[] = [];
  for (const g of groups) {
    out.push({ type: "header", key: `hdr:${g.key}`, label: g.label, count: g.count, sub: g.sub });
    for (const s of g.services) out.push({ type: "row", key: keyOf(s), svc: s });
  }
  return out;
}

/** Windowed desktop rows (IC8): only the visible slice renders, scrolling
 *  with the page (window virtualizer, so the layout is unchanged). */
function VirtualRows({
  items,
  decorate,
  selectedKey,
  hrefOf,
  onQuickView,
  onIntent,
}: {
  items: VirtualItem[];
  decorate: (s: CatalogService) => DecoratedService;
  selectedKey: string | null;
  hrefOf: (key: string) => string;
  onQuickView?: ((key: string) => void) | undefined;
  onIntent?: ((key: string) => void) | undefined;
}) {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = React.useState(0);
  React.useLayoutEffect(() => {
    setScrollMargin(listRef.current?.getBoundingClientRect().top ?? 0);
  }, []);
  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: (i) => (items[i]!.type === "header" ? GROUP_HEADER_ESTIMATE_PX : ROW_ESTIMATE_PX),
    overscan: 12,
    scrollMargin,
    getItemKey: (i) => items[i]!.key,
  });
  return (
    <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const item = items[vi.index]!;
        return (
          <div
            key={vi.key}
            ref={virtualizer.measureElement}
            data-index={vi.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${vi.start - scrollMargin}px)`,
            }}
          >
            {item.type === "header" ? (
              <div className="flex items-center gap-2.5 border-b border-b-border bg-background px-[22px] py-[9px]">
                <span className="text-[12px] font-semibold text-foreground/90">{item.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground/60">{item.count}</span>
                <span className="ml-auto text-[11px] text-muted-foreground/80">{item.sub}</span>
              </div>
            ) : (
              (() => {
                const d = decorate(item.svc);
                return (
                  <Row
                    d={d}
                    href={hrefOf(d.key)}
                    selected={selectedKey === d.key}
                    onQuickView={onQuickView}
                    onIntent={onIntent}
                  />
                );
              })()
            )}
          </div>
        );
      })}
    </div>
  );
}

export function TableView({
  groups,
  flat,
  decorate,
  sortKey,
  sortDir,
  onSort,
  selectedKey,
  hrefOf,
  onQuickView,
  onIntent,
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
  /** IC8: the row href — rows are real links (cmd/middle-click works). */
  hrefOf: (key: string) => string;
  /** Open the quick-view drawer (desktop only) — omitted hides the peek. */
  onQuickView?: ((key: string) => void) | undefined;
  /** Warm the entity route's data on hover/focus (PERF G3) — optional. */
  onIntent?: (key: string) => void;
  /** Kept for compatibility with the portal's call site (unused here). */
  dense?: boolean;
  onClearFilters: () => void;
  isDesktop: boolean;
}) {
  const isEmpty = groups ? groups.length === 0 : flat.length === 0;
  const keyOf = React.useCallback((s: CatalogService) => decorate(s).key, [decorate]);
  const totalRows = groups ? groups.reduce((n, g) => n + g.services.length, 0) : flat.length;
  const virtualize = isDesktop && totalRows > VIRTUALIZE_THRESHOLD;
  const items = React.useMemo(
    () => (virtualize ? flattenItems(groups, flat, keyOf) : []),
    [virtualize, groups, flat, keyOf],
  );

  const renderRows = (list: CatalogService[]) =>
    list.map((s) => {
      const d = decorate(s);
      return (
        <Row
          key={d.key}
          d={d}
          href={hrefOf(d.key)}
          selected={selectedKey === d.key}
          onQuickView={onQuickView}
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
          href={hrefOf(d.key)}
          selected={selectedKey === d.key}
          onIntent={onIntent}
        />
      );
    });

  const empty = (
    <div className="flex flex-col items-center justify-center gap-2.5 px-5 py-[60px] text-center">
      <Search className="h-[34px] w-[34px] text-muted-foreground/45" strokeWidth={1.6} />
      <span className="text-[14px] font-medium text-foreground/90">No services match these filters</span>
      <button type="button" onClick={onClearFilters} className="border-none bg-transparent text-[13px] text-primary">
        Clear filters
      </button>
    </div>
  );

  // ── Mobile: stacked card list, naturally scrolling within the page ──────────
  if (!isDesktop) {
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {isEmpty ? (
          empty
        ) : groups ? (
          groups.map((g) => (
            <React.Fragment key={g.key}>
              <div className="flex items-center gap-2.5 border-b border-b-border bg-background px-4 py-2.5">
                <span className="text-[12px] font-semibold text-foreground/90">{g.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground/60">{g.count}</span>
                <span className="ml-auto text-[11px] text-muted-foreground/80">{g.sub}</span>
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
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="overflow-x-auto">
        <div className="min-w-[820px]">
          {/* header */}
          <div className={`grid ${GRID} items-center gap-3 border-b border-b-border px-[22px] py-2.5`}>
            <SortHeader label="Entity" active={sortKey === "name"} dir={sortDir} onClick={() => onSort("name")} />
            <span className={HEAD_CELL}>Owner</span>
            <span className={HEAD_CELL}>Lifecycle</span>
            <SortHeader label="Health" active={sortKey === "health"} dir={sortDir} onClick={() => onSort("health")} />
            <span className={HEAD_CELL}>SLO 30d</span>
            <SortHeader label="Maturity" active={sortKey === "readiness"} dir={sortDir} onClick={() => onSort("readiness")} />
            <span aria-hidden />
          </div>
          {/* rows — windowed above VIRTUALIZE_THRESHOLD (IC8) */}
          {isEmpty ? (
            empty
          ) : virtualize ? (
            <VirtualRows
              items={items}
              decorate={decorate}
              selectedKey={selectedKey}
              hrefOf={hrefOf}
              onQuickView={onQuickView}
              onIntent={onIntent}
            />
          ) : groups ? (
            groups.map((g) => (
              <React.Fragment key={g.key}>
                <div className="flex items-center gap-2.5 border-b border-b-border bg-background px-[22px] py-[9px]">
                  <span className="text-[12px] font-semibold text-foreground/90">{g.label}</span>
                  <span className="font-mono text-[11px] text-muted-foreground/60">{g.count}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground/80">{g.sub}</span>
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
  );
}
