"use client";

// OV7 — the org-global catalog browser. One merged component graph across the
// org's projects (OV6), each row carrying provenance (project, environment,
// commit). Filters narrow by project / kind / owner / env / free-text; clicking
// a row opens a detail panel with its relations + full provenance. "Load more"
// walks the keyset cursor. Mirrors the audit page's manual-pagination pattern.

import * as React from "react";
import { useParams } from "next/navigation";
import { Boxes } from "lucide-react";
import type { OrgCatalogEntity, StateCursor } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

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

/** Stable key: the (project, environment, ref) scope is unique per entity. */
function entityKey(e: OrgCatalogEntity): string {
  return `${e.sourceProjectId}:${e.sourceEnvironment ?? ""}:${e.entityRef}`;
}

const dash = <span className="text-muted-foreground">—</span>;

export default function CatalogPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();

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
  const [selected, setSelected] = React.useState<OrgCatalogEntity | null>(null);

  const loadFirstPage = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelected(null);
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

  const isSelected = (e: OrgCatalogEntity) => selected !== null && entityKey(selected) === entityKey(e);
  const toggle = (e: OrgCatalogEntity) => setSelected((cur) => (cur && entityKey(cur) === entityKey(e) ? null : e));

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

          {selected ? (
            <EntityDetail entity={selected} projectLabel={projectLabel} onClose={() => setSelected(null)} />
          ) : null}

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
    </div>
  );
}

/** The selected entity's full provenance + relations (all from the list row). */
function EntityDetail({
  entity: e,
  projectLabel,
  onClose,
}: {
  entity: OrgCatalogEntity;
  projectLabel: (id: string) => string;
  onClose: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="truncate">{e.name}</span>
            <Badge variant="secondary">{e.kind}</Badge>
          </CardTitle>
          <CardDescription className="break-all font-mono text-xs">{e.entityRef}</CardDescription>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Pair label="Owner" value={e.owner ?? "—"} />
          <Pair label="Lifecycle" value={e.lifecycle ?? "—"} />
          <Pair label="Project" value={projectLabel(e.sourceProjectId)} />
          <Pair label="Environment" value={e.sourceEnvironment ?? "project-wide"} />
          <Pair label="Commit" value={e.sourceCommit ? e.sourceCommit.slice(0, 12) : "—"} mono />
          <Pair label="Snapshot" value={e.headDigest.slice(0, 19)} mono />
        </dl>

        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            Relations ({e.relations.length})
          </div>
          {e.relations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No relations.</p>
          ) : (
            <ul className="space-y-1">
              {e.relations.map((r, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <Badge variant="outline">{r.type}</Badge>
                  <span className="text-muted-foreground">→</span>
                  <span className="break-all font-mono">{r.targetRef}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Pair({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-dashed py-1 last:border-0 sm:last:border-b">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono text-xs")} title={value}>
        {value}
      </dd>
    </div>
  );
}
