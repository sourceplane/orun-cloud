"use client";

/**
 * Workspace Overview — the Workspace landing (saas-workspace-overview WO2).
 *
 * Gives every Workspace a front door: an identity band, a live signal row, and
 * right-rail summaries, composed entirely from data the console already loads
 * (the catalog rollup, the org runs feed, the linked repos). No new endpoint,
 * no console-authored content — the page renders what git produced.
 *
 * Phase 1 (this component) stands the page up from existing reads. The
 * git-authored product narrative band lands in WO5, behind this page.
 */

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Boxes,
  FolderKanban,
  Github,
  LayoutDashboard,
  Terminal,
} from "lucide-react";
import type { PublicProject } from "@saas/contracts/projects";
import type { Run, WorkspaceLink, RepoFacet } from "@saas/contracts/state";

import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import { rollup, toServices } from "@/lib/catalog-portal/model";
import { TIER } from "@/lib/catalog-portal/palette";
import { decorateRun, formatRelative } from "@/lib/runs-portal/model";
import { RUN_STATUS } from "@/lib/runs-portal/palette";
import {
  docDigestOf,
  environmentCount,
  healthyPct,
  overviewActivity,
  primaryRepoFacet,
  repoFromEntityRef,
  resolveOverviewState,
  shortSha,
  tierCounts,
  topAttention,
} from "@/lib/overview/model";
import { repoFullNameFromRemote } from "@/components/integrations/repo-allowlist";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { RunCards } from "@/components/activity/run-rows";
import { StatusMark } from "@/components/activity/run-status-icon";
import { Markdown } from "@/components/overview/markdown";

const TILE = "rounded-xl border border-border bg-card px-4 py-3";
const LABEL = "font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground/80";
const VALUE = "mt-1.5 text-[22px] font-semibold leading-none text-foreground";
const SUB = "mt-1.5 text-[11.5px] text-muted-foreground";

const RECENT_RUNS = 5;
const TOP_REPOS = 5;

