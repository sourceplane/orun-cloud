"use client";

// Repo settings frame. Selecting a repo from "Git Repos" lands here: a
// detail page with a breadcrumb, a serif repo header carrying its default
// branch + GitHub-connection pills and a right-aligned entities/runs stat, and
// a horizontal underline tab bar (Environments · Git · CLI · Storage · Config),
// mirroring how a project's settings read in Vercel/Linear.
//
// Full-screen drill-ins under the repo (the run detail, reached from the org
// Activities feed) render without the tab chrome.

import * as React from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import type { RepoFacet, WorkspaceLink, Run } from "@saas/contracts/state";
import { cn } from "@/lib/cn";
import { OrgScope } from "@/components/shell/org-scope";
import { Screen, Breadcrumbs, Pill } from "@/components/ui/northwind";
import { buildRepoTabs, isRepoTabActive, isRepoDetailRoute } from "@/components/shell/repo-tabs";
import { repoFullNameFromRemote } from "@/components/integrations/repo-allowlist";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import { wrap } from "@/lib/api";

export default function RepoLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ orgSlug: string; projectSlug: string }>();
  const pathname = usePathname();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";

  // The run detail (and the bare `/runs` redirect) are full-screen drill-ins —
  // no repo tab chrome.
  if (isRepoDetailRoute(pathname)) return <>{children}</>;

  return (
    <OrgScope slug={orgSlug}>
      {(org) => (
        <Screen detail>
          <RepoHeader orgId={org.id} orgSlug={orgSlug} projectSlug={projectSlug} pathname={pathname} />
          <div className="mt-[22px]">{children}</div>
        </Screen>
      )}
    </OrgScope>
  );
}

function RepoHeader({
  orgId,
  orgSlug,
  projectSlug,
  pathname,
}: {
  orgId: string;
  orgSlug: string;
  projectSlug: string;
  pathname: string | null;
}) {
  const { client } = useSession();
  const now = React.useMemo(() => Date.now(), []);
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = projects.data?.find((p) => p.slug === projectSlug) ?? null;

  const facets = useApiQuery(qk.repoFacets(orgId), () =>
    wrap(async () => (await client.state.listRepoFacets(orgId)).repoFacets),
  );
  const links = useApiQuery(qk.orgLinks(orgId), () =>
    wrap(async () => (await client.state.listOrgLinks(orgId)).links),
  );
  const runs = useApiQuery(qk.orgRuns(orgId), () =>
    wrap(async () => (await client.state.listOrgRuns(orgId, { limit: 100 })).runs),
  );
  const catalog = useApiQuery(qk.orgCatalog(orgId), () =>
    wrap(() => collectOrgCatalog((query) => client.state.listOrgCatalogEntities(orgId, query))),
  );

  const facet: RepoFacet | null =
    facets.data?.find((f) => f.projectId === project?.id) ?? null;
  const link: WorkspaceLink | null =
    links.data?.find((l) => l.projectId === project?.id) ?? null;

  const fullName =
    facet?.displayName ||
    (link ? repoFullNameFromRemote(link.remoteUrl) : null) ||
    project?.name ||
    projectSlug;
  const branch = facet?.defaultBranch || "main";
  const connected = !!link;

  const entities = (catalog.data ?? []).filter((e) => e.sourceProjectId === project?.id).length;
  const runs7d = (runs.data ?? []).filter(
    (r: Run) => r.projectId === project?.id && (new Date(r.createdAt).getTime() || 0) >= weekAgo,
  ).length;

  const tabs = buildRepoTabs(orgSlug, projectSlug);

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Git Repos", href: `/orgs/${orgSlug}/projects` },
          { label: fullName, mono: true },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3.5">
        <h1 className="font-serif text-[28px] font-medium leading-tight tracking-[-0.01em]">
          {project?.name || projectSlug}
        </h1>
        <Pill tone="neutral">{branch}</Pill>
        {connected ? (
          <Pill tone="success" dot>
            GitHub connected
          </Pill>
        ) : null}
        <span className="ml-auto text-[12px] text-muted-foreground">
          {entities} {entities === 1 ? "entity" : "entities"} · {runs7d} runs this week
        </span>
      </div>

      {/* Underline tab bar (route-based). Scrolls on narrow screens. */}
      <nav
        className="-mx-5 mt-[26px] flex gap-0.5 overflow-x-auto border-b border-border px-5 scrollbar-none sm:mx-0 sm:px-0"
        aria-label="Repo settings"
      >
        {tabs.map((tab) => {
          const active = isRepoTabActive(tab.href, pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px shrink-0 border-b-2 px-3.5 py-2.5 text-[13px] transition-colors",
                active
                  ? "border-link font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
