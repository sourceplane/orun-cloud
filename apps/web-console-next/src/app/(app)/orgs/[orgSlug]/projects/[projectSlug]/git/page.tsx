"use client";

import * as React from "react";

import { useParams } from "next/navigation";
import { GitBranch, Github, Plus } from "lucide-react";
import type {
  PublicConnection,
  PublicRepoLink,
  PublicRepository,
} from "@saas/contracts/integrations";
import type { PublicEnvironment } from "@saas/contracts/projects";
import { OrgScope } from "@/components/shell/org-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { suggestBranchEnvMap } from "@/components/integrations/branch-map";
import { RepoPickerDialog } from "@/components/integrations/repo-picker-dialog";

export default function ProjectGitPage() {
  const params = useParams<{ orgSlug: string; projectSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";
  return (
    <OrgScope slug={orgSlug}>
      {(org) => <Inner orgId={org.id} orgSlug={orgSlug} projectSlug={projectSlug} />}
    </OrgScope>
  );
}

function Inner({ orgId, orgSlug, projectSlug }: { orgId: string; orgSlug: string; projectSlug: string }) {
  const { client } = useSession();
  const { toast } = useToast();

  const projectsList = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = React.useMemo(
    () => projectsList.data?.find((p) => p.slug === projectSlug) ?? null,
    [projectsList.data, projectSlug],
  );

  const connections = useApiQuery(qk.integrations(orgId), () =>
    wrap(async () => (await client.integrations.list(orgId)).connections),
  );
  const activeConnection: PublicConnection | null =
    connections.data?.find((c) => c.status === "active") ?? null;

  const linksKey = qk.repoLinks(orgId, project?.id ?? "pending");
  const links = useApiQuery(
    linksKey,
    () => wrap(async () => (await client.integrations.listRepoLinks(orgId, project!.id)).repoLinks),
    { enabled: !!project },
  );
  const environments = useApiQuery(
    qk.environments(orgId, project?.id ?? "pending"),
    () => wrap(async () => (await client.environments.list(orgId, project!.id)).environments),
    { enabled: !!project },
  );

  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [gateError, setGateError] = React.useState<ApiErrorBody | null>(null);
  const [unlinkTarget, setUnlinkTarget] = React.useState<PublicRepoLink | null>(null);

  const linkRepo = async (repo: PublicRepository) => {
    if (!project || !activeConnection) return;
    setGateError(null);
    const branchEnvMap = suggestBranchEnvMap(
      repo.defaultBranch,
      (environments.data ?? []) as PublicEnvironment[],
    );
    const r = await wrap(() =>
      client.integrations.createRepoLink(orgId, project.id, {
        connectionId: activeConnection.id,
        repoExternalId: repo.externalId,
        repoFullName: repo.fullName,
        ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}),
        branchEnvMap,
      }),
    );
    if (!r.ok) {
      if (r.status === 412) {
        setGateError(r.error);
        setPickerOpen(false);
      } else {
        toast({ kind: "error", title: "Could not link repository", description: r.error.message });
      }
      return;
    }
    setPickerOpen(false);
    toast({ kind: "success", title: `Linked ${repo.fullName}` });
    links.reload();
  };

  const unlink = async (link: PublicRepoLink) => {
    if (!project) return;
    const r = await wrap(() => client.integrations.unlinkRepoLink(orgId, project.id, link.id));
    if (!r.ok) {
      toast({ kind: "error", title: "Unlink failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Unlinked ${link.repoFullName}` });
    links.reload();
  };

  const loading = projectsList.loading || connections.loading || (!!project && links.loading);

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight">Git</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Link repositories to this project and map branches to environments. Pushes and pull
            requests on linked repos emit project-scoped events.
          </p>
        </div>
        {activeConnection ? (
          <Button onClick={() => setPickerOpen(true)} disabled={!project}>
            <Plus className="mr-1.5 h-4 w-4" />
            Link repository
          </Button>
        ) : null}
      </header>

      {gateError ? (
        <PreconditionInsight
          error={gateError}
          resource="repository link"
          onDismiss={() => setGateError(null)}
        />
      ) : null}

      {loading ? (
        <Card>
          <CardContent className="space-y-3 pt-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : !activeConnection ? (
        <EmptyState
          icon={Github}
          title="No GitHub connection"
          description="Connect GitHub for this organization first — then link repositories to repos here."
          primaryAction={{
            label: "Open Integrations settings",
            href: `/orgs/${orgSlug}/settings/integrations`,
          }}
        />
      ) : (links.data ?? []).length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="No linked repositories"
          description="Link a repository to start receiving repo-scoped pushes and pull requests."
          primaryAction={{ label: "Link repository", onClick: () => setPickerOpen(true) }}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Linked repositories</CardTitle>
            <CardDescription>
              Branch → environment mappings resolve which environment an event belongs to.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {(links.data ?? []).map((link) => (
                <li key={link.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Github className="h-4 w-4 text-muted-foreground" />
                      <span className="truncate text-sm font-medium">{link.repoFullName}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {Object.entries(link.branchEnvMap).length === 0 ? (
                        <span className="text-xs text-muted-foreground">No branch mappings</span>
                      ) : (
                        Object.entries(link.branchEnvMap).map(([branch, envSlug]) => (
                          <Badge key={branch} variant="secondary" className="font-mono text-[11px]">
                            {branch} → {envSlug}
                          </Badge>
                        ))
                      )}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setUnlinkTarget(link)}>
                    Unlink
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {activeConnection && project ? (
        <RepoPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          orgId={orgId}
          connection={activeConnection}
          linkedExternalIds={new Set((links.data ?? []).map((l) => l.repoExternalId))}
          onPick={linkRepo}
        />
      ) : null}

      <ConfirmDialog
        open={unlinkTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUnlinkTarget(null);
        }}
        title="Unlink repository?"
        description="Repo-scoped events for this repository stop immediately. The repository itself is untouched on GitHub."
        resourceName={unlinkTarget?.repoFullName}
        confirmLabel="Unlink"
        onConfirm={async () => {
          if (unlinkTarget) await unlink(unlinkTarget);
        }}
      />
    </div>
  );
}
