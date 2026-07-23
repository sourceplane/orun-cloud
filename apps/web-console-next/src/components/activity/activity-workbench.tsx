"use client";

// The Activities surface — the org-wide run feed, always reachable from the
// sidebar (like Catalog), mirroring the orun CLI TUI's "Activity" mode. It feeds
// from the state store: the org-global runs projection merged across every
// project (newest first, keyset "Load more").
//
// Northwind design (scratchpad design/activities.html):
//   • serif PageHeader with a right-aligned HeaderStat strip (runs · 7d,
//     % succeeded, running now) computed over the loaded feed,
//   • a ChipRow of status facets with tone dots + counts, a divider, then the
//     My-teams toggle and the Repo / Env selectors as chips,
//   • an "In progress" band of live run cards with segmented progress bars, and
//   • an "Earlier" white table card (dot · run · sha · actor · duration · when)
//     drilling into the shared run detail route.
//
// Honest by construction: every value is derived from the run projection. The
// header stats and facet counts are computed over the rows currently loaded;
// "Load older runs" extends the feed. A slow auto-refresh keeps live runs
// current without disturbing a reader who has paged further down.

import * as React from "react";
import type { Run, RunStatus, StateCursor } from "@saas/contracts/state";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Chip,
  ChipDivider,
  ChipRow,
  HeaderStat,
  Kicker,
  PageHeader,
  Screen,
} from "@/components/ui/northwind";
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
import { StatusFacets } from "./status-facets";
import { LiveRuns, RunsTable } from "./run-rows";

// `env` selection sentinels: ALL = no env filter; DEFAULT = resolve to the
// highest-tier env once the first page reveals which environments exist.
const ENV_ALL = "all";
const ENV_DEFAULT = "__default__";

/** While live runs are present, silently refresh the first page this often. */
const LIVE_REFRESH_MS = 20_000;
/** Tick the relative-time clock this often (running durations, "5m ago"). */
const CLOCK_TICK_MS = 5_000;

const DAY_MS = 86_400_000;

