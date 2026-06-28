"use client";

// The catalog portal surface (saas-catalog-portal CP1+). The design-faithful
// internal-developer-portal catalog: header + metric tiles + toolbar + active
// filter chips + incident banner over a fixed-height frame whose body holds the
// Table / Board / Map view and (CP3) the entity detail drawer. Filtering,
// sorting and grouping run client-side over the loaded page via the pure
// view-model in `lib/catalog-portal/*`.

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { useApiQuery, qk } from "@/lib/query";
import { useDebounced } from "@/lib/use-debounced";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildContext,
  buildSelected,
  decorateService,
  rollup,
  toServices,
  type CatalogService,
  type DecoratedService,
} from "@/lib/catalog-portal/model";
import {
  EMPTY_FILTERS,
  activeChips,
  filterServices,
  groupServices,
  hasActiveFilters,
  sortServices,
  type CatalogFilters,
  type GroupKey,
  type SortDir,
  type SortKey,
} from "@/lib/catalog-portal/filter";
import { buildBoard, buildMap } from "@/lib/catalog-portal/layout";
import { CatalogHeader } from "./portal/header";
import { MetricTiles } from "./portal/metric-tiles";
import { CatalogToolbar, type PortalView } from "./portal/toolbar";
import { TableView } from "./portal/table-view";
import { BoardView } from "./portal/board-view";
import { MapView } from "./portal/map-view";
import { DetailDrawer } from "./portal/detail-drawer";

// Frame height = viewport minus the app shell chrome (topbar 3rem + main pad 3rem).
const FRAME = "h-[calc(100dvh-6rem)]";

