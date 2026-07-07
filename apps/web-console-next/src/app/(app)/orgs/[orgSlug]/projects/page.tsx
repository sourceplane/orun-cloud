"use client";

// Git Repos — a two-tab surface:
//   • Repositories — the repo list (each repo is a project). "Link repository"
//     picks from the connected GitHub integration; onboarding a repo creates the
//     project placeholder AND its allow-list entry (a workspace link).
//   • Settings — the git-repo allow-list: which repos may push state objects
//     from OIDC CI. Add via the same dropdown; remove revokes CI's push access.

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Plus, Folder, Github, ShieldCheck } from "lucide-react";
import type { PublicProject } from "@saas/contracts/projects";
import type { PublicConnection, PublicRepository } from "@saas/contracts/integrations";
import type { WorkspaceLink, RepoFacet } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, InteractiveCard } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Pill, Screen, PageHeader, StatusText, type Tone } from "@/components/ui/northwind";
import { PreconditionInsight } from "@/components/precondition/insight";
import { ArchiveMenu } from "@/components/settings/archive-menu";
import { removeById } from "@/components/settings/archive";
import { RepoPickerDialog } from "@/components/integrations/repo-picker-dialog";
import {
  githubRemoteForFullName,
  ownerOf,
  repoNameOf,
  repoFullNameFromRemote,
} from "@/components/integrations/repo-allowlist";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/session";
import { useApiQuery, qk, usePrefetch } from "@/lib/query";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import { formatRelative } from "@/lib/runs-portal/model";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";

const ENV_TONE: Record<string, "success" | "info" | "neutral"> = {
  production: "success",
  prod: "success",
  live: "success",
  staging: "info",
  stage: "info",
};

/** Tint an environment chip by its slug — production green, staging blue, else neutral. */
function envChipTone(slug: string): "success" | "info" | "neutral" {
  return ENV_TONE[slug.toLowerCase()] ?? "neutral";
}

const ENV_CHIP_CLASS: Record<"success" | "info" | "neutral", string> = {
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  neutral: "bg-secondary text-muted-foreground",
};

