"use client";

// The catalog workbench (saas-service-catalog index redesign). A 3-panel app
// surface — global nav · center · fixed info panel — shared in spirit by both
// routes. On wide screens it is a fixed frame the height of the viewport: only
// the CENTER scrolls (the list, or the drilled-in component page), while the
// top chrome and the right info panel stay put.
//
//   • index mode  (`/catalog`)        — center = the component list (scrolls);
//                                        right  = the selected component's info
//                                        panel (peek, fixed). `?entity=` selects;
//                                        double-click (or ↵) drills in.
//   • entity mode (`/catalog/[key]`)   — center = the full component page
//                                        (scrolls); right = an "Additional
//                                        details" panel (blank seam for now).
//
// Below `xl` both collapse to normal page flow (the index keeps its peek drawer).

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Boxes, ChevronLeft } from "lucide-react";
import type { OrgCatalogEntity, StateCursor } from "@saas/contracts/state";
import { EntityListItem } from "@/components/catalog/entity-list-item";
import { EntityDetailPanel, EntityDetailEmpty } from "@/components/catalog/entity-detail-panel";
import { EntityPage, EntityInfoPanel } from "@/components/catalog/entity-page";
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

// Frame height = viewport minus the app shell's chrome (topbar h-12 = 3rem,
// main pt-6 + pb-6 = 3rem). Only applied ≥ xl, where the 3-panel frame is fixed.
const FRAME = "h-[calc(100dvh-6rem)] overflow-hidden";

/** Debounce a fast-changing text value before it drives refetches. */
function useDebounced<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** Track a media query (client-only); drives the fixed-frame ⇄ flow switch. */
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

/** Dispatcher (no hooks of its own) so each mode owns its data hooks cleanly. */
export function CatalogWorkbench({
  orgId,
  orgSlug,
  mode,
  entityKey,
}: {
  orgId: string;
  orgSlug: string;
  mode: "index" | "entity";
  entityKey?: string;
}) {
  if (mode === "entity") {
    return <EntityWorkbench orgId={orgId} orgSlug={orgSlug} entityKey={entityKey ?? ""} />;
  }
  return <CatalogIndex orgId={orgId} orgSlug={orgSlug} />;
}

// ── Index (list browse) ─────────────────────────────────────

