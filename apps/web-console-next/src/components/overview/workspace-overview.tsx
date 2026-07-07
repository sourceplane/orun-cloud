"use client";

/**
 * Workspace Overview — the Workspace landing (saas-workspace-overview WO2),
 * in the Northwind design: a dated serif greeting, a narrative lede whose
 * numbers deep-link into the product, three signal tiles, the needs-attention
 * and latest-activity columns, and the repository strip. Composed entirely
 * from data the console already loads (the catalog rollup, the org runs feed,
 * the linked repos) — no new endpoints, no console-authored content.
 */

import * as React from "react";
import Link from "next/link";
import { LayoutDashboard, Terminal } from "lucide-react";
import type { PublicProject } from "@saas/contracts/projects";
import type { Run, WorkspaceLink, RepoFacet } from "@saas/contracts/state";

import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import { rollup, toServices, type CatalogService } from "@/lib/catalog-portal/model";
import { decorateRun, formatRelative } from "@/lib/runs-portal/model";
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

import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, InteractiveCard } from "@/components/ui/card";
import {
  Kicker,
  ListCard,
  ListCardHeader,
  ListRow,
  QuietLink,
  Screen,
  StatCard,
  StatusDot,
  StatusText,
  type Tone,
} from "@/components/ui/northwind";
import { Markdown } from "@/components/overview/markdown";
import { useEntityDocs, docRoleIcon } from "@/components/catalog/docs/entity-docs";
import { encodeEntityKey } from "@/lib/catalog-entity-key";
import { PathIcon } from "@/components/catalog/portal/icon";
import { DOC_ICON } from "@/lib/catalog-portal/icons";

const RECENT_RUNS = 4;
const TOP_REPOS = 4;

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
  const profile = useApiQuery(qk.profile(), () =>
    wrap(async () => (await client.auth.getProfile()).user),
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

  const firstName =
    (profile.data?.displayName || profile.data?.email || "").split(/[\s@]/)[0] || null;

  return (
    <Screen>
      <Greeting name={firstName} />
      <NarrativeLede
        orgSlug={orgSlug}
        orgName={primary?.displayName ?? orgSlug}
        state={state}
        services={metrics.total}
        repos={projectList.length}
        environments={environmentCount(services)}
        activity={activity}
        attention={metrics.attention}
      />

      {state === "no-repo" ? (
        <div className="mt-10">
          <EmptyState
            icon={LayoutDashboard}
            title="Link a repository to bring this Workspace to life"
            description="Orun's model is repo-is-homepage: run orun cloud link in a repo, then orun plan, and this page fills with your catalog, activity, and product narrative — all authored in the repo."
            primaryAction={{ label: "Link a repository", href: `/orgs/${orgSlug}/integrations` }}
            secondaryAction={{ label: "Browse Git Repos", href: `/orgs/${orgSlug}/projects` }}
          />
        </div>
      ) : (
        <>
          {/* Signal tiles */}
          <div className="mt-10 grid gap-3.5 sm:grid-cols-3">
            <StatCard
              label="Activity · 7 days"
              value={
                runs.loading && !runs.data ? <Skeleton className="h-8 w-14" /> : activity.last7d
              }
              unit={activity.last7d === 1 ? "run" : "runs"}
              footer={
                <StatusText tone={activity.running > 0 ? "info" : "success"} live={activity.running > 0}>
                  {activity.successRate}% succeeded
                  {activity.running > 0 ? ` · ${activity.running} running` : ""}
                </StatusText>
              }
            />
            <StatCard
              label="Catalog health"
              value={
                catalog.loading && !catalog.data ? (
                  <Skeleton className="h-8 w-14" />
                ) : (
                  `${healthyPct(metrics.total, metrics.attention)}%`
                )
              }
              unit="healthy"
              footer={
                metrics.attention > 0 ? (
                  <StatusText tone="warning">
                    {metrics.attention} {metrics.attention === 1 ? "service needs" : "services need"} attention
                  </StatusText>
                ) : (
                  <StatusText tone="success">everything looks healthy</StatusText>
                )
              }
            />
            <MaturityCard tiers={tiers} />
          </div>

          {state === "no-plan" && <NoPlanHint />}

          {/* Two columns: needs attention / latest activity */}
          <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
            <AttentionCard orgSlug={orgSlug} attention={topAttention(services, 4)} loading={catalog.loading && !catalog.data} />
            <LatestActivityCard
              orgSlug={orgSlug}
              runs={runs.data ?? []}
              projects={projectList}
              loading={runs.loading && !runs.data}
              now={now}
            />
          </div>

          {/* Repositories strip */}
          <div className="mb-3.5 mt-10 flex items-center justify-between">
            <span className="text-[13.5px] font-semibold">Repositories</span>
            <QuietLink href={`/orgs/${orgSlug}/projects`}>All repos →</QuietLink>
          </div>
          <RepoStrip orgSlug={orgSlug} projects={projectList} links={linkList} services={services} />

          {/* Git-authored product narrative + primary docs (WO5 / CD5). */}
          {state === "ready" && primary && (docDigestOf(primary) || primary.description) && (
            <div className="mt-10 grid items-start gap-3.5 lg:grid-cols-[1.6fr_1fr]">
              <NarrativeBand orgId={orgId} facet={primary} now={now} />
              {primary.entityRef ? (
                <PrimaryDocsCard orgId={orgId} orgSlug={orgSlug} facet={primary} />
              ) : null}
            </div>
          )}
        </>
      )}
    </Screen>
  );
}

