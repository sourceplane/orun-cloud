"use client";

// The Activities surface — the org-wide run feed, always reachable from the
// sidebar (like Catalog), mirroring the orun CLI TUI's "Activity" mode. Both
// feed from the state store: this reads the org-global runs projection merged
// across every project (newest first, keyset "Load more").
//
// Selection lives at the TOP (like the catalog browser), not in the sidebar:
//   • Repo        — All repos (default) · a single project
//   • Environment — the highest (most production-like) env by default
//   • Source      — the run's branch; `main` by default (= the state store's
//                   mainline root), `All sources`, or any branch seen
//   • Status      — pending · running · succeeded · failed · canceled
//
// Repo/env/source/status are FACETS over the merged feed, not partitions. Rows
// drill into the existing per-repo run detail page (resolved via the run's own
// project), so the detail view is shared, not duplicated.

import * as React from "react";
import Link from "next/link";
import { Activity } from "lucide-react";
import type { Run, RunStatus, StateCursor } from "@saas/contracts/state";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { wrap } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { defaultEnvironment } from "@/lib/environment-rank";

const STATUS_OPTIONS: RunStatus[] = ["pending", "running", "succeeded", "failed", "canceled"];

// `env` selection sentinels: ALL = no env filter; DEFAULT = resolve to the
// highest-tier env once the first page reveals which environments exist.
const ENV_ALL = "all";
const ENV_DEFAULT = "__default__";
// `source` selection: ALL = no branch filter; otherwise the branch name.
const SOURCE_ALL = "all";
const SOURCE_MAIN = "main";

/** Map a run status to a Badge tone. */
function statusVariant(status: RunStatus): "success" | "destructive" | "warning" | "secondary" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "destructive";
    case "running":
    case "pending":
      return "warning";
    case "canceled":
      return "secondary";
  }
}