function CatalogIndex({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isWide = useMediaQuery("(min-width: 1280px)");
  const catalogHref = `/orgs/${orgSlug}/catalog`;
  const selectedKey = searchParams?.get("entity") ?? null;

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
    // appliedKey serialization is the real dependency (see filter note).
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

  const selected = React.useMemo(
    () => (selectedKey ? (entities.find((e) => urlKey(e) === selectedKey) ?? null) : null),
    [entities, selectedKey],
  );
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

  // Keyboard triage (wide list view): ↑/↓ or j/k move the selection through the
  // pinned panel, ↵ opens the full page, Esc deselects.
  const listRef = React.useRef<HTMLDivElement>(null);
  const scrollRowIntoView = React.useCallback((key: string) => {
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-entitykey="${CSS.escape(key)}"]`)?.scrollIntoView({
        block: "nearest",
      });
    });
  }, []);
  React.useEffect(() => {
    if (!isWide || view !== "list" || shown.length === 0) return;
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
  }, [isWide, view, shown, selectedKey, setSelectedKey, openFull, scrollRowIntoView]);

  const loadFooter =
    cursor !== null ? (
      <div className="flex justify-center pt-3">
        <Button type="button" variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
          Load more
        </Button>
      </div>
    ) : (
      <p className="pt-3 text-center text-[11px] text-muted-foreground">
        {entities.length} component{entities.length === 1 ? "" : "s"} · end of the catalog for these filters.
      </p>
    );

  const detailBody = selected ? (
    <EntityDetailPanel
      entity={selected}
      projectLabel={projectLabel}
      orgSlug={orgSlug}
      onClose={() => setSelectedKey(null)}
    />
  ) : (
    <EntityDetailEmpty />
  );

  // The body region under the fixed top chrome. `flexArea` makes it the single
  // growing, min-h-0 child so the inner scroll containers bound correctly.
  const flexArea = isWide ? "min-h-0 flex-1" : "";

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className={cn(flexArea, isWide && "overflow-y-auto", "space-y-2")}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] w-full rounded-xl" />
        ))}
      </div>
    );
  } else if (error) {
    body = (
      <div className={flexArea}>
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{error.code}</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  } else if (entities.length === 0) {
    body = (
      <div className={flexArea}>
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
      </div>
    );
  } else if (shown.length === 0) {
    body = (
      <div className={flexArea}>
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
      </div>
    );
  } else if (view === "graph") {
    body = (
      <div className={cn(flexArea, isWide && "overflow-y-auto")}>
        <Card>
          <CardContent className="pt-6">
            <DependencyGraph graph={orgGraph} height={520} />
          </CardContent>
        </Card>
      </div>
    );
  } else {
    const list = (
      <>
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
        {loadFooter}
      </>
    );

    body = isWide ? (
      // Fixed frame: the list (left) is the only scroller; the info panel (right)
      // stays put.
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] gap-5">
        <div className="min-h-0 overflow-y-auto scrollbar-thin pr-1">{list}</div>
        <aside aria-label="Component detail" className="min-h-0">
          <div className="relative flex h-full flex-col overflow-hidden rounded-xl border bg-card p-4 shadow-sm">
            {detailBody}
          </div>
        </aside>
      </div>
    ) : (
      <>
        {list}
        <Sheet open={selectedKey !== null} onOpenChange={(open) => (open ? undefined : setSelectedKey(null))}>
          <SheetContent side="right" className="w-[400px] max-w-[92vw] overflow-y-auto">
            {selected ? (
              <>
                <SheetTitle className="sr-only">{selected.name}</SheetTitle>
                <SheetDescription className="sr-only">{selected.entityRef}</SheetDescription>
                <EntityDetailPanel entity={selected} projectLabel={projectLabel} orgSlug={orgSlug} />
              </>
            ) : (
              <SheetTitle className="sr-only">Component</SheetTitle>
            )}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <div className={cn("flex flex-col", isWide ? cn(FRAME, "gap-4") : "gap-5")}>
      <div className={cn("shrink-0", isWide ? "space-y-4" : "space-y-5")}>
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Catalog</h1>
          <p className="text-sm text-muted-foreground">
            The org-wide component graph, merged across every project. Push from the CLI with{" "}
            <code className="font-mono text-xs">orun catalog push</code>.
          </p>
        </header>

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
      </div>

      {body}
    </div>
  );
}

// ── Entity (drilled-in component page) ───────────────────────

function EntityWorkbench({ orgId, orgSlug, entityKey }: { orgId: string; orgSlug: string; entityKey: string }) {
  const { client } = useSession();
  const isWide = useMediaQuery("(min-width: 1280px)");
  const catalogHref = `/orgs/${orgSlug}/catalog`;
  const id = React.useMemo(() => decodeEntityKey(entityKey), [entityKey]);

  // The focused entity resolves over the narrowed list endpoint (provenance +
  // name), then the exact identity triple disambiguates same-named entities.
  const focused = useApiQuery(
    qk.catalogEntity(orgId, entityKey),
    () =>
      wrap(() =>
        client.state.listOrgCatalogEntities(orgId, {
          project: id!.sourceProjectId,
          q: parseEntityRef(id!.entityRef).name || id!.entityRef,
        }),
      ),
    { enabled: id !== null },
  );
  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const projectLabel = React.useCallback(
    (pid: string) => {
      const p = projects.data?.find((x) => x.id === pid);
      return p?.name ?? p?.slug ?? pid;
    },
    [projects.data],
  );
  const entity = React.useMemo(
    () => (id && focused.data ? (focused.data.entities.find((e) => sameEntity(e, id)) ?? null) : null),
    [id, focused.data],
  );

  const back = (
    <Link
      href={catalogHref}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="h-4 w-4" />
      Catalog
    </Link>
  );

  let body: React.ReactNode;
  const flexArea = isWide ? "min-h-0 flex-1" : "";
  if (id === null) {
    body = (
      <div className={flexArea}>
        <EmptyState
          icon={Boxes}
          title="Entity not found"
          description="This catalog link is malformed or out of date."
          primaryAction={{ label: "Back to catalog", href: catalogHref }}
        />
      </div>
    );
  } else if (focused.loading) {
    body = (
      <div className={cn(flexArea, isWide && "overflow-y-auto")}>
        <ComponentPageSkeleton />
      </div>
    );
  } else if (focused.error) {
    body = (
      <div className={flexArea}>
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{focused.error.code}</CardTitle>
            <CardDescription>{focused.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  } else if (!entity) {
    body = (
      <div className={flexArea}>
        <EmptyState
          icon={Boxes}
          title="Component not found"
          description="This component is no longer in the catalog, or its snapshot has moved on."
          primaryAction={{ label: "Back to catalog", href: catalogHref }}
        />
      </div>
    );
  } else if (isWide) {
    // Fixed frame: the component page (center) scrolls; the info panel is fixed.
    body = (
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] gap-5">
        <div className="min-h-0 overflow-y-auto scrollbar-thin pr-1">
          <EntityPage entity={entity} projectLabel={projectLabel} orgSlug={orgSlug} />
        </div>
        <aside aria-label="Additional details" className="min-h-0">
          <EntityInfoPanel />
        </aside>
      </div>
    );
  } else {
    body = (
      <div className="space-y-5">
        <EntityPage entity={entity} projectLabel={projectLabel} orgSlug={orgSlug} />
        <div className="min-h-[160px]">
          <EntityInfoPanel />
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", isWide ? cn(FRAME, "gap-4") : "gap-5")}>
      <div className="shrink-0">{back}</div>
      {body}
    </div>
  );
}

function ComponentPageSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Skeleton className="h-11 w-11 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-64" />
        </div>
      </div>
      <Skeleton className="h-8 w-48" />
      <Card>
        <CardContent className="space-y-2 pt-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