/* ── Greeting + narrative ─────────────────────────────────────── */

function Greeting({ name }: { name: string | null }) {
  const nowDate = new Date();
  const dateLine = nowDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const hour = nowDate.getHours();
  const daypart = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return (
    <>
      <div className="mb-2.5 text-xs tracking-[0.02em] text-muted-foreground/85">{dateLine}</div>
      <h1 className="font-serif text-[28px] font-medium leading-[1.15] tracking-[-0.01em] sm:text-[32px]">
        Good {daypart}
        {name ? `, ${name}` : ""}.
      </h1>
    </>
  );
}

function NarrativeLede({
  orgSlug,
  orgName,
  state,
  services,
  repos,
  environments,
  activity,
  attention,
}: {
  orgSlug: string;
  orgName: string;
  state: "no-repo" | "no-plan" | "ready";
  services: number;
  repos: number;
  environments: number;
  activity: { last7d: number; successRate: number; running: number };
  attention: number;
}) {
  const base = `/orgs/${orgSlug}`;
  if (state === "no-repo") {
    return (
      <p className="mt-3.5 max-w-[640px] font-serif text-lg leading-relaxed text-secondary-foreground">
        {orgName} is brand new. Link a repository and the workspace fills itself in — catalog,
        docs, activity, all derived from git.
      </p>
    );
  }
  const mood = attention > 0 ? "mostly quiet" : activity.running > 0 ? "humming along" : "quiet today";
  return (
    <p className="mt-3.5 max-w-[640px] font-serif text-lg leading-relaxed text-secondary-foreground">
      {orgName} is {mood}.{" "}
      <Link href={`${base}/catalog`} className="link-prose">
        {services} {services === 1 ? "service" : "services"}
      </Link>{" "}
      across{" "}
      <Link href={`${base}/projects`} className="link-prose">
        {repos} {repos === 1 ? "repository" : "repositories"}
      </Link>
      {environments > 0 ? ` and ${environments} ${environments === 1 ? "environment" : "environments"}` : ""}
      {activity.last7d > 0 ? (
        <>
          {" "}
          — {activity.successRate}% of this week&rsquo;s runs succeeded
          {activity.running > 0 ? (
            <>
              , {activity.running === 1 ? "one deploy is" : `${activity.running} deploys are`}{" "}
              <Link href={`${base}/activities`} className="link-prose">
                running now
              </Link>
            </>
          ) : null}
        </>
      ) : (
        <> — no runs yet this week</>
      )}
      {attention > 0 ? (
        <>
          , and{" "}
          <Link href={`${base}/catalog`} className="link-prose">
            {attention === 1 ? "one service" : `${attention} services`}
          </Link>{" "}
          could use your attention.
        </>
      ) : (
        <>.</>
      )}
    </p>
  );
}