export function CatalogPortal({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const catalogHref = `/orgs/${orgSlug}/catalog`;
  const selectedKey = searchParams?.get("entity") ?? null;

  // The portal filters/sorts/groups client-side, so it loads the full org graph
  // through the shared query cache (PERF C1): revisiting the catalog now paints
  // instantly from cache and revalidates in the background instead of re-walking
  // every page behind a skeleton on each mount. `collectOrgCatalog` pages the
  // keyset endpoint to completion (bounded for very large orgs).
  const {
    data: entities,
    loading,
    error,
  } = useApiQuery(qk.orgCatalog(orgId), () =>
    wrap(() => collectOrgCatalog((query) => client.state.listOrgCatalogEntities(orgId, query))),
  );

  const [filters, setFiltersState] = React.useState<CatalogFilters>(EMPTY_FILTERS);
  const [group, setGroup] = React.useState<GroupKey>("none");
  const [view, setView] = React.useState<PortalView>("list");
  const [sortKey, setSortKey] = React.useState<SortKey>("name");
  const [sortDir, setSortDir] = React.useState<SortDir>("asc");

  const setFilters = React.useCallback((patch: Partial<CatalogFilters>) => {
    setFiltersState((f) => ({ ...f, ...patch }));
  }, []);

  // Debounce the free-text query before it drives the (whole-catalog) filter →
  // sort → group → layout → decorate pipeline (PERF C4): the input stays
  // controlled at full speed via `filters.query`, but the heavy derived work
  // runs at most a few times per second instead of on every keystroke.
  const debouncedQuery = useDebounced(filters.query, 200);
  const effectiveFilters = React.useMemo(
    () => (filters.query === debouncedQuery ? filters : { ...filters, query: debouncedQuery }),
    [filters, debouncedQuery],
  );

  const services = React.useMemo(() => toServices(entities ?? []), [entities]);
  const ctx = React.useMemo(() => buildContext(services), [services]);
  const metrics = React.useMemo(() => rollup(services), [services]);

  const filtered = React.useMemo(
    () => sortServices(filterServices(services, effectiveFilters), sortKey, sortDir),
    [services, effectiveFilters, sortKey, sortDir],
  );
  const grouped = React.useMemo(() => groupServices(filtered, group), [filtered, group]);
  const board = React.useMemo(() => buildBoard(filtered), [filtered]);
  const map = React.useMemo(() => buildMap(filtered), [filtered]);
  const chips = React.useMemo(() => activeChips(filters), [filters]);

  // Decorate every service once per dataset into a key→row map (PERF C3). The
  // map is keyed by the stable service objects, so it survives filter / sort /
  // selection / typing re-renders; `decorate` becomes an O(1) lookup and the
  // 8-check scorecard is never recomputed per render. Memoized rows also let
  // the views' `React.memo` rows skip re-rendering when only the selection moves.
  const decoratedByKey = React.useMemo(() => {
    const m = new Map<string, DecoratedService>();
    for (const s of services) m.set(s.key, decorateService(s, ctx));
    return m;
  }, [services, ctx]);
  const decorate = React.useCallback(
    (s: CatalogService) => decoratedByKey.get(s.key) ?? decorateService(s, ctx),
    [decoratedByKey, ctx],
  );
  const selectedService = React.useMemo(
    () => (selectedKey ? (services.find((s) => s.key === selectedKey) ?? null) : null),
    [services, selectedKey],
  );
  const selected = React.useMemo(
    () => (selectedService ? buildSelected(selectedService, ctx) : null),
    [selectedService, ctx],
  );

  const setSelectedKey = React.useCallback(
    (key: string | null) => {
      const sp = new URLSearchParams(searchParams?.toString() ?? "");
      if (key) sp.set("entity", key);
      else sp.delete("entity");
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );
  const openFull = React.useCallback((key: string) => router.push(`${catalogHref}/${key}`), [router, catalogHref]);

  // Escape closes the drawer.
  React.useEffect(() => {
    if (!selectedKey) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setSelectedKey(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedKey, setSelectedKey]);

  const onSort = React.useCallback((k: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === k) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prevKey;
      }
      setSortDir("asc");
      return k;
    });
  }, []);

  const clearFilters = React.useCallback(() => setFiltersState(EMPTY_FILTERS), []);
  const removeChip = React.useCallback((field: keyof CatalogFilters) => {
    setFiltersState((f) => ({
      ...f,
      ...(field === "attention" ? { attention: false } : field === "query" ? { query: "" } : { [field]: "all" }),
    }));
  }, []);

  return (
    <div className={cn("flex flex-col gap-[18px] overflow-hidden", FRAME)}>
      {/* title + metrics */}
      <div className="flex shrink-0 flex-col gap-4">
        <CatalogHeader />
        <MetricTiles
          rollup={metrics}
          attention={filters.attention}
          onToggleAttention={() => setFilters({ attention: !filters.attention })}
        />
      </div>

      {/* toolbar */}
      <div className="shrink-0">
        <CatalogToolbar
          filters={filters}
          setFilters={setFilters}
          group={group}
          setGroup={setGroup}
          view={view}
          setView={setView}
        />
      </div>

      {/* active filter chips */}
      {chips.length > 0 ? (
        <div className="-mt-1.5 flex shrink-0 flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-[#71717a]">
            {filtered.length} of {metrics.total}
          </span>
          {chips.map((chip) => (
            <button
              key={`${chip.field}:${chip.label}`}
              type="button"
              onClick={() => removeChip(chip.field)}
              className="flex h-6 items-center gap-1.5 rounded-md border border-[#26262b] bg-[#121215] py-0 pl-[9px] pr-[7px] text-[11.5px] text-[#a1a1aa]"
            >
              {chip.kind ? <span className="text-[#52525b]">{chip.kind}</span> : null}
              {chip.label}
              <span className="text-[13px] leading-none text-[#52525b]">×</span>
            </button>
          ))}
          <button
            type="button"
            onClick={clearFilters}
            className="border-none bg-transparent text-[11.5px] text-[#71717a] underline underline-offset-2"
          >
            Clear all
          </button>
        </div>
      ) : null}

      {/* incident banner */}
      {metrics.incidents > 0 ? (
        <div className="-mt-1 flex shrink-0 items-center gap-2.5 rounded-[9px] border border-[rgba(248,113,113,.22)] bg-[rgba(248,113,113,.07)] px-3.5 py-[9px]">
          <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#f87171] shadow-[0_0_0_3px_rgba(248,113,113,.18)]" />
          <span className="text-[12.5px] text-[#fca5a5]">
            {metrics.incidents} open incident{metrics.incidents === 1 ? "" : "s"} — affecting{" "}
            {metrics.incidentRefs.join(", ")}
          </span>
          <span className="ml-auto font-mono text-[11.5px] text-[#71717a]">live</span>
        </div>
      ) : null}

      {/* body */}
      <div className="relative flex min-h-0 flex-1 pb-[22px]">
        <div className="flex min-w-0 flex-1 flex-col">
          {loading ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden rounded-[13px] border border-[#1a1a1e] bg-[#0c0c0f] p-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg bg-[#161619]" />
              ))}
            </div>
          ) : error ? (
            <div className="rounded-[13px] border border-[#1a1a1e] bg-[#0c0c0f] p-8 text-center">
              <div className="text-[14px] font-medium text-[#f87171]">{error.code}</div>
              <div className="mt-1 text-[12.5px] text-[#71717a]">{error.message}</div>
            </div>
          ) : view === "list" ? (
            <TableView
              groups={grouped}
              flat={filtered}
              decorate={decorate}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              onOpen={openFull}
              showRefs
              dense={false}
              onClearFilters={clearFilters}
            />
          ) : view === "board" ? (
            <BoardView
              columns={board}
              decorate={decorate}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              onOpen={openFull}
            />
          ) : (
            <MapView model={map} selectedKey={selectedKey} onSelect={setSelectedKey} onOpen={openFull} />
          )}
        </div>

        {/* entity detail drawer */}
        {selected ? (
          <DetailDrawer
            sel={selected}
            onClose={() => setSelectedKey(null)}
            onSelectRef={setSelectedKey}
            onViewMap={() => setView("graph")}
          />
        ) : null}
      </div>

      {/* filters-active hint for empty assistive state (a11y) */}
      <span className="sr-only">{hasActiveFilters(filters) ? "Filters active" : "No filters"}</span>
    </div>
  );
}
