"use client";

// The catalog workbench (saas-service-catalog index redesign). One 3-panel
// master-detail surface — global nav · list · detail — shared by BOTH the index
// (`/catalog`) and the entity page (`/catalog/[entityKey]`), so drilling into a
// component keeps the layout instead of collapsing to a single column.
//
// Selection model:
//   • index mode  — selection lives in `?entity=` (a fast, shareable peek).
//   • entity mode — selection is the path key; the list stays, the picked row is
//                   highlighted, and choosing another row navigates to its page.
// Single click selects (peek); double click (or ↵) drills into the full page.
// On wide screens the detail is a pinned third panel; below `xl` it is the
// existing peek drawer.

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Boxes } from "lucide-react";
import type { OrgCatalogEntity, StateCursor } from "@saas/contracts/state";
import { EntityListItem } from "@/components/catalog/entity-list-item";
import { EntityDetailPanel, EntityDetailEmpty } from "@/components/catalog/entity-detail-panel";
import { DependencyGraph } from "@/components/catalog/dependency-graph";
import { InsightsBar } from "@/components/catalog/insights-bar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { decodeEntityKey, encodeEntityKey, parseEntityRef, type EntityIdentity } from "@/lib/catalog-entity-key";
import { buildOrgGraph } from "@/lib/catalog-graph";
import { computeInsights, filterByInsight, INSIGHT_LABEL, type InsightId } from "@/lib/catalog-insights";

// The kinds the org-service-catalog projects (data-model.md §2/§4).
const KIND_OPTIONS = ["Component", "API", "Resource", "System", "Domain", "Group"];

/** Debounce a fast-changing text value before it drives refetches. */
function useDebounced<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** Track a media query (client-only); drives the 3-panel ⇄ drawer switch. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);
  React.useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Stable list/dedup key: the (project, environment, ref) scope is unique. */
function entityKeyOf(e: OrgCatalogEntity): string {
  return `${e.sourceProjectId}:${e.sourceEnvironment ?? ""}:${e.entityRef}`;
}

/** The opaque, URL-safe key for an entity's detail route + `?entity=` param. */
function urlKey(e: OrgCatalogEntity): string {
  return encodeEntityKey({
    sourceProjectId: e.sourceProjectId,
    sourceEnvironment: e.sourceEnvironment,
    entityRef: e.entityRef,
  });
}

function sameEntity(e: OrgCatalogEntity, id: EntityIdentity): boolean {
  return (
    e.entityRef === id.entityRef &&
    e.sourceProjectId === id.sourceProjectId &&
    (e.sourceEnvironment ?? null) === id.sourceEnvironment
  );
}