/* ── Signal tiles ─────────────────────────────────────────────── */

function MaturityCard({
  tiers,
}: {
  tiers: { gold: number; silver: number; bronze: number; scored: number };
}) {
  return (
    <div className="rounded-xl border bg-card px-[22px] py-5">
      <Kicker>Maturity</Kicker>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="font-serif text-[34px] font-medium leading-none">{tiers.gold}</span>
        <span className="text-[13px] text-muted-foreground">
          {tiers.scored > 0 ? `of ${tiers.scored} scored are Gold` : "not yet scored"}
        </span>
      </div>
      {tiers.scored > 0 ? (
        <>
          <div className="mt-4 flex h-1.5 gap-0.5 overflow-hidden rounded-[3px]">
            {tiers.gold > 0 && <span className="rounded-[3px] bg-[#C39B45]" style={{ flex: tiers.gold }} />}
            {tiers.silver > 0 && <span className="rounded-[3px] bg-[#B0AA9A]" style={{ flex: tiers.silver }} />}
            {tiers.bronze > 0 && <span className="rounded-[3px] bg-[#D8C6A8]" style={{ flex: tiers.bronze }} />}
          </div>
          <div className="mt-2 flex gap-3.5 text-[11.5px] text-muted-foreground">
            <span>{tiers.gold} gold</span>
            <span>{tiers.silver} silver</span>
            <span>{tiers.bronze} bronze</span>
          </div>
        </>
      ) : (
        <div className="mt-4 text-[12.5px] text-muted-foreground/80">
          Scores appear once entities declare a maturity tier.
        </div>
      )}
    </div>
  );
}

/* ── Needs attention / latest activity ────────────────────────── */

function AttentionCard({
  orgSlug,
  attention,
  loading,
}: {
  orgSlug: string;
  attention: { key: string; name: string; kind: string; owner: string | null }[];
  loading: boolean;
}) {
  return (
    <ListCard>
      <ListCardHeader
        title="Needs attention"
        action={<QuietLink href={`/orgs/${orgSlug}/catalog`}>Catalog →</QuietLink>}
      />
      {loading ? (
        <div className="space-y-2 px-5 pb-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <>
          {attention.map((s) => (
            <ListRow
              key={s.key}
              href={`/orgs/${orgSlug}/catalog/${s.key}`}
              chevron
              className="py-3"
            >
              <StatusDot tone="warning" className="h-2 w-2" />
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium">{s.name}</span>
                <span className="mt-px block truncate text-xs text-muted-foreground">
                  {s.owner
                    ? "Needs attention — check health and readiness"
                    : "Unowned — no team resolves for this entity"}
                </span>
              </span>
            </ListRow>
          ))}
          <div className="border-t border-border/50 px-5 py-3 pb-4 text-[12.5px] text-muted-foreground/85">
            {attention.length === 0 ? "Everything is healthy." : "Everything else is healthy."}
          </div>
        </>
      )}
    </ListCard>
  );
}