export default function ProjectsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={org.slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const qc = useQueryClient();
  const prefetch = usePrefetch();

  const projectsKey = qk.projects(orgId);
  const projects = useApiQuery(projectsKey, () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const connections = useApiQuery(qk.integrations(orgId), () =>
    wrap(async () => (await client.integrations.list(orgId)).connections),
  );
  const links = useApiQuery(qk.orgLinks(orgId), () =>
    wrap(async () => (await client.state.listOrgLinks(orgId)).links),
  );
  const repoFacets = useApiQuery(qk.repoFacets(orgId), () =>
    wrap(async () => (await client.state.listRepoFacets(orgId)).repoFacets),
  );
  // Rollups for the repo cards: recent org runs (last-deploy + runs·7d) and the
  // catalog (entity counts per repo). Both are cheap, cached, and shared with
  // the Overview screen — the cards degrade gracefully while they load.
  const runs = useApiQuery(qk.orgRuns(orgId), () =>
    wrap(async () => (await client.state.listOrgRuns(orgId, { limit: 100 })).runs),
  );
  const catalog = useApiQuery(qk.orgCatalog(orgId), () =>
    wrap(() => collectOrgCatalog((query) => client.state.listOrgCatalogEntities(orgId, query))),
  );

  const activeConnection: PublicConnection | null =
    connections.data?.find((c) => c.status === "active") ?? null;

  const [tab, setTab] = React.useState<"repositories" | "settings">("repositories");
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [gateError, setGateError] = React.useState<ApiErrorBody | null>(null);

  const items = projects.data ?? [];
  const allowList = links.data ?? [];
  // projectId → its allow-list link, for annotating the repo list.
  const linkByProject = React.useMemo(() => {
    const m = new Map<string, WorkspaceLink>();
    for (const l of allowList) m.set(l.projectId, l);
    return m;
  }, [allowList]);
  // projectId → its repo facet (git-authored description + default branch, WO5).
  const facetByProject = React.useMemo(() => {
    const m = new Map<string, RepoFacet>();
    for (const f of repoFacets.data ?? []) m.set(f.projectId, f);
    return m;
  }, [repoFacets.data]);
  // projectId → count of catalog entities projected from it.
  const entityCountByProject = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const e of catalog.data ?? []) {
      m.set(e.sourceProjectId, (m.get(e.sourceProjectId) ?? 0) + 1);
    }
    return m;
  }, [catalog.data]);
  // provider repo ids already onboarded — disabled in the picker.
  const onboardedRepoIds = React.useMemo(
    () => new Set(allowList.map((l) => l.providerRepoId).filter((x): x is string => !!x)),
    [allowList],
  );

  const reloadAll = () => {
    projects.reload();
    links.reload();
  };

  const onboard = async (repo: PublicRepository) => {
    setGateError(null);
    const r = await wrap(() =>
      client.state.createLink(orgId, {
        remoteUrl: githubRemoteForFullName(repo.fullName),
        projectSlug: repoNameOf(repo.fullName),
        provider: "github",
        providerRepoId: repo.externalId,
        providerOwnerLogin: ownerOf(repo.fullName),
      }),
    );
    if (!r.ok) {
      if (r.status === 412) setGateError(r.error);
      else toast({ kind: "error", title: "Could not add repo", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Added ${repo.fullName}` });
    reloadAll();
  };

  const archive = async (project: PublicProject) => {
    const previous = qc.getQueryData<PublicProject[]>(projectsKey);
    qc.setQueryData<PublicProject[]>(projectsKey, (cur) => removeById(cur ?? [], project.id));
    const r = await wrap(() => client.projects.archive(orgId, project.id));
    if (!r.ok) {
      qc.setQueryData<PublicProject[]>(projectsKey, previous);
      toast({ kind: "error", title: "Archive failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Archived ${project.name}` });
  };

  // "Link repository": opens the integration dropdown when a connection exists;
  // else routes to Integrations to connect one first.
  const linkRepoControl = connections.loading ? (
    <Button disabled>
      <Plus className="mr-1.5 h-4 w-4" />
      Link repository
    </Button>
  ) : activeConnection ? (
    <Button onClick={() => setPickerOpen(true)}>
      <Plus className="mr-1.5 h-4 w-4" />
      Link repository
    </Button>
  ) : (
    <Button asChild>
      <Link href={`/orgs/${orgSlug}/integrations`}>
        <Github className="mr-1.5 h-4 w-4" />
        Connect GitHub
      </Link>
    </Button>
  );

  return (
    <Screen>
      <PageHeader
        title="Git Repos"
        description="The repositories this workspace orchestrates. Everything downstream — catalog, docs, runs — derives from what these ship."
        actions={linkRepoControl}
      />

      {gateError ? (
        <div className="mt-6">
          <PreconditionInsight error={gateError} resource="project" onDismiss={() => setGateError(null)} />
        </div>
      ) : null}

      {/* Underline tabs (Repositories / Settings). */}
      <div className="mt-7 flex gap-0.5 border-b border-border">
        <TabButton active={tab === "repositories"} onClick={() => setTab("repositories")}>
          Repositories
        </TabButton>
        <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
          Settings
        </TabButton>
      </div>

      {tab === "repositories" ? (
        <div className="mt-[22px]">
          <RepositoriesTab
            loading={projects.loading}
            error={projects.error}
            items={items}
            orgId={orgId}
            orgSlug={orgSlug}
            linkByProject={linkByProject}
            facetByProject={facetByProject}
            entityCountByProject={entityCountByProject}
            runs={runs.data ?? []}
            prefetch={prefetch}
            client={client}
            onArchive={archive}
            addControl={linkRepoControl}
            hasConnection={!!activeConnection}
          />
        </div>
      ) : (
        <div className="mt-[22px]">
          <AllowListTab
            loading={links.loading}
            error={links.error}
            links={allowList}
            orgSlug={orgSlug}
            onRemoved={reloadAll}
            client={client}
            orgId={orgId}
            add={linkRepoControl}
          />
        </div>
      )}

      {activeConnection ? (
        <RepoPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          orgId={orgId}
          connection={activeConnection}
          linkedExternalIds={onboardedRepoIds}
          onPick={async (repo) => {
            await onboard(repo);
            setPickerOpen(false);
          }}
          title="Add a repository"
          pickLabel="Add"
          pickingLabel="Adding…"
          pickedLabel="Added"
        />
      ) : null}
    </Screen>
  );
}

/** Underline tab button matching the design's repo-tab bar. */
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "-mb-px border-b-2 px-3.5 py-2.5 text-[13px] transition-colors",
        active
          ? "border-link font-semibold text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ── Repositories tab — the repo card list ───────────────────