/** Select trigger restyled as a Northwind filter chip ("Repo: all ▾"). */
const SELECT_CHIP =
  "h-auto w-auto shrink-0 gap-1.5 whitespace-nowrap rounded-full border-border bg-card px-[13px] py-[5px] text-[12.5px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground focus:ring-0 focus:ring-offset-0 [&>svg]:h-3.5 [&>svg]:w-3.5";

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

  // First page rides the shared query cache (IC3): a revisited feed paints
  // instantly from cache (in-memory or persisted) and revalidates in the
  // background instead of skeletoning behind a fresh fetch on every mount.
  // Cursor pagination beyond page 1 stays component-local and resets when the
  // first page changes (filter switch or revalidation).
  const firstPage = useApiQuery(qk.orgRunsFeed(orgId, appliedKey), () =>
    wrap(() => client.state.listOrgRuns(orgId, applied)),
  );
  const [more, setMore] = React.useState<{ runs: Run[]; cursor: StateCursor | null; pages: number } | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [moreError, setMoreError] = React.useState<{ code: string; message: string } | null>(null);

  const runs = React.useMemo<Run[]>(
    () => (firstPage.data ? [...firstPage.data.runs, ...(more?.runs ?? [])] : []),
    [firstPage.data, more],
  );
  const cursor = more ? more.cursor : (firstPage.data?.nextCursor ?? null);
  const pages = firstPage.data ? 1 + (more?.pages ?? 0) : 0;
  const loading = firstPage.loading;
  // A failed background revalidation must not ghost an already-painted feed
  // (matches the pre-IC3 silent-refresh behavior); errors surface only when
  // there is nothing to show.
  const error = (firstPage.data ? null : firstPage.error) ?? moreError;

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

  // Fresh first page (filter switch or revalidation): fold facets in and
  // reset local pagination — the cursor chain belongs to the new page 1.
  React.useEffect(() => {
    if (!firstPage.data) return;
    setMore(null);
    setMoreError(null);
    absorbFacets(firstPage.data.runs);
  }, [firstPage.data, absorbFacets]);

  const loadMore = React.useCallback(async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    const res = await wrap(() =>
      client.state.listOrgRuns(orgId, { ...applied, cursor: `${cursor.createdAt}|${cursor.id}` }),
    );
    if (res.ok) {
      setMore((prev) => ({
        runs: [...(prev?.runs ?? []), ...res.data.runs],
        cursor: res.data.nextCursor,
        pages: (prev?.pages ?? 0) + 1,
      }));
      absorbFacets(res.data.runs);
    } else {
      setMoreError({ code: res.error.code, message: res.error.message });
    }
    setLoadingMore(false);
  }, [client, orgId, appliedKey, cursor, loadingMore, absorbFacets]);

  // Decorate + roll up over the loaded feed.
  const rows = React.useMemo<RunRow[]>(
    () => runs.map((r) => decorateRun(r, projectLabelOf(r.projectId), now)),
    [runs, projectLabelOf, now],
  );
  const summary = React.useMemo(() => summarize(rows, runs, now), [rows, runs, now]);
  const runs7d = React.useMemo(() => rows.filter((r) => r.createdMs >= now - 7 * DAY_MS).length, [rows, now]);
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
  // SWR refresh through the cache: rows stay painted while the fresh first
  // page loads in the background (was a silent bespoke refetch pre-IC3).
  // `reload`'s identity changes per render, so the interval reads it via ref.
  const reloadRef = React.useRef(firstPage.reload);
  reloadRef.current = firstPage.reload;
  React.useEffect(() => {
    if (!hasLive || pages !== 1) return;
    const id = setInterval(() => reloadRef.current(), LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [hasLive, pages]);

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
  const ready = !showSkeleton && !projects.error && !error;

  const hrefOf = React.useCallback(
    (r: RunRow): string | null => {
      const slug = projectSlugOf(r.projectId);
      return slug ? `/orgs/${orgSlug}/projects/${slug}/runs/${r.runId}` : null;
    },
    [projectSlugOf, orgSlug],
  );

  const envChoices = React.useMemo(() => [...envOptions].sort((a, b) => a.localeCompare(b)), [envOptions]);

  return (
    <Screen>
      <PageHeader
        title="Activities"
        description="Every plan and deploy across the workspace — newest first."
        actions={
          ready ? (
            <div className="flex gap-6">
              <HeaderStat value={runs7d} caption="runs · 7d" />
              <HeaderStat value={`${summary.rate}%`} caption="succeeded" tone="success" />
              <HeaderStat value={summary.running} caption="running" {...(summary.running > 0 ? { tone: "info" as const } : {})} />
            </div>
          ) : undefined
        }
      />

      {showSkeleton ? (
        <FeedSkeleton />
      ) : projects.error ? (
        <ErrorCard code={projects.error.code} message={projects.error.message} />
      ) : error ? (
        <ErrorCard code={error.code} message={error.message} />
      ) : (
        <>
          {/* filter chips */}
          <ChipRow className="mt-[26px]">
            <StatusFacets facets={facets} onSelect={setStatusFacet} />
            <ChipDivider />
            {/* teams-ownership TO3 — My teams' activity (owned services' projects). */}
            <Chip active={mine} aria-pressed={mine} onClick={() => setMine((v) => !v)}>
              My teams
            </Chip>
            <Select value={repo} onValueChange={setRepo}>
              <SelectTrigger className={SELECT_CHIP} aria-label="Repo">
                <SelectValue placeholder="Repo: all">
                  {repo === "all" ? "Repo: all" : `Repo: ${projectLabelOf(repo)}`}
                </SelectValue>
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
              <SelectTrigger className={SELECT_CHIP} aria-label="Environment">
                <SelectValue placeholder="Env: all">
                  {resolving || env === ENV_ALL ? "Env: all" : `Env: ${env}`}
                </SelectValue>
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
                className="shrink-0 cursor-pointer border-none bg-transparent text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
              >
                Reset
              </button>
            ) : null}
            <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground/85 sm:inline">
              {visibleRows.length} runs
            </span>
          </ChipRow>

          {/* in-progress live runs */}
          <LiveRuns rows={live} hrefOf={hrefOf} />

          {/* empty / earlier table */}
          {visibleRows.length === 0 ? (
            <div className="mt-[26px] rounded-xl border bg-card px-5 py-[52px] text-center">
              <div className="text-[13.5px] text-foreground/80">No runs match the current selection.</div>
              <div className="mt-1 text-[12.5px] text-muted-foreground/70">
                Widen the repo, environment, or status filter.
              </div>
            </div>
          ) : done.length > 0 ? (
            <>
              <Kicker className="mb-[9px] mt-[26px]">Earlier</Kicker>
              <RunsTable rows={done} hrefOf={hrefOf} />
            </>
          ) : null}

          {/* load older */}
          {cursor !== null ? (
            <div className="mt-4 flex justify-center">
              <Button type="button" variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                Load older runs
              </Button>
            </div>
          ) : visibleRows.length > 0 ? (
            <p className="mt-4 text-center text-[11px] text-muted-foreground/70">
              End of the activity feed for this selection.
            </p>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function FeedSkeleton() {
  return (
    <div className="mt-[26px] flex flex-col gap-[22px]">
      <div className="flex gap-[7px]">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[29px] w-24 rounded-full" />
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border bg-card p-4">
        <div className="space-y-2.5">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

function ErrorCard({ code, message }: { code: string; message: string }) {
  return (
    <Card className="mt-[26px]">
      <CardHeader>
        <CardTitle className="text-destructive">{code}</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}