function LatestActivityCard({
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
    () =>
      runs
        .slice(0, RECENT_RUNS)
        .map((r) => decorateRun(r, labelById.get(r.projectId) ?? r.projectId, now)),
    [runs, labelById, now],
  );

  return (
    <ListCard>
      <ListCardHeader
        title="Latest activity"
        action={<QuietLink href={`/orgs/${orgSlug}/activities`}>Activities →</QuietLink>}
      />
      {loading ? (
        <div className="space-y-2 px-5 pb-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="border-t border-border/50 px-5 py-4 text-[12.5px] text-muted-foreground/85">
          No runs yet — they appear here as soon as a plan or deploy starts.
        </div>
      ) : (
        rows.map((row) => {
          const slug = slugById.get(row.projectId);
          const href = slug ? `/orgs/${orgSlug}/projects/${slug}/runs/${row.runId}` : undefined;
          const tone: Tone =
            row.live || row.status === "pending"
              ? "info"
              : row.status === "succeeded"
                ? "success"
                : row.status === "failed"
                  ? "error"
                  : "neutral";
          return (
            <ListRow key={row.key} {...(href ? { href } : {})} className="py-[11px]">
              <StatusDot tone={tone} live={row.live} className="h-2 w-2" />
              <span className="min-w-0 flex-1 truncate text-[13px]">
                <span className="font-medium">{row.repo}</span>
                <span className="text-muted-foreground"> · {row.branch ?? row.title}</span>
                {row.commit7 ? (
                  <span className="ml-1.5 font-mono text-[11.5px] text-muted-foreground">{row.commit7}</span>
                ) : null}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {row.live ? `running · ${row.duration}` : row.rel}
              </span>
            </ListRow>
          );
        })
      )}
    </ListCard>
  );
}

/* ── Repositories strip ───────────────────────────────────────── */

function RepoStrip({
  orgSlug,
  projects,
  links,
  services,
}: {
  orgSlug: string;
  projects: PublicProject[];
  links: WorkspaceLink[];
  services: CatalogService[];
}) {
  const linkByProject = React.useMemo(() => {
    const m = new Map<string, WorkspaceLink>();
    for (const l of links) m.set(l.projectId, l);
    return m;
  }, [links]);
  const entityCountByProject = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const s of services) {
      if (s.sourceProjectId) m.set(s.sourceProjectId, (m.get(s.sourceProjectId) ?? 0) + 1);
    }
    return m;
  }, [services]);

  const shown = projects.slice(0, TOP_REPOS);
  if (shown.length === 0) {
    return (
      <div className="rounded-xl border bg-card px-5 py-8 text-center text-[13px] text-muted-foreground">
        No repositories linked yet.
      </div>
    );
  }

  return (
    <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
      {shown.map((p) => {
        const link = linkByProject.get(p.id);
        const repo = link ? repoFullNameFromRemote(link.remoteUrl) : null;
        const entities = entityCountByProject.get(p.id) ?? 0;
        const active = p.status === "active";
        return (
          <Link key={p.id} href={`/orgs/${orgSlug}/projects/${p.slug}/environments`}>
            <InteractiveCard className="h-full px-[18px] py-4">
              <div className="truncate font-mono text-[13.5px] font-semibold">{p.name || p.slug}</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {repo ?? (entities > 0 ? `${entities} ${entities === 1 ? "entity" : "entities"}` : p.slug)}
              </div>
              <StatusText tone={active ? "success" : "neutral"} className="mt-3">
                {active ? "active" : p.status}
                {entities > 0 && repo ? ` · ${entities} ${entities === 1 ? "entity" : "entities"}` : ""}
              </StatusText>
            </InteractiveCard>
          </Link>
        );
      })}
    </div>
  );
}

/* ── First-run hint ───────────────────────────────────────────── */

function NoPlanHint() {
  return (
    <Card className="mt-3.5 flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground">
        <Terminal className="h-5 w-5" strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold">Run a plan to populate your Workspace</div>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          A repository is linked, but no catalog has been published yet. Run a plan to sync the
          catalog and light up the tiles above.
        </p>
      </div>
      <code className="shrink-0 rounded-md border bg-muted px-3 py-1.5 font-mono text-xs text-foreground">
        orun plan --push-catalog
      </code>
    </Card>
  );
}