function RepositoriesTab({
  loading,
  error,
  items,
  orgId,
  orgSlug,
  linkByProject,
  facetByProject,
  entityCountByProject,
  runs,
  prefetch,
  client,
  onArchive,
  addControl,
  hasConnection,
}: {
  loading: boolean;
  error: { code: string; message: string } | null;
  items: PublicProject[];
  orgId: string;
  orgSlug: string;
  linkByProject: Map<string, WorkspaceLink>;
  facetByProject: Map<string, RepoFacet>;
  entityCountByProject: Map<string, number>;
  runs: import("@saas/contracts/state").Run[];
  prefetch: ReturnType<typeof usePrefetch>;
  client: ReturnType<typeof useSession>["client"];
  onArchive: (p: PublicProject) => void;
  addControl: React.ReactNode;
  hasConnection: boolean;
}) {
  const now = React.useMemo(() => Date.now(), []);
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  // projectId → its recent runs (already newest-first from the feed).
  const runsByProject = React.useMemo(() => {
    const m = new Map<string, import("@saas/contracts/state").Run[]>();
    for (const r of runs) {
      const arr = m.get(r.projectId);
      if (arr) arr.push(r);
      else m.set(r.projectId, [r]);
    }
    return m;
  }, [runs]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">{error.code}</CardTitle>
          <CardDescription>{error.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Folder}
        title="No repos yet"
        description={
          hasConnection
            ? "Link a repository from your GitHub integration to onboard it."
            : "Connect GitHub to onboard repositories, or use the CLI to link an existing checkout."
        }
        {...(hasConnection
          ? {}
          : { secondaryAction: { label: "Connect GitHub", href: `/orgs/${orgSlug}/integrations` } })}
      />
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {items.map((p) => {
          const link = linkByProject.get(p.id);
          const facet = facetByProject.get(p.id);
          const repoName = facet?.displayName || (link ? repoFullNameFromRemote(link.remoteUrl) : null) || p.name;
          const branch = facet?.defaultBranch || "main";
          const entities = entityCountByProject.get(p.id) ?? 0;
          const projectRuns = runsByProject.get(p.id) ?? [];
          const runs7d = projectRuns.filter((r) => (new Date(r.createdAt).getTime() || 0) >= weekAgo).length;
          const latest = projectRuns[0] ?? null;
          const deploy = latest ? deployStatus(latest, now) : null;

          return (
            <Link
              key={p.id}
              href={`/orgs/${orgSlug}/projects/${p.slug}/environments`}
              className="group block"
              onMouseEnter={() =>
                prefetch(qk.environments(orgId, p.id), () =>
                  wrap(async () => (await client.environments.list(orgId, p.id)).environments),
                )
              }
            >
              <InteractiveCard className="px-6 py-5">
                <div className="flex items-center gap-3">
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
                  <span className="truncate font-mono text-[14px] font-semibold">{repoName}</span>
                  <Pill tone="neutral">{branch}</Pill>
                  {deploy ? (
                    <StatusText tone={deploy.tone} live={deploy.live} className="ml-auto shrink-0 text-[12px]">
                      {deploy.text}
                    </StatusText>
                  ) : null}
                  <span className={deploy ? "ml-1.5 shrink-0" : "ml-auto shrink-0"}>
                    <ArchiveMenu resourceLabel="repo" name={p.name} onConfirm={() => onArchive(p)} />
                  </span>
                </div>
                <div className="mt-3.5 flex flex-wrap items-center gap-x-[26px] gap-y-2 text-[12.5px] text-muted-foreground">
                  {entities > 0 ? (
                    <span>
                      <span className="font-semibold text-foreground">{entities}</span> catalog{" "}
                      {entities === 1 ? "entity" : "entities"}
                    </span>
                  ) : null}
                  {runs7d > 0 ? (
                    <span>
                      <span className="font-semibold text-foreground">{runs7d}</span> runs · 7d
                    </span>
                  ) : null}
                  <RepoEnvChips orgId={orgId} projectId={p.id} client={client} />
                </div>
              </InteractiveCard>
            </Link>
          );
        })}
      </div>
      <div className="mt-4">{addControl}</div>
    </>
  );
}

/** Env-name chips for a repo card — production/staging tinted, rest neutral. */
function RepoEnvChips({
  orgId,
  projectId,
  client,
}: {
  orgId: string;
  projectId: string;
  client: ReturnType<typeof useSession>["client"];
}) {
  const envs = useApiQuery(qk.environments(orgId, projectId), () =>
    wrap(async () => (await client.environments.list(orgId, projectId)).environments),
  );
  const active = (envs.data ?? []).filter((e) => e.status === "active");
  if (active.length === 0) return null;
  return (
    <span className="ml-auto flex flex-wrap justify-end gap-1.5">
      {active.map((e) => {
        const tone = envChipTone(e.slug);
        return (
          <span
            key={e.id}
            className={cn("rounded-md px-2 py-0.5 text-[11px]", ENV_CHIP_CLASS[tone])}
          >
            {e.slug}
          </span>
        );
      })}
    </span>
  );
}

