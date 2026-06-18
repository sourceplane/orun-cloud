"use client";

// OV7 — the org-global catalog browser. One merged component graph across the
// org's projects (OV6), each row carrying provenance (project, environment,
// commit). Filters narrow by project / kind / owner / env / free-text; clicking
// a row opens a quick-peek drawer (URL-synced via `?entity=`) with an "Expand"
// to the dedicated entity route. "Load more" walks the keyset cursor. Mirrors
// the audit page's manual-pagination pattern.

import * as React from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Boxes, ArrowUpRight } from "lucide-react";
import type { OrgCatalogEntity, StateCursor } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
import { EntityOverview } from "@/components/catalog/entity-overview";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { encodeEntityKey } from "@/lib/catalog-entity-key";

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

const dash = <span className="text-muted-foreground">—</span>;

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
  const isSelected = (e: OrgCatalogEntity) => selectedKey !== null && urlKey(e) === selectedKey;
  const toggle = (e: OrgCatalogEntity) => {
    const k = urlKey(e);
    setSelectedKey(selectedKey === k ? null : k);
  };

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
      </div>

      {loading ? (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
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
          {/* Mobile: stacked cards */}
          <div className="space-y-3 md:hidden">
            {entities.map((e) => (
              <Card
                key={entityKey(e)}
                onClick={() => toggle(e)}
                className={cn("cursor-pointer space-y-2 p-4 transition-colors", isSelected(e) && "ring-1 ring-primary")}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="truncate font-medium">{e.name}</div>
                    <div className="break-all font-mono text-[11px] text-muted-foreground">{e.entityRef}</div>
                  </div>
                  <Badge variant="secondary">{e.kind}</Badge>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{projectLabel(e.sourceProjectId)}</span>
                  {e.owner ? <span>owner: {e.owner}</span> : null}
                  {e.sourceEnvironment ? <span>env: {e.sourceEnvironment}</span> : null}
                </div>
              </Card>
            ))}
          </div>

          {/* Desktop: table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Ref</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Lifecycle</TableHead>
                  <TableHead>Environment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entities.map((e) => (
                  <TableRow
                    key={entityKey(e)}
                    onClick={() => toggle(e)}
                    className={cn("cursor-pointer", isSelected(e) && "bg-accent/60")}
                  >
                    <TableCell className="font-medium">{e.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{e.kind}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{e.entityRef}</TableCell>
                    <TableCell className="text-sm">{projectLabel(e.sourceProjectId)}</TableCell>
                    <TableCell className="text-sm">{e.owner ?? dash}</TableCell>
                    <TableCell className="text-sm">{e.lifecycle ?? dash}</TableCell>
                    <TableCell className="text-sm">{e.sourceEnvironment ?? dash}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

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

      {/* Quick-peek drawer: opens when `?entity=` resolves to a loaded row. */}
      <Sheet open={selected !== null} onOpenChange={(open) => (open ? undefined : setSelectedKey(null))}>
        <SheetContent side="right" className="w-[420px] max-w-[92vw] overflow-y-auto">
          {selected ? (
            <>
              <SheetHeader className="pr-8">
                <SheetTitle className="flex items-center gap-2 text-base">
                  <span className="truncate">{selected.name}</span>
                  <Badge variant="secondary">{selected.kind}</Badge>
                </SheetTitle>
                <SheetDescription className="break-all font-mono">{selected.entityRef}</SheetDescription>
              </SheetHeader>
              <EntityOverview entity={selected} projectLabel={projectLabel} />
              <Link
                href={`/orgs/${orgSlug}/catalog/${urlKey(selected)}`}
                className="mt-auto inline-flex w-full items-center justify-center gap-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
              >
                Expand
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
