"use client";

import * as React from "react";

import { useParams } from "next/navigation";
import { GitBranch, Github, Terminal } from "lucide-react";
import type { WorkspaceLink } from "@saas/sdk";
import type { PublicRepoLink } from "@saas/contracts/integrations";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Kicker, ListCard, ListCardHeader, Pill } from "@/components/ui/northwind";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

const CONNECT_SNIPPET = "orun cloud link";

/** Best-effort owner/repo for a normalized github.com remote (host/owner/repo). */
function githubFullName(remoteUrl: string): string | null {
  const parts = remoteUrl.split("/");
  if (parts[0] !== "github.com" || parts.length < 3) return null;
  return `${parts[1]}/${parts[2]}`;
}

export default function ProjectCliPage() {
  const params = useParams<{ orgSlug: string; projectSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";
  return (
    <OrgScope slug={orgSlug}>
      {(org) => <Inner orgId={org.id} orgSlug={orgSlug} projectSlug={projectSlug} />}
    </OrgScope>
  );
}

function Inner({
  orgId,
  orgSlug,
  projectSlug,
}: {
  orgId: string;
  orgSlug: string;
  projectSlug: string;
}) {
  const { client } = useSession();
  const { toast } = useToast();

  const projectsList = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = React.useMemo(
    () => projectsList.data?.find((p) => p.slug === projectSlug) ?? null,
    [projectsList.data, projectSlug],
  );

  const links = useApiQuery(
    qk.workspaceLinks(orgId, project?.id ?? "pending"),
    () => wrap(async () => (await client.state.listLinks(orgId, project!.id)).links),
    { enabled: !!project },
  );

  // Repo links (integrations) for the same project — used to cross-link a
  // workspace link to an IG connection when one covers the same repo (design §2).
  const repoLinks = useApiQuery(
    qk.repoLinks(orgId, project?.id ?? "pending"),
    () => wrap(async () => (await client.integrations.listRepoLinks(orgId, project!.id)).repoLinks),
    { enabled: !!project },
  );
  const repoLinkByFullName = React.useMemo(() => {
    const map = new Map<string, PublicRepoLink>();
    for (const rl of repoLinks.data ?? []) map.set(rl.repoFullName.toLowerCase(), rl);
    return map;
  }, [repoLinks.data]);

  const [unlinkTarget, setUnlinkTarget] = React.useState<WorkspaceLink | null>(null);

  const unlink = async (link: WorkspaceLink) => {
    if (!project) return;
    const r = await wrap(() => client.state.unlink(orgId, project.id, link.id));
    if (!r.ok) {
      toast({ kind: "error", title: "Unlink failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Unlinked ${link.remoteUrl}` });
    links.reload();
  };

  const loading = projectsList.loading || (!!project && links.loading);

  return (
    <div className="space-y-5">
      <p className="max-w-[560px] text-[13px] leading-normal text-muted-foreground">
        Connect a local clone to this project with the Orun CLI. Once linked,{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">orun run --remote-state</code> needs no
        flags — it resolves the org and project from the git remote.
      </p>

      {/* Connect this workspace — dark doc-style snippet. */}
      <div className="rounded-xl border bg-card p-6">
        <Kicker>Connect this workspace</Kicker>
        <p className="mt-2 text-[13px] leading-normal text-muted-foreground">
          Run this from inside a clone of the repository you want to link. The CLI lists your orgs,
          creates or selects this project, and caches the link.
        </p>
        <div className="mt-4 flex items-center justify-between gap-3 overflow-x-auto rounded-[10px] bg-[#171717] p-4 font-mono text-[12.5px] leading-[1.7] text-[#D4D4D4]">
          <code className="whitespace-pre">
            <span className="text-[#8A8A8A]">$ </span>
            {CONNECT_SNIPPET}
          </code>
          <CopyButton value={CONNECT_SNIPPET} />
        </div>
        <p className="mt-2.5 text-xs text-muted-foreground">
          Not signed in to the CLI yet? Run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">orun auth login</code> first.
        </p>
      </div>

      {loading ? (
        <Card>
          <CardContent className="space-y-3 pt-6">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : (links.data ?? []).length === 0 ? (
        <EmptyState
          icon={Terminal}
          title="No linked workspaces"
          description="Run orun auth login in a clone of this repo to connect it."
        />
      ) : (
        <ListCard>
          <ListCardHeader title="Linked remotes" />
          {(links.data ?? []).map((link) => {
            const fullName = githubFullName(link.remoteUrl);
            const igLink = fullName ? repoLinkByFullName.get(fullName.toLowerCase()) : undefined;
            return (
              <div
                key={link.id}
                className="flex items-center justify-between gap-4 border-t border-border/50 px-5 py-3.5 first:border-t-0"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
                    <span className="truncate font-mono text-[13px]">{link.remoteUrl}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      Linked {new Date(link.createdAt).toLocaleDateString()}
                    </span>
                    {igLink ? (
                      <Pill tone="neutral" className="gap-1">
                        <Github className="h-3 w-3" strokeWidth={1.8} />
                        GitHub connection: {igLink.repoFullName}
                      </Pill>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {igLink ? (
                    <Button variant="ghost" size="sm" asChild>
                      <a href={`/orgs/${orgSlug}/projects/${projectSlug}/git`}>View in Git</a>
                    </Button>
                  ) : null}
                  <Button variant="outline" size="sm" onClick={() => setUnlinkTarget(link)}>
                    Unlink
                  </Button>
                </div>
              </div>
            );
          })}
        </ListCard>
      )}

      <ConfirmDialog
        open={unlinkTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUnlinkTarget(null);
        }}
        title="Unlink workspace?"
        description="The next remote-state CLI call from this clone fails with an actionable error until the workspace is re-linked. Runs and state already stored are untouched."
        resourceName={unlinkTarget?.remoteUrl}
        confirmLabel="Unlink"
        onConfirm={async () => {
          if (unlinkTarget) await unlink(unlinkTarget);
        }}
      />
    </div>
  );
}