/** A run's branch: its git ref with the `refs/heads/` prefix stripped. */
function branchOf(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return ref.replace(/^refs\/heads\//, "");
}

function union(prev: readonly string[], next: readonly string[]): string[] {
  const set = new Set(prev);
  for (const n of next) if (n) set.add(n);
  return [...set];
}

export function ActivityWorkbench({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();

  // Projects power the Repo selector and the row → run-detail links (a run
  // carries its projectId; the detail route is keyed by projectSlug).
  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const projectSlugOf = React.useCallback(
    (id: string) => projects.data?.find((p) => p.id === id)?.slug ?? null,
    [projects.data],
  );
  const projectLabelOf = React.useCallback(
    (id: string) => {
      const p = projects.data?.find((x) => x.id === id);
      return p?.name ?? p?.slug ?? id;
    },
    [projects.data],
  );

  // Selectors (local state — the established pattern for run filters).
  const [repo, setRepo] = React.useState("all");
  const [env, setEnv] = React.useState<string>(ENV_DEFAULT);
  const [source, setSource] = React.useState<string>(SOURCE_MAIN);
  const [status, setStatus] = React.useState("all");
  const userPickedEnv = React.useRef(false);

  // Discovered facet options (grown across loaded pages).
  const [envOptions, setEnvOptions] = React.useState<string[]>([]);
  const [branchOptions, setBranchOptions] = React.useState<string[]>([SOURCE_MAIN]);

  const applied = React.useMemo(() => {
    const a: { project?: string; environment?: string; status?: string; branch?: string } = {};
    if (repo !== "all") a.project = repo;
    if (env !== ENV_DEFAULT && env !== ENV_ALL) a.environment = env;
    if (status !== "all") a.status = status;
    if (source !== SOURCE_ALL) a.branch = source;
    return a;
  }, [repo, env, status, source]);
  const appliedKey = JSON.stringify(applied);

  const [runs, setRuns] = React.useState<Run[]>([]);
  const [cursor, setCursor] = React.useState<StateCursor | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);

  // Fold a freshly-loaded page's environments/branches into the facet options,
  // and resolve the default environment once (the highest-tier env present).
  const absorbFacets = React.useCallback((page: Run[]) => {
    const envs = page.map((r) => r.environment).filter((e): e is string => !!e);
    const branches = page.map((r) => branchOf(r.git.ref)).filter((b): b is string => !!b);
    setEnvOptions((prev) => union(prev, envs));
    setBranchOptions((prev) => union(prev, [SOURCE_MAIN, ...branches]));
    if (!userPickedEnv.current) {
      setEnv((cur) => (cur === ENV_DEFAULT ? (defaultEnvironment(envs) ?? ENV_ALL) : cur));
    }
  }, []);

  const loadFirstPage = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await wrap(() => client.state.listOrgRuns(orgId, applied));
    if (res.ok) {
      setRuns(res.data.runs);
      setCursor(res.data.nextCursor);
      absorbFacets(res.data.runs);
    } else {
      setError({ code: res.error.code, message: res.error.message });
      setRuns([]);
      setCursor(null);
    }
    setLoading(false);
    // appliedKey serialization is the real dependency (applied is derived from it).
  }, [client, orgId, appliedKey, absorbFacets]);

  React.useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = React.useCallback(async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    const res = await wrap(() =>
      client.state.listOrgRuns(orgId, { ...applied, cursor: `${cursor.createdAt}|${cursor.id}` }),
    );
    if (res.ok) {
      setRuns((prev) => [...prev, ...res.data.runs]);
      setCursor(res.data.nextCursor);
      absorbFacets(res.data.runs);
    } else {
      setError({ code: res.error.code, message: res.error.message });
    }
    setLoadingMore(false);
  }, [client, orgId, appliedKey, cursor, loadingMore, absorbFacets]);

  const filtersActive =
    applied.project !== undefined ||
    applied.environment !== undefined ||
    applied.status !== undefined ||
    (source !== SOURCE_ALL && source !== SOURCE_MAIN);
  const clearAll = () => {
    setRepo("all");
    userPickedEnv.current = true; // explicit reset to "all", not auto-resolve
    setEnv(ENV_ALL);
    setSource(SOURCE_MAIN);
    setStatus("all");
  };

  // The env filter is still resolving its default until it leaves the sentinel.
  const resolving = env === ENV_DEFAULT;
  const showSkeleton = projects.loading || loading || resolving;

  const runHref = (r: Run): string | null => {
    const slug = projectSlugOf(r.projectId);
    return slug ? `/orgs/${orgSlug}/projects/${slug}/runs/${r.runId}` : null;
  };

  // Sorted, de-duplicated facet options for the dropdowns.
  const envChoices = React.useMemo(() => [...envOptions].sort((a, b) => a.localeCompare(b)), [envOptions]);
  const branchChoices = React.useMemo(
    () => [...branchOptions].sort((a, b) => (a === SOURCE_MAIN ? -1 : b === SOURCE_MAIN ? 1 : a.localeCompare(b))),
    [branchOptions],
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Activities</h1>
        <p className="text-sm text-muted-foreground">
          Run activity across the organization, newest first — merged from the state store over every repo.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={repo} onValueChange={setRepo}>
          <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Repo">
            <SelectValue placeholder="Repo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All repos</SelectItem>
            {(projects.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name ?? p.slug}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={resolving ? ENV_ALL : env}
          onValueChange={(v) => {
            userPickedEnv.current = true;
            setEnv(v);
          }}
        >
          <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Environment">
            <SelectValue placeholder="Environment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ENV_ALL}>All environments</SelectItem>
            {envChoices.map((e) => (
              <SelectItem key={e} value={e}>
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Source">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SOURCE_ALL}>All sources</SelectItem>
            {branchChoices.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {showSkeleton ? (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : projects.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{projects.error.code}</CardTitle>
            <CardDescription>{projects.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{error.code}</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={filtersActive ? "No matching activity" : "No activity yet"}
          description={
            filtersActive
              ? "No runs match the current selection. Widen the repo, environment, or source."
              : "Runs appear here as the CLI or CI executes plans across the organization."
          }
          {...(filtersActive ? { primaryAction: { label: "Reset filters", onClick: clearAll } } : {})}
        />
      ) : (
        <>
          {/* Mobile: stacked cards */}
          <div className="space-y-3 md:hidden">
            {runs.map((r) => {
              const href = runHref(r);
              const id = (
                <span className="block break-all font-mono text-xs">{r.runId}</span>
              );
              return (
                <Card key={`${r.projectId}:${r.runId}`} className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      {href ? (
                        <Link href={href} className="block break-all font-mono text-xs hover:underline">
                          {r.runId}
                        </Link>
                      ) : (
                        id
                      )}
                      <div className="text-[11px] text-muted-foreground">
                        {projectLabelOf(r.projectId)} · {formatTimestamp(r.createdAt)}
                      </div>
                    </div>
                    <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    {r.environment ? <span>env: {r.environment}</span> : null}
                    {branchOf(r.git.ref) ? <span>{branchOf(r.git.ref)}</span> : null}
                    {r.git.commit ? <span className="font-mono">{r.git.commit.slice(0, 7)}</span> : null}
                    <span>
                      {r.jobCounts.succeeded}✓ {r.jobCounts.failed}✗ {r.jobCounts.running + r.jobCounts.queued}⋯
                    </span>
                  </div>
                </Card>
              );
            })}
          </div>

          {/* Desktop: table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Jobs</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => {
                  const href = runHref(r);
                  const branch = branchOf(r.git.ref);
                  return (
                    <TableRow key={`${r.projectId}:${r.runId}`}>
                      <TableCell className="font-mono text-xs">
                        {href ? (
                          <Link href={href} className="hover:underline">
                            {r.runId}
                          </Link>
                        ) : (
                          r.runId
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{projectLabelOf(r.projectId)}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.environment ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {branch ? (
                          <span className="font-mono">{branch}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {r.git.commit ? (
                          <span className="ml-2 font-mono opacity-70">{r.git.commit.slice(0, 7)}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.jobCounts.succeeded}✓ {r.jobCounts.failed}✗ {r.jobCounts.running + r.jobCounts.queued}⋯
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatTimestamp(r.createdAt)}</TableCell>
                    </TableRow>
                  );
                })}
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
              End of the activity feed for this selection.
            </p>
          )}
        </>
      )}
    </div>
  );
}
