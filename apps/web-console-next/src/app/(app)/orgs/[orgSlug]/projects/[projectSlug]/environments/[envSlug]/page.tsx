"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Kicker, Pill } from "@/components/ui/northwind";
import { ConfigSurface } from "@/components/config/config-surface";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

export default function EnvironmentDetail() {
  const params = useParams<{ orgSlug: string; projectSlug: string; envSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";
  const envSlug = params?.envSlug ?? "";
  return (
    <OrgScope slug={orgSlug}>
      {(org) => <Inner orgId={org.id} projectSlug={projectSlug} envSlug={envSlug} />}
    </OrgScope>
  );
}

function Inner({
  orgId,
  projectSlug,
  envSlug,
}: {
  orgId: string;
  projectSlug: string;
  envSlug: string;
}) {
  const { client } = useSession();
  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = projects.data?.find((p) => p.slug === projectSlug) ?? null;
  const envs = useApiQuery(
    qk.environments(orgId, project?.id ?? "pending"),
    () => wrap(async () => (await client.environments.list(orgId, project!.id)).environments),
    { enabled: !!project },
  );
  const env = envs.data?.find((e) => e.slug === envSlug) ?? null;

  if (projects.loading || envs.loading) return <Skeleton className="h-32 w-full" />;
  if (!project || !env) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Environment not found</CardTitle>
          <CardDescription>
            No environment matches {projectSlug}/{envSlug}.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h2 className="font-serif text-[20px] font-medium tracking-[-0.01em]">{env.name}</h2>
        <Pill tone={env.status === "active" ? "success" : "neutral"} dot={env.status === "active"}>
          {env.status}
        </Pill>
      </div>
      <div className="rounded-xl border bg-card px-6 py-5">
        <Kicker>Identity</Kicker>
        <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <Pair k="Repo" v={project.name} />
            <Pair k="Repo slug" v={project.slug} />
            <Pair k="Environment" v={env.name} />
            <Pair k="Environment slug" v={env.slug} />
            <Pair k="Environment ID" v={env.id} mono />
            <Pair k="Repo ID" v={env.projectId} mono />
          <Pair k="Created" v={new Date(env.createdAt).toLocaleString()} />
          <Pair k="Updated" v={new Date(env.updatedAt).toLocaleString()} />
        </dl>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Configuration</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Settings, feature flags, and secrets scoped to this environment.
          </p>
        </div>
        <ConfigSurface
          scope={{ kind: "environment", orgId, projectId: project.id, environmentId: env.id }}
        />
      </section>
    </div>
  );
}

function Pair({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase text-muted-foreground">{k}</div>
      <div className={mono ? "font-mono text-xs break-all" : "font-medium"}>{v}</div>
    </div>
  );
}