export function WorkspaceOverview({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const now = React.useMemo(() => Date.now(), []);

  const catalog = useApiQuery(qk.orgCatalog(orgId), () =>
    wrap(() => collectOrgCatalog((query) => client.state.listOrgCatalogEntities(orgId, query))),
  );
  const runs = useApiQuery(qk.orgRuns(orgId), () =>
    wrap(async () => (await client.state.listOrgRuns(orgId, { limit: 24 })).runs),
  );
  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const links = useApiQuery(qk.orgLinks(orgId), () =>
    wrap(async () => (await client.state.listOrgLinks(orgId)).links),
  );
  const repoFacets = useApiQuery(qk.repoFacets(orgId), () =>
    wrap(async () => (await client.state.listRepoFacets(orgId)).repoFacets),
  );

  const primary = primaryRepoFacet(repoFacets.data ?? []);
  const services = React.useMemo(() => toServices(catalog.data ?? []), [catalog.data]);
  const metrics = React.useMemo(() => rollup(services), [services]);
  const tiers = React.useMemo(() => tierCounts(services), [services]);
  const activity = React.useMemo(
    () => overviewActivity((runs.data ?? []).map((r) => decorateRun(r, "", now)), now),
    [runs.data, now],
  );

  const projectList = projects.data ?? [];
  const linkList = links.data ?? [];

  // Gate the whole page on projects (the cheap query that decides the landing
  // state); the catalog walk and runs stream fill in as they arrive.
  if (projects.loading && !projects.data) return <OverviewSkeleton />;

  const state = resolveOverviewState({
    repoCount: projectList.length,
    catalogCount: catalog.data?.length ?? 0,
  });

  return (
    <div className="space-y-5 sm:space-y-6">
      <IdentityBand
        orgSlug={orgSlug}
        state={state}
        displayName={primary?.displayName ?? null}
        description={primary?.description ?? null}
        components={metrics.total}
        systems={metrics.systems}
        environments={environmentCount(services)}
        repos={projectList.length}
      />

      {state === "no-repo" ? (
        <EmptyState
          icon={LayoutDashboard}
          title="Link a repository to bring this Workspace to life"
          description="Orun's model is repo-is-homepage: run orun cloud link in a repo, then orun plan, and this page fills with your catalog, activity, and product narrative — all authored in the repo."
          primaryAction={{ label: "Link a repository", href: `/orgs/${orgSlug}/integrations` }}
          secondaryAction={{ label: "Browse Git Repos", href: `/orgs/${orgSlug}/projects` }}
        />
      ) : (
        <>
          <SignalRow
            pending={state === "no-plan"}
            catalogLoading={catalog.loading && !catalog.data}
            runsLoading={runs.loading && !runs.data}
            total={metrics.total}
            systems={metrics.systems}
            healthy={healthyPct(metrics.total, metrics.attention)}
            attention={metrics.attention}
            readyPct={metrics.readyPct}
            tiers={tiers}
            activity={activity}
          />

          {state === "no-plan" && <NoPlanHint />}

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              {state === "ready" && primary && (docDigestOf(primary) || primary.description) && (
                <NarrativeBand orgId={orgId} facet={primary} now={now} />
              )}
              <RecentActivityCard
                orgSlug={orgSlug}
                runs={runs.data ?? []}
                projects={projectList}
                loading={runs.loading && !runs.data}
                now={now}
              />
              {state === "ready" && (
                <ComponentsCard
                  orgSlug={orgSlug}
                  total={metrics.total}
                  systems={metrics.systems}
                  ownedPct={metrics.ownedPct}
                  readyPct={metrics.readyPct}
                  attention={topAttention(services, 4)}
                />
              )}
            </div>
            <div className="space-y-4">
              <RepositoriesCard orgSlug={orgSlug} projects={projectList} links={linkList} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Band 1 — identity ────────────────────────────────────────

function IdentityBand({
  orgSlug,
  state,
  displayName,
  description,
  components,
  systems,
  environments,
  repos,
}: {
  orgSlug: string;
  state: "no-repo" | "no-plan" | "ready";
  displayName: string | null;
  description: string | null;
  components: number;
  systems: number;
  environments: number;
  repos: number;
}) {
  return (
    <section className="relative overflow-hidden rounded-xl border border-border bg-card px-4 py-5 sm:px-6 sm:py-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full"
        style={{ background: "radial-gradient(circle, hsl(var(--primary) / 0.10), transparent 70%)" }}
      />
      <div className="relative">
        <div className={LABEL}>Workspace</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
          {displayName || orgSlug}
        </h1>
        {/* Git-authored one-line description from the primary repo facet (WO5). */}
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{description}</p>}
        {state !== "no-repo" && (
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <Fact n={components} one="component" many="components" />
            <span aria-hidden>·</span>
            <Fact n={systems} one="system" many="systems" />
            <span aria-hidden>·</span>
            <Fact n={environments} one="environment" many="environments" />
            <span aria-hidden>·</span>
            <Fact n={repos} one="repo" many="repos" />
          </p>
        )}
        {/* Full-width, thumb-friendly buttons stacked on mobile; inline row from sm up. */}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button asChild size="sm" className="w-full sm:w-auto">
            <Link href={`/orgs/${orgSlug}/catalog`}>Open catalog</Link>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <Link href={`/orgs/${orgSlug}/activities`}>View activity</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function Fact({ n, one, many }: { n: number; one: string; many: string }) {
  return (
    <span>
      <span className="font-medium text-foreground">{n}</span> {n === 1 ? one : many}
    </span>
  );
}

// ── Band 3 (left) — git-authored product narrative ───────────

function NarrativeBand({ orgId, facet, now }: { orgId: string; facet: RepoFacet; now: number }) {
  const { client } = useSession();
  const digest = docDigestOf(facet);
  const doc = useApiQuery(
    qk.docObject(orgId, facet.projectId, digest ?? ""),
    () => wrap(() => client.state.readObjectText(orgId, facet.projectId, digest!)),
    { enabled: !!digest },
  );

  // No overview doc: the description already renders in the identity band, so
  // nudge the author to add one rather than showing an empty panel.
  if (!digest) {
    return (
      <Card className="p-5">
        <div className={LABEL}>Overview</div>
        <p className="mt-2 text-sm text-muted-foreground">
          Add a <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">docs/overview.md</code> and point{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">repo.docs.overview</code> at it to tell your
          team what this product is.
        </p>
      </Card>
    );
  }

  const repo = repoFromEntityRef(facet.entityRef);
  const sha = shortSha(facet.sourceCommit);
  const prov = [repo, sha ? `@${sha}` : null].filter(Boolean).join(" ");
  return (
    <Card className="p-5">
      {(prov || facet.syncedAt) && (
        <div className="mb-3 flex items-center gap-2 border-b border-border pb-3 font-mono text-[11px] text-muted-foreground">
          {prov && <span>From {prov}</span>}
          {facet.syncedAt && <span>· synced {formatRelative(facet.syncedAt, now)}</span>}
        </div>
      )}
      {doc.loading && !doc.data ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
        </div>
      ) : doc.error ? (
        <p className="text-sm text-muted-foreground">Could not load the overview document.</p>
      ) : (
        <Markdown>{doc.data ?? ""}</Markdown>
      )}
    </Card>
  );
}

// ── Band 2 — signal row ──────────────────────────────────────

function SignalRow({
  pending,
  catalogLoading,
  runsLoading,
  total,
  systems,
  healthy,
  attention,
  readyPct,
  tiers,
  activity,
}: {
  pending: boolean;
  catalogLoading: boolean;
  runsLoading: boolean;
  total: number;
  systems: number;
  healthy: number;
  attention: number;
  readyPct: number;
  tiers: { gold: number; silver: number; bronze: number; scored: number };
  activity: { last7d: number; successRate: number; running: number; lastStatus: string | null };
}) {
  const dash = pending;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div className={TILE}>
        <div className={LABEL}>Components</div>
        {dash ? (
          <div className={VALUE}>—</div>
        ) : catalogLoading ? (
          <Skeleton className="mt-1.5 h-[22px] w-12" />
        ) : (
          <div className={VALUE}>{total}</div>
        )}
        <div className={SUB}>{dash ? "no catalog yet" : `across ${systems} systems`}</div>
      </div>

      <div className={TILE}>
        <div className={LABEL}>Health</div>
        {dash ? (
          <div className={VALUE}>—</div>
        ) : catalogLoading ? (
          <Skeleton className="mt-1.5 h-[22px] w-12" />
        ) : (
          <div className={VALUE}>{healthy}%</div>
        )}
        <div className={SUB}>{dash ? "—" : `${attention} need attention`}</div>
      </div>

      <div className={TILE}>
        <div className={LABEL}>Production-ready</div>
        {dash ? (
          <div className={VALUE}>—</div>
        ) : catalogLoading ? (
          <Skeleton className="mt-1.5 h-[22px] w-12" />
        ) : (
          <div className={VALUE}>{readyPct}%</div>
        )}
        {dash ? <div className={SUB}>—</div> : <TierBar tiers={tiers} />}
      </div>

      <div className={TILE}>
        <div className={LABEL}>Activity</div>
        {runsLoading ? (
          <Skeleton className="mt-1.5 h-[22px] w-12" />
        ) : (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[22px] font-semibold leading-none text-foreground">
              {activity.last7d}
            </span>
            {activity.lastStatus && (
              <StatusMark vis={RUN_STATUS[activity.lastStatus as keyof typeof RUN_STATUS]} box={18} glyph={10} />
            )}
          </div>
        )}
        <div className={SUB}>
          {runsLoading
            ? "runs · last 7 days"
            : `${activity.last7d === 1 ? "run" : "runs"} · 7d · ${activity.successRate}% success`}
        </div>
      </div>
    </div>
  );
}

function TierBar({ tiers }: { tiers: { gold: number; silver: number; bronze: number; scored: number } }) {
  if (tiers.scored === 0) return <div className={SUB}>not yet scored</div>;
  const pct = (n: number) => `${Math.round((n / tiers.scored) * 100)}%`;
  return (
    <div className="mt-2 space-y-1">
      <div className="flex h-[5px] overflow-hidden rounded-[3px] bg-muted">
        <span style={{ width: pct(tiers.gold), background: TIER.Gold.c }} />
        <span style={{ width: pct(tiers.silver), background: TIER.Silver.c }} />
        <span style={{ width: pct(tiers.bronze), background: TIER.Bronze.c }} />
      </div>
      <div className={SUB}>
        {tiers.gold} gold · {tiers.silver} silver · {tiers.bronze} bronze
      </div>
    </div>
  );
}

// ── First-run hint ───────────────────────────────────────────

function NoPlanHint() {
  return (
    <Card className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Terminal className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">Run a plan to populate your Workspace</div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          A repository is linked, but no catalog has been published yet. Run a plan to sync the
          catalog and light up the tiles above.
        </p>
      </div>
      <code className="shrink-0 rounded-md border border-border bg-muted px-3 py-1.5 font-mono text-[12px] text-foreground">
        orun plan --push-catalog
      </code>
    </Card>
  );
}

// ── Band 3 — right-rail summaries ────────────────────────────

function CardShell({
  title,
  icon: Icon,
  href,
  hrefLabel,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  hrefLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{title}</span>
        <Link
          href={href}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {hrefLabel} <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

function RecentActivityCard({
  orgSlug,
  runs,
  projects,
  loading,
  now,
}: {
  orgSlug: string;
  runs: Run[];
  projects: PublicProject[];
  loading: boolean;
  now: number;
}) {
  const slugById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.slug);
    return m;
  }, [projects]);
  const labelById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name || p.slug);
    return m;
  }, [projects]);

  const rows = React.useMemo(
    () => runs.slice(0, RECENT_RUNS).map((r) => decorateRun(r, labelById.get(r.projectId) ?? r.projectId, now)),
    [runs, labelById, now],
  );
  const hrefOf = (row: { projectId: string; runId: string }) => {
    const slug = slugById.get(row.projectId);
    return slug ? `/orgs/${orgSlug}/projects/${slug}/runs/${row.runId}` : null;
  };

  return (
    <CardShell title="Recent activity" icon={Activity} href={`/orgs/${orgSlug}/activities`} hrefLabel="All activity">
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <RunCards rows={rows} hrefOf={hrefOf} />
      )}
    </CardShell>
  );
}

