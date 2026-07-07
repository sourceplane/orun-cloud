"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfigSurface } from "@/components/config/config-surface";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

export default function ProjectConfigPage() {
  const params = useParams<{ orgSlug: string; projectSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";
  return (
    <OrgScope slug={orgSlug}>
      {(org) => <Inner orgId={org.id} orgSlug={org.slug} projectSlug={projectSlug} />}
    </OrgScope>
  );
}

function Inner({ orgId, orgSlug, projectSlug }: { orgId: string; orgSlug: string; projectSlug: string }) {
  const { client } = useSession();
  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = projects.data?.find((p) => p.slug === projectSlug) ?? null;

  if (projects.loading) return <Skeleton className="h-32 w-full" />;
  if (!project) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Project not found</CardTitle>
          <CardDescription>No project matches “{projectSlug}”.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[560px] text-[13px] leading-normal text-muted-foreground">
          Project-scoped secrets, feature flags, and settings for this repo.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/orgs/${orgSlug}/secrets?project=${projectSlug}`}>
            Open in Secrets console
          </Link>
        </Button>
      </div>
      <ConfigSurface scope={{ kind: "project", orgId, projectId: project.id }} />
    </div>
  );
}