/** Last-deploy status line from a repo's most recent run. */
function deployStatus(
  run: import("@saas/contracts/state").Run,
  now: number,
): { tone: Tone; live: boolean; text: string } {
  const branch = run.git.ref ? run.git.ref.replace(/^refs\/heads\//, "") : null;
  const rel = formatRelative(run.createdAt, now);
  if (run.status === "running" || run.status === "pending") {
    return { tone: "info", live: true, text: branch ? `${branch} deploying · ${rel}` : `deploying · ${rel}` };
  }
  if (run.status === "failed") {
    return { tone: "error", live: false, text: branch ? `${branch} red · ${rel}` : `last deploy red · ${rel}` };
  }
  if (run.status === "succeeded") {
    return { tone: "success", live: false, text: `last deploy green · ${rel}` };
  }
  return { tone: "neutral", live: false, text: `${run.status} · ${rel}` };
}

// ── Settings tab — the git-repo allow-list ──────────────────

function AllowListTab({
  loading,
  error,
  links,
  orgSlug,
  onRemoved,
  client,
  orgId,
  add,
}: {
  loading: boolean;
  error: { code: string; message: string } | null;
  links: WorkspaceLink[];
  orgSlug: string;
  onRemoved: () => void;
  client: ReturnType<typeof useSession>["client"];
  orgId: string;
  add: React.ReactNode;
}) {
  const { toast } = useToast();
  const [removeTarget, setRemoveTarget] = React.useState<WorkspaceLink | null>(null);

  const remove = async (link: WorkspaceLink) => {
    const r = await wrap(() => client.state.unlink(orgId, link.projectId, link.id));
    if (!r.ok) {
      toast({ kind: "error", title: "Remove failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Removed from the allow-list" });
    onRemoved();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-xl border bg-muted/30 p-4 text-[13px] text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-foreground" strokeWidth={1.8} />
        <p>
          The git-repo allow-list. Only repos listed here may push state objects from OIDC CI — a
          push from a repo that isn&apos;t allow-listed is rejected. Adding a repo onboards it and
          adds it here; removing it revokes CI&apos;s push access.
        </p>
      </div>

      {loading ? (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {Array.from({ length: 3 }).map((_, i) => (
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
      ) : links.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Allow-list is empty"
          description="No repos are allow-listed yet. Add a repo to let its CI push state objects."
        />
      ) : (
        <Card className="hidden overflow-hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repository</TableHead>
                <TableHead>Repo (project)</TableHead>
                <TableHead>OIDC CI</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-[13.5px]">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Github className="h-3.5 w-3.5" strokeWidth={1.8} />
                      {repoFullNameFromRemote(l.remoteUrl)}
                    </span>
                  </TableCell>
                  <TableCell className="text-[13.5px]">
                    {l.projectSlug ? (
                      <Link href={`/orgs/${orgSlug}/projects/${l.projectSlug}/git`} className="hover:underline">
                        {l.projectSlug}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Pill tone={l.ciSettings?.oidcEnabled === false ? "neutral" : "success"}>
                      {l.ciSettings?.oidcEnabled === false ? "disabled" : "enabled"}
                    </Pill>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(l.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => setRemoveTarget(l)}>
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Mobile: stacked cards */}
      {!loading && !error && links.length > 0 ? (
        <div className="space-y-3 md:hidden">
          {links.map((l) => (
            <Card key={l.id} className="space-y-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[13.5px] font-medium">
                  <Github className="h-3.5 w-3.5" strokeWidth={1.8} />
                  {repoFullNameFromRemote(l.remoteUrl)}
                </span>
                <Button variant="outline" size="sm" onClick={() => setRemoveTarget(l)}>
                  Remove
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                {l.projectSlug ? `repo ${l.projectSlug} · ` : ""}OIDC {l.ciSettings?.oidcEnabled === false ? "disabled" : "enabled"}
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      <div>{add}</div>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title="Remove from the allow-list?"
        description="The repo's OIDC CI can no longer push state objects. The repo (project) and its history are kept; re-add it to restore push access."
        resourceName={removeTarget ? repoFullNameFromRemote(removeTarget.remoteUrl) : undefined}
        confirmLabel="Remove"
        onConfirm={async () => {
          if (removeTarget) await remove(removeTarget);
        }}
      />
    </div>
  );
}
