"use client";

// OV7 — the org-global catalog browser, redesigned as a master-detail surface.
// One merged component graph across the org's projects (OV6), each row carrying
// provenance (project, environment, commit). Filters narrow by project / kind /
// owner / env / free-text. The list is a column of "thick" rows; selecting one
// (URL-synced via `?entity=`) shows it in a **pinned detail panel** on wide
// screens (the third panel, alongside the global nav and the list), and in a
// peek **drawer** below `xl`. "Open page" promotes the peek to the dedicated
// entity route. "Load more" walks the keyset cursor (audit-page pattern).

import * as React from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Boxes } from "lucide-react";
import type { OrgCatalogEntity, StateCursor } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
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
import { encodeEntityKey } from "@/lib/catalog-entity-key";
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

/**
 * Track a media query (client-only). Drives the 3-panel ⇄ drawer switch: the
 * pinned detail panel and the peek drawer are mutually exclusive, and Radix
 * portals the drawer to <body> (ignoring CSS `hidden`), so the choice has to be
 * made in JS. Starts `false` (mobile-first) and settles on mount — invisible
 * because the catalog data loads behind a skeleton first.
 */
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
function entityKey(e: OrgCatalogEntity): string {
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

export default function CatalogPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedKey = searchParams?.get("entity") ?? null;
  // ≥ xl: the detail panel is pinned as the third panel; below, it's a drawer.
  const isWide = useMediaQuery("(min-width: 1280px)");

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

  /** Set or clear the `?entity=` selection without growing the history stack. */
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

  const selected = React.useMemo(
    () => entities.find((e) => urlKey(e) === selectedKey) ?? null,
    [entities, selectedKey],
  );
  // SC4 data-quality insights, computed over the loaded view, drive a
  // click-to-filter narrowing (`shown`) applied to the list and graph.
  const insights = React.useMemo(() => computeInsights(entities), [entities]);
  const shown = React.useMemo(
    () => (insight ? filterByInsight(entities, insight) : entities),
    [entities, insight],
  );
  // The set of rows with a relation pointing outside the loaded catalog — drives
  // the per-row "dangling" badge (reuses the SC4 insight definition).
  const danglingKeys = React.useMemo(
    () => new Set(filterByInsight(entities, "dangling-deps").map(urlKey)),
    [entities],
  );
  const orgGraph = React.useMemo(() => buildOrgGraph(shown, orgSlug), [shown, orgSlug]);
  const isSelected = (e: OrgCatalogEntity) => selectedKey !== null && urlKey(e) === selectedKey;
  const toggle = (e: OrgCatalogEntity) => {
    const k = urlKey(e);
    setSelectedKey(selectedKey === k ? null : k);
  };

  // Keyboard triage (wide, list view only): ↑/↓ or j/k move the selection
  // through the pinned panel, ↵ opens the full page, Esc deselects. Ignored when
  // a form field is focused, and when a modifier is held (so Cmd-K still works).
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
        router.push(`/orgs/${orgSlug}/catalog/${selectedKey}`);
      } else if (ev.key === "Escape" && selectedKey) {
        setSelectedKey(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isWide, view, shown, selectedKey, setSelectedKey, scrollRowIntoView, router, orgSlug]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Catalog</h1>
        <p className="text-sm text-muted-foreground">
          The org-wide component graph, merged across every project. Push from the CLI with{" "}
          <code className="font-mono text-xs">orun catalog push</code>.
        </p>
      </header>

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
            // Master-detail: the thick-row list, plus the pinned detail panel as
            // the third panel on wide screens (drawer below xl, rendered later).
            <div className={cn("grid items-start gap-5", isWide && "grid-cols-[minmax(0,1fr)_360px]")}>
              <div ref={listRef} className="space-y-2">
                {shown.map((e) => (
                  <EntityListItem
                    key={entityKey(e)}
                    entity={e}
                    projectLabel={projectLabel}
                    selected={isSelected(e)}
                    dangling={danglingKeys.has(urlKey(e))}
                    urlKey={urlKey(e)}
                    onSelect={() => toggle(e)}
                  />
                ))}
              </div>

              {isWide ? (
                <aside aria-label="Component detail">
                  <div className="sticky top-6">
                    <div className="relative flex min-h-[460px] max-h-[calc(100dvh-5.5rem)] flex-col overflow-hidden rounded-xl border bg-card p-4 shadow-sm">
                      {selected ? (
                        <EntityDetailPanel
                          entity={selected}
                          projectLabel={projectLabel}
                          orgSlug={orgSlug}
                          onClose={() => setSelectedKey(null)}
                        />
                      ) : (
                        <EntityDetailEmpty />
                      )}
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

      {/* Peek drawer — only below xl, where the panel isn't pinned. Mutually
          exclusive with the pinned panel so a selection never opens both. */}
      {!isWide ? (
        <Sheet open={selected !== null} onOpenChange={(open) => (open ? undefined : setSelectedKey(null))}>
          <SheetContent side="right" className="w-[400px] max-w-[92vw] overflow-y-auto">
            {selected ? (
              <>
                <SheetTitle className="sr-only">{selected.name}</SheetTitle>
                <SheetDescription className="sr-only">{selected.entityRef}</SheetDescription>
                <EntityDetailPanel entity={selected} projectLabel={projectLabel} orgSlug={orgSlug} />
              </>
            ) : null}
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
