"use client";

// The Activities surface — the org-wide run feed, always reachable from the
// sidebar (like Catalog), mirroring the orun CLI TUI's "Activity" mode. It feeds
// from the state store: the org-global runs projection merged across every
// project (newest first, keyset "Load more").
//
// Redesigned to the visual contract
// (`specs/epics/saas-catalog-portal/design/Service_Catalog.dc.html` → Activity):
//   • a Live header, a five-up summary strip (runs today + sparkline, success
//     rate, running now, failed, p50 duration),
//   • status FACET pills with live counts (client-side over the loaded feed),
//   • repo + environment selects (server-side facets that meaningfully narrow),
//   • an "In progress" band of live run cards with progress bars, and
//   • a rich runs table (run · repo · trigger · env · jobs · duration · created)
//     drilling into the shared run detail route.
//
// Honest by construction: every value is derived from the run projection. The
// summary/facets/sparkline are computed over the rows currently loaded; "Load
// more" extends the feed. A slow auto-refresh keeps live runs current without
// disturbing a reader who has paged further down.

import * as React from "react";
import type { Run, RunStatus, StateCursor } from "@saas/contracts/state";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { defaultEnvironment } from "@/lib/environment-rank";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import {
  decorateRun,
  summarize,
  buildFacets,
  applyFacet,
  splitRuns,
  type RunRow,
} from "@/lib/runs-portal/model";
import { RunsSummary } from "./runs-summary";
import { StatusFacets } from "./status-facets";
import { LiveRuns, RunsTable, RunCards } from "./run-rows";

// `env` selection sentinels: ALL = no env filter; DEFAULT = resolve to the
// highest-tier env once the first page reveals which environments exist.
const ENV_ALL = "all";
const ENV_DEFAULT = "__default__";