/* ── Git-authored product narrative (WO5) ─────────────────────── */

function NarrativeBand({ orgId, facet, now }: { orgId: string; facet: RepoFacet; now: number }) {
  const { client } = useSession();
  const digest = docDigestOf(facet);
  const doc = useApiQuery(
    qk.docObject(orgId, facet.projectId, digest ?? ""),
    () => wrap(() => client.state.readCatalogDoc(orgId, digest!)),
    { enabled: !!digest },
  );

  // No overview doc: the description already renders in the lede, so nudge the
  // author to add one rather than showing an empty panel.
  if (!digest) {
    return (
      <Card className="px-6 py-5">
        <Kicker>Overview</Kicker>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Add a <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">docs/overview.md</code>{" "}
          and point <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">repo.docs.overview</code>{" "}
          at it to tell your team what this product is.
        </p>
      </Card>
    );
  }

  const repo = repoFromEntityRef(facet.entityRef);
  const sha = shortSha(facet.sourceCommit);
  const prov = [repo, sha ? `@${sha}` : null].filter(Boolean).join(" ");
  return (
    <Card className="px-6 py-5">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-xs font-semibold text-secondary-foreground">README</span>
        {(prov || facet.syncedAt) && (
          <span className="text-[11.5px] text-muted-foreground/85">
            {prov ? `from ${prov}` : ""}
            {facet.syncedAt ? ` · synced ${formatRelative(facet.syncedAt, now)}` : ""}
          </span>
        )}
      </div>
      <div className="mt-3">
        {doc.loading && !doc.data ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ) : doc.error ? (
          <p className="text-[13px] text-muted-foreground">Could not load the overview document.</p>
        ) : (
          <Markdown>{doc.data ?? ""}</Markdown>
        )}
      </div>
    </Card>
  );
}

/** The primary repo's doc set (saas-catalog-docs CD5), deep-linking into the
 *  doc reader. Hidden when only the overview exists — the card earns its place
 *  with content. */
function PrimaryDocsCard({
  orgId,
  orgSlug,
  facet,
}: {
  orgId: string;
  orgSlug: string;
  facet: RepoFacet;
}) {
  const { docs } = useEntityDocs(orgId, facet.entityRef);
  if (docs.length <= 1) return null;
  const entityKey = encodeEntityKey({
    sourceProjectId: facet.projectId,
    sourceEnvironment: null,
    entityRef: facet.entityRef!,
  });
  const shown = docs.slice(0, 5);
  return (
    <div className="rounded-xl border bg-card px-5 py-[18px]">
      <Kicker>Docs</Kicker>
      <div className="mt-2.5 flex flex-col gap-0.5">
        {shown.map((d) => (
          <Link
            key={d.docKey}
            href={`/orgs/${orgSlug}/docs/${entityKey}/${encodeURIComponent(d.docKey)}`}
            className="-mx-2 flex items-center gap-2 rounded-[7px] px-2 py-[7px] text-[12.5px] text-secondary-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PathIcon
              d={d.docKey === "overview" ? DOC_ICON.file : docRoleIcon(d.role)}
              size={14}
              strokeWidth={1.7}
              className="shrink-0 text-muted-foreground/80"
            />
            <span className="min-w-0 flex-1 truncate">{d.title}</span>
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">
              {d.docKey === "overview" ? "front page" : d.role}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ── Loading ──────────────────────────────────────────────────── */

function OverviewSkeleton() {
  return (
    <Screen aria-hidden>
      <Skeleton className="h-3.5 w-28" />
      <Skeleton className="mt-3 h-9 w-72 max-w-full" />
      <Skeleton className="mt-4 h-5 w-[36rem] max-w-full" />
      <div className="mt-10 grid gap-3.5 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-xl" />
        ))}
      </div>
      <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    </Screen>
  );
}
