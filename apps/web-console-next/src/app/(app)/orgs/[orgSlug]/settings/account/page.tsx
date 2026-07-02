"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import type { PublicOrganization } from "@saas/contracts/membership";

export default function AccountOverviewPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner org={org} slug={slug} />}</OrgScope>;
}

function StatCard({ label, value, href, loading }: { label: string; value: number | undefined; href: string; loading: boolean }) {
  return (
    <Link href={href} className="block">
      <Card className="transition-colors hover:bg-accent/50">
        <CardHeader className="pb-2">
          <CardDescription>{label}</CardDescription>
          {loading ? (
            <Skeleton className="h-8 w-12" />
          ) : (
            <CardTitle className="text-2xl tabular-nums">{value ?? "—"}</CardTitle>
          )}
        </CardHeader>
      </Card>
    </Link>
  );
}

function Inner({ org, slug }: { org: PublicOrganization; slug: string }) {
  const { client } = useSession();
  const base = `/orgs/${slug}/settings`;

  const workspaces = useApiQuery(qk.accountWorkspaces(org.id), () =>
    wrap(async () => (await client.account.workspaces(org.id)).workspaces),
  );
  const members = useApiQuery(qk.accountMembers(org.id), () =>
    wrap(async () => (await client.account.members(org.id)).members),
  );
  const roles = useApiQuery(qk.accountRoles(org.id), () =>
    wrap(async () => (await client.account.roles(org.id)).assignments),
  );
  const teams = useApiQuery(qk.teams(org.id), () =>
    wrap(async () => (await client.teams.listTeams(org.id)).teams),
  );

  const isRoot = org.kind === "account" || org.isAccountRoot === true;

  return (
    <div className="space-y-5">
      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Account</h1>
          {org.accountId ? (
            <Badge variant="outline" className="font-mono text-xs">{org.accountId}</Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {isRoot
            ? "This workspace is the account root. Everything here spans every workspace under it."
            : "The account this workspace belongs to. Everything here spans every workspace under it."}
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Workspaces" value={workspaces.data?.length} href={`${base}/account/workspaces`} loading={workspaces.loading} />
        <StatCard label="Account members" value={members.data?.length} href={`${base}/account/members`} loading={members.loading} />
        <StatCard label="Account roles" value={roles.data?.length} href={`${base}/account/roles`} loading={roles.loading} />
        <StatCard label="Teams" value={teams.data?.length} href={`${base}/teams`} loading={teams.loading} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How the account works</CardTitle>
          <CardDescription>
            The account is a surface over your workspace set, not another tenancy level. Teams are owned by
            the account and can be granted roles on any workspace; account roles cascade to every workspace,
            current and future. Grants and revocations are audited.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          <p>
            <span className="font-medium text-foreground">Workspaces</span> — every workspace under this
            account, with a jump-off to each.
          </p>
          <p>
            <span className="font-medium text-foreground">Account members</span> — the derived roster: workspace-set
            members plus account-role holders, including cascade admins who appear in no workspace member list.
          </p>
          <p>
            <span className="font-medium text-foreground">Account roles</span> — account-wide authority
            (owner, admin, billing admin) — granted here, revoked here.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