function ComponentsCard({
  orgSlug,
  total,
  systems,
  ownedPct,
  readyPct,
  attention,
}: {
  orgSlug: string;
  total: number;
  systems: number;
  ownedPct: number;
  readyPct: number;
  attention: { key: string; name: string; kind: string; owner: string | null }[];
}) {
  return (
    <CardShell title="Components at a glance" icon={Boxes} href={`/orgs/${orgSlug}/catalog`} hrefLabel="Open catalog">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total" value={String(total)} />
        <Stat label="Systems" value={String(systems)} />
        <Stat label="Owned" value={`${ownedPct}%`} />
        <Stat label="Ready" value={`${readyPct}%`} />
      </div>
      {attention.length > 0 && (
        <div className="mt-4">
          <div className={LABEL}>Needs attention</div>
          <ul className="mt-2 space-y-1.5">
            {attention.map((s) => (
              <li key={s.key} className="flex items-center gap-2 text-sm">
                <span className="truncate text-foreground">{s.name}</span>
                <Badge variant={s.owner ? "warning" : "destructive"} className="ml-auto shrink-0">
                  {s.owner ? "unhealthy" : "unowned"}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </CardShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className={LABEL}>{label}</div>
      <div className="mt-1 text-lg font-semibold leading-none text-foreground">{value}</div>
    </div>
  );
}

function RepositoriesCard({
  orgSlug,
  projects,
  links,
}: {
  orgSlug: string;
  projects: PublicProject[];
  links: WorkspaceLink[];
}) {
  const linkByProject = React.useMemo(() => {
    const m = new Map<string, WorkspaceLink>();
    for (const l of links) m.set(l.projectId, l);
    return m;
  }, [links]);
  const shown = projects.slice(0, TOP_REPOS);

  return (
    <CardShell title="Repositories" icon={FolderKanban} href={`/orgs/${orgSlug}/projects`} hrefLabel="All repos">
      {shown.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No repos linked.</p>
      ) : (
        <ul className="space-y-1">
          {shown.map((p) => {
            const link = linkByProject.get(p.id);
            const repo = link ? repoFullNameFromRemote(link.remoteUrl) : null;
            return (
              <li key={p.id}>
                <Link
                  href={`/orgs/${orgSlug}/projects/${p.slug}/environments`}
                  className="flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-muted/50"
                >
                  <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{p.name || p.slug}</span>
                    {repo && (
                      <span className="flex items-center gap-1 truncate font-mono text-[11px] text-muted-foreground">
                        <Github className="h-3 w-3 shrink-0" /> {repo}
                      </span>
                    )}
                  </span>
                  <Badge variant={p.status === "active" ? "success" : "secondary"} className="shrink-0">
                    {p.status}
                  </Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </CardShell>
  );
}

// ── Loading ──────────────────────────────────────────────────

function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-32 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-64 w-full rounded-xl lg:col-span-2" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}
