"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { z } from "zod";
import { Plus, Boxes, GitBranch } from "lucide-react";
import type { PublicEnvironment } from "@saas/contracts/projects";
import type { Run } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle, InteractiveCard } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill, QuietLink } from "@/components/ui/northwind";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ZodForm } from "@/components/ui/zod-form";
import { PreconditionInsight } from "@/components/precondition/insight";
import { ArchiveMenu } from "@/components/settings/archive-menu";
import { removeById } from "@/components/settings/archive";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { formatRelative } from "@/lib/runs-portal/model";

const schema = z.object({
  name: z.string().min(2).max(48),
  slug: z.string().regex(/^[a-z0-9-]*$/, "lowercase, digits, hyphens").max(32).optional(),
});

export default function EnvironmentsPage() {
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
  const qc = useQueryClient();
  const now = React.useMemo(() => Date.now(), []);

  // Shares the `projects` cache key with the projects list page, so navigating
  // project-list → environments resolves the project synchronously from cache.
  const projectsList = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = React.useMemo(
    () => projectsList.data?.find((p) => p.slug === projectSlug) ?? null,
    [projectsList.data, projectSlug],
  );

  const [showArchived, setShowArchived] = React.useState(false);
  // The active and include-archived views are distinct caches (different key)
  // so toggling never shows a stale set and archive's optimistic update is
  // scoped to the view it ran in.
  const envKey = [...qk.environments(orgId, project?.id ?? "pending"), showArchived ? "all" : "active"];
  const envs = useApiQuery(
    envKey,
    () =>
      wrap(async () =>
        (await client.environments.list(orgId, project!.id, showArchived ? { includeArchived: true } : {})).environments,
      ),
    { enabled: !!project },
  );

  // Repo links carry the branch → environment map (which branch deploys where).
  const repoLinks = useApiQuery(
    qk.repoLinks(orgId, project?.id ?? "pending"),
    () => wrap(async () => (await client.integrations.listRepoLinks(orgId, project!.id)).repoLinks),
    { enabled: !!project },
  );
  // Org runs, for each env's most-recent deploy line.
  const runs = useApiQuery(qk.orgRuns(orgId), () =>
    wrap(async () => (await client.state.listOrgRuns(orgId, { limit: 100 })).runs),
  );

  const [open, setOpen] = React.useState(false);
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);

  // The query cache is the source of truth; archive mutates it optimistically.
  const items = envs.data ?? [];

  // env slug → the branch that deploys to it (first match across links).
  const branchByEnv = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const rl of repoLinks.data ?? []) {
      for (const [branch, envSlug] of Object.entries(rl.branchEnvMap)) {
        if (!m.has(envSlug)) m.set(envSlug, branch);
      }
    }
    return m;
  }, [repoLinks.data]);

  // env slug → its most-recent run for this project.
  const latestRunByEnv = React.useMemo(() => {
    const m = new Map<string, Run>();
    if (!project) return m;
    for (const r of runs.data ?? []) {
      if (r.projectId !== project.id || !r.environment) continue;
      if (!m.has(r.environment)) m.set(r.environment, r);
    }
    return m;
  }, [runs.data, project]);

  const branchMap = React.useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const rl of repoLinks.data ?? []) {
      for (const pair of Object.entries(rl.branchEnvMap)) entries.push(pair as [string, string]);
    }
    return entries;
  }, [repoLinks.data]);

  const archive = async (env: PublicEnvironment) => {
    if (!project) return;
    const previous = qc.getQueryData<PublicEnvironment[]>(envKey);
    qc.setQueryData<PublicEnvironment[]>(envKey, (cur) => removeById(cur ?? [], env.id)); // optimistic
    const r = await wrap(() => client.environments.archive(orgId, project.id, env.id));
    if (!r.ok) {
      qc.setQueryData<PublicEnvironment[]>(envKey, previous); // rollback
      toast({ kind: "error", title: "Archive failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Archived ${env.name}` });
    envs.reload(); // reconcile (in the archived view the row returns, now archived)
  };

  if (projectsList.loading) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (!project) {
    return (
      <EmptyState
        title="Repo not found"
        description={`No repo matches “${projectSlug}”.`}
        primaryAction={{ label: "Back to repos", href: `/orgs/${orgSlug}/projects` }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13.5px] font-semibold">Environments</span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={showArchived ? "secondary" : "outline"}
            size="sm"
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1.5" />
                New environment
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create environment</DialogTitle>
                <DialogDescription>
                  Environments are isolated deployment targets within this project.
                </DialogDescription>
              </DialogHeader>
              <ZodForm
                schema={schema}
                defaultValues={{ name: "", slug: "" }}
                fields={[
                  { name: "name", label: "Name", placeholder: "Production" },
                  { name: "slug", label: "Slug", placeholder: "prod", hint: "Lowercased URL identifier." },
                ]}
                submitLabel="Create"
                cancel={{ label: "Cancel", onClick: () => setOpen(false) }}
                onSubmit={async (v) => {
                  const payload: { name: string; slug?: string } = { name: v.name };
                  if (v.slug) payload.slug = v.slug;
                  const r = await wrap(async () =>
                    (await client.environments.create(orgId, project.id, payload)).environment,
                  );
                  if (!r.ok) {
                    if (r.error.code === "precondition_failed") setPrecondition(r.error);
                    else toast({ kind: "error", title: "Create failed", description: r.error.message });
                    return;
                  }
                  toast({ kind: "success", title: "Environment created" });
                  setOpen(false);
                  envs.reload();
                }}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {precondition && (
        <PreconditionInsight
          error={precondition}
          resource="environment"
          onDismiss={() => setPrecondition(null)}
        />
      )}

      {envs.loading ? (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : envs.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{envs.error.code}</CardTitle>
            <CardDescription>{envs.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No environments"
          description="Create dev/stage/prod to begin deploying."
          primaryAction={{ label: "New environment", onClick: () => setOpen(true) }}
        />
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((e) => (
            <EnvCard
              key={e.id}
              env={e}
              orgSlug={orgSlug}
              projectSlug={projectSlug}
              deployBranch={branchByEnv.get(e.slug) ?? null}
              latestRun={latestRunByEnv.get(e.slug) ?? null}
              now={now}
              onArchive={() => archive(e)}
            />
          ))}
        </div>
      )}

      {/* Branch-map footer — how branches route to environments. */}
      {branchMap.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3.5 rounded-xl border bg-card px-6 py-[18px]">
          <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
          <span className="text-[12.5px] text-secondary-foreground">
            Branch map:{" "}
            {branchMap.map(([branch, envSlug], i) => (
              <React.Fragment key={`${branch}:${envSlug}`}>
                {i > 0 ? " · " : ""}
                <span className="font-mono text-[11.5px]">
                  {branch} → {envSlug}
                </span>
              </React.Fragment>
            ))}
          </span>
          <QuietLink href={`/orgs/${orgSlug}/projects/${projectSlug}/git`} className="ml-auto">
            Managed in Git →
          </QuietLink>
        </div>
      ) : null}
    </div>
  );
}

function EnvCard({
  env,
  orgSlug,
  projectSlug,
  deployBranch,
  latestRun,
  now,
  onArchive,
}: {
  env: PublicEnvironment;
  orgSlug: string;
  projectSlug: string;
  deployBranch: string | null;
  latestRun: Run | null;
  now: number;
  onArchive: () => void;
}) {
  const live = env.status === "active";
  const runHref = latestRun
    ? `/orgs/${orgSlug}/projects/${projectSlug}/runs/${latestRun.runId}`
    : null;
  const runLive = latestRun?.status === "running" || latestRun?.status === "pending";

  return (
    <div className="relative">
      {live ? (
        <div className="absolute right-3 top-3 z-10">
          <ArchiveMenu resourceLabel="environment" name={env.name} onConfirm={onArchive} />
        </div>
      ) : null}
      <Link
        href={`/orgs/${orgSlug}/projects/${projectSlug}/environments/${env.slug}`}
        className="group block"
      >
        <InteractiveCard className="h-full px-[22px] py-5">
          <div className="flex items-center gap-2.5 pr-8">
            <span className="truncate text-[13.5px] font-semibold">{env.name}</span>
            {live ? (
              <Pill tone="success" dot className="ml-auto">
                live
              </Pill>
            ) : (
              <Pill tone="neutral" className="ml-auto">
                {env.status === "archived" ? "archived" : "ephemeral"}
              </Pill>
            )}
          </div>
          <div className="mt-2 truncate font-mono text-[11.5px] text-muted-foreground/90">{env.slug}</div>
          <div className="mt-4 flex flex-col gap-2 text-[12px] text-muted-foreground">
            {deployBranch ? (
              <div className="flex justify-between gap-3">
                <span>Deploys from</span>
                <span className="truncate font-mono text-[11.5px] text-secondary-foreground">{deployBranch}</span>
              </div>
            ) : null}
            <div className="flex justify-between gap-3">
              <span>Last deploy</span>
              {latestRun && runHref ? (
                <span className="truncate text-secondary-foreground">
                  {runLive ? (
                    <span className="text-link">running now →</span>
                  ) : (
                    formatRelative(latestRun.createdAt, now)
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground">no runs yet</span>
              )}
            </div>
          </div>
        </InteractiveCard>
      </Link>
    </div>
  );
}