/** While live runs are present, silently refresh the first page this often. */
const LIVE_REFRESH_MS = 20_000;
/** Tick the relative-time clock this often (running durations, "5m ago"). */
const CLOCK_TICK_MS = 5_000;

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

  // Selectors. Status is a CLIENT facet over the loaded feed; repo/env are
  // server-side facets that meaningfully narrow the merged feed.
  const [repo, setRepo] = React.useState("all");
  const [env, setEnv] = React.useState<string>(ENV_DEFAULT);
  const [statusFacet, setStatusFacet] = React.useState<"all" | RunStatus>("all");
  const [mine, setMine] = React.useState(false);
  const userPickedEnv = React.useRef(false);

  // teams-ownership TO3 — "My teams' activity": the set of projects that host a
  // service owned by one of the viewer's teams. Runs carry a projectId (not a
  // component), so ownership narrows at project granularity. Reuses the catalog +
  // owner-resolution caches shared with the catalog page (no extra cost there).
  const myTeams = useApiQuery(["myTeams", orgId] as const, () =>
    wrap(async () => (await client.teams.myTeams(orgId)).teams),
  );
  const catalog = useApiQuery(qk.orgCatalog(orgId), () =>
    wrap(() => collectOrgCatalog((query) => client.state.listOrgCatalogEntities(orgId, query))),
  );
  const ownerStrings = React.useMemo(
    () => [...new Set((catalog.data ?? []).map((e) => e.owner).filter((o): o is string => !!o))],
    [catalog.data],
  );
  const ownerResolutions = useApiQuery(
    ["ownerResolutions", orgId, ownerStrings.join("\n")] as const,
    () => wrap(async () => (await client.teams.resolveOwners(orgId, { owners: ownerStrings })).resolutions),
  );
  const ownedProjectIds = React.useMemo(() => {
    const myTeamIds = new Set((myTeams.data ?? []).map((t) => t.id));
    const byOwner = new Map((ownerResolutions.data ?? []).map((r) => [r.owner, r]));
    const ids = new Set<string>();
    for (const e of catalog.data ?? []) {
      if (!e.owner) continue;
      const r = byOwner.get(e.owner);
      if (r && r.state === "owned" && r.teamId && myTeamIds.has(r.teamId)) ids.add(e.sourceProjectId);
    }
    return ids;
  }, [catalog.data, ownerResolutions.data, myTeams.data]);

  // Discovered env facet options (grown across loaded pages).
  const [envOptions, setEnvOptions] = React.useState<string[]>([]);

  const applied = React.useMemo(() => {
    const a: { project?: string; environment?: string } = {};
    if (repo !== "all") a.project = repo;
    if (env !== ENV_DEFAULT && env !== ENV_ALL) a.environment = env;
    return a;
  }, [repo, env]);
  const appliedKey = JSON.stringify(applied);

  const [runs, setRuns] = React.useState<Run[]>([]);
  const [cursor, setCursor] = React.useState<StateCursor | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [pages, setPages] = React.useState(0);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);

  // A ticking clock so relative times and live durations stay current.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Fold a page's environments into the facet options, and resolve the default
  // environment once (the highest-tier env present).
  const absorbFacets = React.useCallback((page: Run[]) => {
    const envs = page.map((r) => r.environment).filter((e): e is string => !!e);
    setEnvOptions((prev) => union(prev, envs));
    if (!userPickedEnv.current) {
      setEnv((cur) => (cur === ENV_DEFAULT ? (defaultEnvironment(envs) ?? ENV_ALL) : cur));
    }
  }, []);

  const loadFirstPage = React.useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      const res = await wrap(() => client.state.listOrgRuns(orgId, applied));
      if (res.ok) {
        setRuns(res.data.runs);
        setCursor(res.data.nextCursor);
        setPages(1);
        setError(null);
        absorbFacets(res.data.runs);
      } else if (!silent) {
        setError({ code: res.error.code, message: res.error.message });
        setRuns([]);
        setCursor(null);
      }
      if (!silent) setLoading(false);
      // appliedKey serialization is the real dependency (applied derives from it).
    },
    [client, orgId, appliedKey, absorbFacets],
  );

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
      setPages((p) => p + 1);
      absorbFacets(res.data.runs);
    } else {
      setError({ code: res.error.code, message: res.error.message });
    }
    setLoadingMore(false);
  }, [client, orgId, appliedKey, cursor, loadingMore, absorbFacets]);

  // Decorate + roll up over the loaded feed.
  const rows = React.useMemo<RunRow[]>(
    () => runs.map((r) => decorateRun(r, projectLabelOf(r.projectId), now)),
    [runs, projectLabelOf, now],
  );
  const summary = React.useMemo(() => summarize(rows, runs, now), [rows, runs, now]);
  const facets = React.useMemo(() => buildFacets(rows, statusFacet), [rows, statusFacet]);
  const visibleRows = React.useMemo(() => {
    const faceted = applyFacet(rows, statusFacet);
    // teams-ownership TO3 — narrow to the viewer's teams' owned services' projects.
    return mine ? faceted.filter((r) => ownedProjectIds.has(r.projectId)) : faceted;
  }, [rows, statusFacet, mine, ownedProjectIds]);
  const { live, done } = React.useMemo(() => splitRuns(visibleRows), [visibleRows]);
  const hasLive = rows.some((r) => r.live);

  // Slow auto-refresh: only while live runs exist AND the reader is still on the
  // first page (so paging further down isn't yanked out from under them).
  React.useEffect(() => {
    if (!hasLive || pages !== 1) return;
    const id = setInterval(() => void loadFirstPage(true), LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [hasLive, pages, loadFirstPage]);

  const filtersActive = repo !== "all" || (env !== ENV_DEFAULT && env !== ENV_ALL) || statusFacet !== "all" || mine;
  const clearAll = () => {
    setRepo("all");
    userPickedEnv.current = true; // explicit reset to "all", not auto-resolve
    setEnv(ENV_ALL);
    setStatusFacet("all");
    setMine(false);
  };

  // The env filter is still resolving its default until it leaves the sentinel.
  const resolving = env === ENV_DEFAULT;
  const showSkeleton = projects.loading || loading || resolving;

  const hrefOf = React.useCallback(
    (r: RunRow): string | null => {
      const slug = projectSlugOf(r.projectId);
      return slug ? `/orgs/${orgSlug}/projects/${slug}/runs/${r.runId}` : null;
    },
    [projectSlugOf, orgSlug],
  );

  const envChoices = React.useMemo(() => [...envOptions].sort((a, b) => a.localeCompare(b)), [envOptions]);

  return (
    <div className="flex flex-col gap-[18px]">
      {/* title + live indicator */}
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-primary">Runs</div>
          <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em] text-foreground">Activity</h1>
          <p className="mt-[5px] max-w-[620px] text-[13px] text-muted-foreground">
            Run activity across the workspace, newest first — merged from the state store over every repo.
          </p>
        </div>
        <span
          className="hidden h-[26px] shrink-0 items-center gap-[7px] rounded-[7px] border px-[10px] sm:flex"
          style={{ borderColor: "hsl(var(--success) / 0.25)", background: "hsl(var(--success) / 0.07)" }}
        >
          <span className="h-[6px] w-[6px] animate-pulse rounded-full" style={{ background: "hsl(var(--success))" }} />
          <span className="text-[11.5px]" style={{ color: "hsl(var(--success))" }}>
            Live
          </span>
          <span className="font-mono text-[11px] text-muted-foreground/70">auto-refresh</span>
        </span>
      </div>

      {showSkeleton ? (
        <SummarySkeleton />
      ) : projects.error ? (
        <ErrorCard code={projects.error.code} message={projects.error.message} />
      ) : error ? (
        <ErrorCard code={error.code} message={error.message} />
      ) : (
        <>
          <RunsSummary summary={summary} />

          {/* filter bar */}
          <div className="flex flex-wrap items-center gap-[9px]">
            <StatusFacets facets={facets} onSelect={setStatusFacet} />
            <span className="mx-1 h-[22px] w-px bg-border" aria-hidden="true" />
            {/* teams-ownership TO3 — My teams' activity (owned services' projects). */}
            <button
              type="button"
              onClick={() => setMine((v) => !v)}
              aria-pressed={mine}
              className={`h-8 rounded-md border px-2.5 text-xs outline-none ${mine ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}
            >
              My teams
            </button>
            <Select value={repo} onValueChange={setRepo}>
              <SelectTrigger className="h-8 w-[180px] text-xs" aria-label="Repo">
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
              <SelectTrigger className="h-8 w-[180px] text-xs" aria-label="Environment">
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
            {filtersActive ? (
              <button
                type="button"
                onClick={clearAll}
                className="cursor-pointer border-none bg-transparent text-[12px] text-muted-foreground underline underline-offset-2"
              >
                Reset
              </button>
            ) : null}
            <span className="ml-auto font-mono text-[11.5px] text-muted-foreground/70">{visibleRows.length} runs</span>
          </div>

          {/* in-progress live runs (desktop band) */}
          <div className="hidden md:block">
            <LiveRuns rows={live} hrefOf={hrefOf} />
          </div>

          {/* empty / table */}
          {visibleRows.length === 0 ? (
            <div className="rounded-[13px] border border-border bg-card px-5 py-[52px] text-center">
              <div className="text-[13.5px] text-foreground/80">No runs match the current selection.</div>
              <div className="mt-1 text-[12px] text-muted-foreground/70">
                Widen the repo, environment, or status filter.
              </div>
            </div>
          ) : (
            <>
              {/* desktop: done runs table */}
              <div className="hidden md:block">
                {done.length > 0 ? <RunsTable rows={done} hrefOf={hrefOf} /> : null}
              </div>
              {/* mobile: all rows (live first) as stacked cards */}
              <div className="md:hidden">
                <RunCards rows={visibleRows} hrefOf={hrefOf} />
              </div>
            </>
          )}

          {/* load more */}
          {cursor !== null ? (
            <div className="flex justify-center pt-1">
              <Button type="button" variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                Load more
              </Button>
            </div>
          ) : visibleRows.length > 0 ? (
            <p className="pt-1 text-center text-[11px] text-muted-foreground/70">
              End of the activity feed for this selection.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="flex flex-col gap-[18px]">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] w-full rounded-xl" />
        ))}
      </div>
      <Card>
        <div className="space-y-2 p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </Card>
    </div>
  );
}

function ErrorCard({ code, message }: { code: string; message: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-destructive">{code}</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}