export function CatalogWorkbench({
  orgId,
  orgSlug,
  mode,
  entityKey,
}: {
  orgId: string;
  orgSlug: string;
  mode: "index" | "entity";
  /** The path key, in entity mode. */
  entityKey?: string;
}) {
  const { client } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isWide = useMediaQuery("(min-width: 1280px)");
  const catalogHref = `/orgs/${orgSlug}/catalog`;

  // The identity the page is focused on (entity mode); null/malformed → handled.
  const pathId = React.useMemo(
    () => (mode === "entity" && entityKey ? decodeEntityKey(entityKey) : null),
    [mode, entityKey],
  );
  const selectedKey = mode === "entity" ? (pathId ? (entityKey ?? null) : null) : (searchParams?.get("entity") ?? null);

  // Projects power the provenance filter + map a source project id to a label.
  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const projectLabel = React.useCallback(
    (id: string) => {
      const p = projects.data?.find((x) => x.id === id);
      return p?.name ?? p?.slug ?? id;
    },
    [projects.data],
  );

  const [project, setProject] = React.useState("all");
  const [kind, setKind] = React.useState("all");
  const [ownerInput, setOwnerInput] = React.useState("");
  const [envInput, setEnvInput] = React.useState("");
  const [qInput, setQInput] = React.useState("");
  const owner = useDebounced(ownerInput);
  const environment = useDebounced(envInput);
  const q = useDebounced(qInput);

  // Build the query omitting absent filters (exactOptionalPropertyTypes: never
  // pass an explicit undefined — the field is simply absent).
  const applied = React.useMemo(() => {
    const a: { project?: string; kind?: string; owner?: string; environment?: string; q?: string } = {};
    if (project !== "all") a.project = project;
    if (kind !== "all") a.kind = kind;
    if (owner.trim()) a.owner = owner.trim();
    if (environment.trim()) a.environment = environment.trim();
    if (q.trim()) a.q = q.trim();
    return a;
  }, [project, kind, owner, environment, q]);
  const appliedKey = JSON.stringify(applied);

  const [entities, setEntities] = React.useState<OrgCatalogEntity[]>([]);
  const [cursor, setCursor] = React.useState<StateCursor | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);
  const [view, setView] = React.useState<"list" | "graph">("list");
  const [insight, setInsight] = React.useState<InsightId | null>(null);

  // In entity mode, the focused entity may live beyond the first page (deep
  // link). Resolve it independently over the narrowed list endpoint so the
  // detail paints even when the row isn't in the loaded list.
  const focused = useApiQuery(
    qk.catalogEntity(orgId, entityKey ?? ""),
    () =>
      wrap(() =>
        client.state.listOrgCatalogEntities(orgId, {
          project: pathId!.sourceProjectId,
          q: parseEntityRef(pathId!.entityRef).name || pathId!.entityRef,
        }),
      ),
    { enabled: mode === "entity" && pathId !== null },
  );

  /** index mode: set/clear `?entity=`. entity mode: navigate to the key's page. */
  const setSelectedKey = React.useCallback(
    (key: string | null) => {
      if (mode === "entity") {
        router.push(key ? `${catalogHref}/${key}` : catalogHref);
        return;
      }
      const sp = new URLSearchParams(searchParams?.toString() ?? "");
      if (key) sp.set("entity", key);
      else sp.delete("entity");
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [mode, router, pathname, searchParams, catalogHref],
  );

  /** Drill into the full page (double click / ↵), from either mode. */
  const openFull = React.useCallback(
    (key: string) => router.push(`${catalogHref}/${key}`),
    [router, catalogHref],
  );

  const loadFirstPage = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await wrap(() => client.state.listOrgCatalogEntities(orgId, applied));
    if (res.ok) {
      setEntities(res.data.entities);
      setCursor(res.data.nextCursor);
    } else {
      setError({ code: res.error.code, message: res.error.message });
      setEntities([]);
      setCursor(null);
    }
    setLoading(false);
    // appliedKey (not `applied`) is the dep: the derived object is recreated each
    // render but its serialization only changes when a filter changes.
  }, [client, orgId, appliedKey]);

  React.useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = React.useCallback(async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    const res = await wrap(() =>
      client.state.listOrgCatalogEntities(orgId, { ...applied, cursor: `${cursor.createdAt}|${cursor.id}` }),
    );
    if (res.ok) {
      setEntities((prev) => [...prev, ...res.data.entities]);
      setCursor(res.data.nextCursor);
    } else {
      setError({ code: res.error.code, message: res.error.message });
    }
    setLoadingMore(false);
  }, [client, orgId, appliedKey, cursor, loadingMore]);

  const filtersActive =
    applied.project !== undefined ||
    applied.kind !== undefined ||
    applied.owner !== undefined ||
    applied.environment !== undefined ||
    applied.q !== undefined;
  const clearAll = () => {
    setProject("all");
    setKind("all");
    setOwnerInput("");
    setEnvInput("");
    setQInput("");
  };

  // The selected entity object: prefer the loaded list, fall back to the
  // entity-mode focused fetch (deep links to rows beyond the first page).
  const selected = React.useMemo(() => {
    if (!selectedKey) return null;
    const inList = entities.find((e) => urlKey(e) === selectedKey);
    if (inList) return inList;
    if (mode === "entity" && pathId) return focused.data?.entities.find((e) => sameEntity(e, pathId)) ?? null;
    return null;
  }, [entities, selectedKey, mode, pathId, focused.data]);

  // SC4 data-quality insights drive a click-to-filter narrowing (`shown`).
  const insights = React.useMemo(() => computeInsights(entities), [entities]);
  const shown = React.useMemo(
    () => (insight ? filterByInsight(entities, insight) : entities),
    [entities, insight],
  );
  const danglingKeys = React.useMemo(
    () => new Set(filterByInsight(entities, "dangling-deps").map(urlKey)),
    [entities],
  );
  const orgGraph = React.useMemo(() => buildOrgGraph(shown, orgSlug), [shown, orgSlug]);
  const isSelected = (e: OrgCatalogEntity) => selectedKey !== null && urlKey(e) === selectedKey;

  // Keyboard triage (wide list view, index mode): ↑/↓ or j/k move the selection
  // through the pinned panel, ↵ opens the full page, Esc deselects. Disabled in
  // entity mode (each move would be a navigation) and while a field is focused.
  const listRef = React.useRef<HTMLDivElement>(null);
  const scrollRowIntoView = React.useCallback((key: string) => {
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-entitykey="${CSS.escape(key)}"]`)?.scrollIntoView({
        block: "nearest",
      });
    });
  }, []);
  React.useEffect(() => {
    if (mode !== "index" || !isWide || view !== "list" || shown.length === 0) return;
    const move = (delta: number) => {
      const idx = selectedKey ? shown.findIndex((e) => urlKey(e) === selectedKey) : -1;
      const next = shown[Math.max(0, Math.min(idx + delta, shown.length - 1))] ?? shown[0];
      if (!next) return;
      const k = urlKey(next);
      setSelectedKey(k);
      scrollRowIntoView(k);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if (ev.key === "ArrowDown" || ev.key === "j") {
        ev.preventDefault();
        move(1);
      } else if (ev.key === "ArrowUp" || ev.key === "k") {
        ev.preventDefault();
        move(-1);
      } else if (ev.key === "Enter" && selectedKey) {
        ev.preventDefault();
        openFull(selectedKey);
      } else if (ev.key === "Escape" && selectedKey) {
        setSelectedKey(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, isWide, view, shown, selectedKey, setSelectedKey, openFull, scrollRowIntoView]);

  // Malformed entity key → a clean not-found rather than an empty panel.
  if (mode === "entity" && pathId === null) {
    return (
      <div className="space-y-5">
        <Header mode={mode} catalogHref={catalogHref} />
        <EmptyState
          icon={Boxes}
          title="Entity not found"
          description="This catalog link is malformed or out of date."
          primaryAction={{ label: "Back to catalog", href: catalogHref }}
        />
      </div>
    );
  }

  const detailBody = selected ? (
    <EntityDetailPanel
      entity={selected}
      projectLabel={projectLabel}
      orgSlug={orgSlug}
      onClose={() => setSelectedKey(null)}
      showOpenLink={mode !== "entity"}
    />
  ) : mode === "entity" && selectedKey && focused.loading ? (
    <DetailSkeleton />
  ) : mode === "entity" && selectedKey ? (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Boxes className="h-8 w-8 text-muted-foreground/30" aria-hidden />
      <p className="text-sm font-medium">Component not found</p>
      <p className="max-w-[16rem] text-xs text-muted-foreground">
        It may have been removed from its source project, or its snapshot has moved on.
      </p>
    </div>
  ) : (
    <EntityDetailEmpty />
  );

  return (
    <div className="space-y-5">
      <Header mode={mode} catalogHref={catalogHref} />

      {/* Filter toolbar — selects apply instantly; text inputs debounce. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Project">
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {(projects.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name ?? p.slug}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Kind">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            {KIND_OPTIONS.map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={ownerInput}
          onChange={(e) => setOwnerInput(e.target.value)}
          placeholder="Owner"
          aria-label="Owner"
          className="h-8 w-[150px] text-xs"
        />
        <Input
          value={envInput}
          onChange={(e) => setEnvInput(e.target.value)}
          placeholder="Environment"
          aria-label="Environment"
          className="h-8 w-[150px] text-xs"
        />
        <Input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search name or ref"
          aria-label="Search"
          className="h-8 w-[220px] text-xs"
        />
        <div className="ml-auto inline-flex rounded-md border p-0.5" role="group" aria-label="View">
          {(["list", "graph"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cn(
                "rounded px-2.5 py-1 text-xs capitalize transition-colors",
                view === v ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {!loading && !error && entities.length > 0 ? (
        <InsightsBar insights={insights} active={insight} onToggle={setInsight} />
      ) : null}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[72px] w-full rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{error.code}</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : entities.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={filtersActive ? "No matching components" : "No components yet"}
          description={
            filtersActive
              ? "No components match the current filters. Clear a filter to widen the view."
              : "Resolve and push a catalog from the CLI: `orun catalog refresh && orun catalog push`."
          }
          {...(filtersActive ? { primaryAction: { label: "Clear filters", onClick: clearAll } } : {})}
        />
      ) : (
        <>
          {shown.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No components in this view match “{insight ? INSIGHT_LABEL[insight] : ""}”.{" "}
                <button
                  type="button"
                  onClick={() => setInsight(null)}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Clear filter
                </button>
              </CardContent>
            </Card>
          ) : view === "graph" ? (
            <Card>
              <CardContent className="pt-6">
                <DependencyGraph graph={orgGraph} height={520} />
              </CardContent>
            </Card>
          ) : (
            // Master-detail: the list, plus the pinned detail as the third panel
            // on wide screens (drawer below xl, rendered later).
            <div className={cn("grid items-start gap-5", isWide && "grid-cols-[minmax(0,1fr)_360px]")}>
              <div ref={listRef} className="space-y-2">
                {shown.map((e) => (
                  <EntityListItem
                    key={entityKeyOf(e)}
                    entity={e}
                    projectLabel={projectLabel}
                    selected={isSelected(e)}
                    dangling={danglingKeys.has(urlKey(e))}
                    urlKey={urlKey(e)}
                    onSelect={() => setSelectedKey(urlKey(e))}
                    onOpen={() => openFull(urlKey(e))}
                  />
                ))}
              </div>

              {isWide ? (
                <aside aria-label="Component detail">
                  <div className="sticky top-6">
                    <div className="relative flex min-h-[460px] max-h-[calc(100dvh-5.5rem)] flex-col overflow-hidden rounded-xl border bg-card p-4 shadow-sm">
                      {detailBody}
                    </div>
                  </div>
                </aside>
              ) : null}
            </div>
          )}

          {cursor !== null ? (
            <div className="flex justify-center pt-1">
              <Button type="button" variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                Load more
              </Button>
            </div>
          ) : (
            <p className="pt-1 text-center text-[11px] text-muted-foreground">
              {entities.length} component{entities.length === 1 ? "" : "s"} · end of the catalog for these filters.
            </p>
          )}
        </>
      )}

      {/* Peek drawer — only below xl, where the panel isn't pinned. */}
      {!isWide ? (
        <Sheet open={selectedKey !== null} onOpenChange={(open) => (open ? undefined : setSelectedKey(null))}>
          <SheetContent side="right" className="w-[400px] max-w-[92vw] overflow-y-auto">
            {selected ? (
              <>
                <SheetTitle className="sr-only">{selected.name}</SheetTitle>
                <SheetDescription className="sr-only">{selected.entityRef}</SheetDescription>
                <EntityDetailPanel
                  entity={selected}
                  projectLabel={projectLabel}
                  orgSlug={orgSlug}
                  showOpenLink={mode !== "entity"}
                />
              </>
            ) : (
              <>
                <SheetTitle className="sr-only">Component</SheetTitle>
                <DetailSkeleton />
              </>
            )}
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

function Header({ mode, catalogHref }: { mode: "index" | "entity"; catalogHref: string }) {
  return (
    <header>
      <h1 className="text-xl font-semibold tracking-tight">
        {mode === "entity" ? (
          <a href={catalogHref} className="text-muted-foreground transition-colors hover:text-foreground">
            Catalog
          </a>
        ) : (
          "Catalog"
        )}
      </h1>
      <p className="text-sm text-muted-foreground">
        The org-wide component graph, merged across every project. Push from the CLI with{" "}
        <code className="font-mono text-xs">orun catalog push</code>.
      </p>
    </header>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}
