"use client";

// OV7 — the org-global catalog browser. One merged component graph across the
// org's projects (OV6), each row carrying provenance (project, environment).
// Filters narrow by kind / owner / free-text; "Load more" walks the keyset
// cursor. Mirrors the audit page's manual-pagination + debounced-filter pattern.

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
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";

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

/** Stable React key: the (project, environment, ref) scope is unique per row. */
function entityKey(e: OrgCatalogEntity): string {
  return `${e.sourceProjectId}:${e.sourceEnvironment ?? ""}:${e.entityRef}`;
}

export default function CatalogPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();

  const [kind, setKind] = React.useState("all");
  const [ownerInput, setOwnerInput] = React.useState("");
  const [qInput, setQInput] = React.useState("");
  const owner = useDebounced(ownerInput);
  const q = useDebounced(qInput);

  // Build the query omitting absent filters (exactOptionalPropertyTypes: never
  // pass an explicit undefined — the field is simply absent).
  const applied = React.useMemo(() => {
    const a: { kind?: string; owner?: string; q?: string } = {};
    if (kind !== "all") a.kind = kind;
    if (owner.trim()) a.owner = owner.trim();
    if (q.trim()) a.q = q.trim();
    return a;
  }, [kind, owner, q]);
  const appliedKey = JSON.stringify(applied);

  const [entities, setEntities] = React.useState<OrgCatalogEntity[]>([]);
  const [cursor, setCursor] = React.useState<StateCursor | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);

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

  const filtersActive = applied.kind !== undefined || applied.owner !== undefined || applied.q !== undefined;
  const clearAll = () => {
    setKind("all");
    setOwnerInput("");
    setQInput("");
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

      {/* Filter toolbar — the kind select applies instantly; text inputs debounce. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="h-8 w-[160px] text-xs" aria-label="Kind">
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
          className="h-8 w-[180px] text-xs"
        />
        <Input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search name or ref"
          aria-label="Search"
          className="h-8 w-[240px] text-xs"
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
              <Card key={entityKey(e)} className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="truncate font-medium">{e.name}</div>
                    <div className="break-all font-mono text-[11px] text-muted-foreground">{e.entityRef}</div>
                  </div>
                  <Badge variant="secondary">{e.kind}</Badge>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  {e.owner ? <span>owner: {e.owner}</span> : null}
                  {e.lifecycle ? <span>lifecycle: {e.lifecycle}</span> : null}
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
                  <TableHead>Owner</TableHead>
                  <TableHead>Lifecycle</TableHead>
                  <TableHead>Environment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entities.map((e) => (
                  <TableRow key={entityKey(e)}>
                    <TableCell className="font-medium">{e.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{e.kind}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{e.entityRef}</TableCell>
                    <TableCell className="text-sm">{e.owner ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-sm">{e.lifecycle ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-sm">
                      {e.sourceEnvironment ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
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
            <p className="pt-1 text-center text-[11px] text-muted-foreground">End of the catalog for these filters.</p>
          )}
        </>
      )}
    </div>
  );
}
