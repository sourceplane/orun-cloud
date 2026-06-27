"use client";

// Git Repos — a two-tab surface:
//   • Repositories — the repo list (each repo is a project). "Add repo" picks
//     from the connected GitHub integration; onboarding a repo creates the
//     project placeholder AND its allow-list entry (a workspace link).
//   • Settings — the git-repo allow-list: which repos may push state objects
//     from OIDC CI. Add via the same dropdown; remove revokes CI's push access.

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Plus, FolderKanban, Github, ShieldCheck, ChevronRight } from "lucide-react";
import type { PublicProject } from "@saas/contracts/projects";
import type { PublicConnection, PublicRepository } from "@saas/contracts/integrations";
import type { WorkspaceLink } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";

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

  const activeConnection: PublicConnection | null =
    connections.data?.find((c) => c.status === "active") ?? null;

  const [tab, setTab] = React.useState("repositories");
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

  // "Add repo": opens the integration dropdown when a connection exists; else
  // routes to Integrations to connect one first.
  const addRepoControl = connections.loading ? (
    <Button disabled>
      <Plus className="mr-1.5 h-4 w-4" />
      Add repo
    </Button>
  ) : activeConnection ? (
    <Button onClick={() => setPickerOpen(true)}>
      <Plus className="mr-1.5 h-4 w-4" />
      Add repo
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
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Git Repos</h1>
          <p className="text-sm text-muted-foreground">
            Each repo is a project. Add one from your GitHub integration to onboard it and allow CI to push.
          </p>
        </div>
        {addRepoControl}
      </header>

      {gateError ? (
        <PreconditionInsight error={gateError} resource="project" onDismiss={() => setGateError(null)} />
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="repositories">Repositories</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="repositories" className="mt-5">
          <RepositoriesTab
            loading={projects.loading}
            error={projects.error}
            items={items}
            orgId={orgId}
            orgSlug={orgSlug}
            linkByProject={linkByProject}
            prefetch={prefetch}
            client={client}
            onArchive={archive}
            addControl={addRepoControl}
            hasConnection={!!activeConnection}
          />
        </TabsContent>

        <TabsContent value="settings" className="mt-5">
          <AllowListTab
            loading={links.loading}
            error={links.error}
            links={allowList}
            orgSlug={orgSlug}
            onRemoved={reloadAll}
            client={client}
            orgId={orgId}
            add={addRepoControl}
          />
        </TabsContent>
      </Tabs>

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
    </div>
  );
}

// ── Repositories tab — the proper repo list ─────────────────

function RepositoriesTab({
  loading,
  error,
  items,
  orgId,
  orgSlug,
  linkByProject,
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
  prefetch: ReturnType<typeof usePrefetch>;
  client: ReturnType<typeof useSession>["client"];
  onArchive: (p: PublicProject) => void;
  addControl: React.ReactNode;
  hasConnection: boolean;
}) {
  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
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
        icon={FolderKanban}
        title="No repos yet"
        description={
          hasConnection
            ? "Add a repository from your GitHub integration to onboard it."
            : "Connect GitHub to onboard repositories, or use the CLI to link an existing checkout."
        }
        {...(hasConnection
          ? {}
          : { secondaryAction: { label: "Connect GitHub", href: `/orgs/${orgSlug}/integrations` } })}
      />
    );
  }

  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border">
        {items.map((p) => {
          const link = linkByProject.get(p.id);
          const repoName = link ? repoFullNameFromRemote(link.remoteUrl) : null;
          return (
            <li key={p.id} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40">
              <Link
                href={`/orgs/${orgSlug}/projects/${p.slug}/environments`}
                className="group flex min-w-0 flex-1 items-center gap-3"
                onMouseEnter={() =>
                  prefetch(qk.environments(orgId, p.id), () =>
                    wrap(async () => (await client.environments.list(orgId, p.id)).environments),
                  )
                }
              >
                <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    <Badge variant={p.status === "active" ? "success" : "secondary"}>{p.status}</Badge>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{p.slug}</span>
                    {repoName ? (
                      <span className="inline-flex items-center gap-1 truncate">
                        <Github className="h-3 w-3" />
                        {repoName}
                      </span>
                    ) : null}
                  </div>
                </div>
              </Link>
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {new Date(p.updatedAt).toLocaleDateString()}
              </span>
              <ArchiveMenu resourceLabel="repo" name={p.name} onConfirm={() => onArchive(p)} />
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
            </li>
          );
        })}
      </ul>
      <div className="border-t bg-muted/20 px-4 py-3">{addControl}</div>
    </Card>
  );
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
      <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
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
        <Card className="hidden md:block">
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
                  <TableCell className="text-sm">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Github className="h-3.5 w-3.5" />
                      {repoFullNameFromRemote(l.remoteUrl)}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {l.projectSlug ? (
                      <Link href={`/orgs/${orgSlug}/projects/${l.projectSlug}/git`} className="hover:underline">
                        {l.projectSlug}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={l.ciSettings?.oidcEnabled === false ? "secondary" : "success"}>
                      {l.ciSettings?.oidcEnabled === false ? "disabled" : "enabled"}
                    </Badge>
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
                <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                  <Github className="h-3.5 w-3.5" />
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
