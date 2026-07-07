"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { InteractiveCard } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsHeader, SettingsPanel, PanelTitle } from "@/components/settings/settings-primitives";
import { Kicker, Pill } from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import type { PublicOrganization } from "@saas/contracts/membership";

export default function AccountOverviewPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner org={org} slug={slug} />}</OrgScope>;
}

function StatTile({ label, value, href, loading }: { label: string; value: number | undefined; href: string; loading: boolean }) {
  return (
    <Link href={href} className="block">
      <InteractiveCard className="px-[22px] py-5">
        <Kicker>{label}</Kicker>
        {loading ? (
          <Skeleton className="mt-3 h-[34px] w-12" />
        ) : (
          <div className="mt-3 font-serif text-[34px] font-medium leading-none tabular-nums">{value ?? "—"}</div>
        )}
      </InteractiveCard>
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
    <div className="space-y-[18px]">
      <SettingsHeader
        title="Account"
        description={
          isRoot
            ? "This workspace is the account root. Everything here spans every workspace under it."
            : "The account this workspace belongs to. Everything here spans every workspace under it."
        }
        actions={
          org.accountId ? (
            <Pill tone="neutral" className="font-mono">{org.accountId}</Pill>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Workspaces" value={workspaces.data?.length} href={`${base}/account/workspaces`} loading={workspaces.loading} />
        <StatTile label="Account members" value={members.data?.length} href={`${base}/account/members`} loading={members.loading} />
        <StatTile label="Account roles" value={roles.data?.length} href={`${base}/account/roles`} loading={roles.loading} />
        <StatTile label="Teams" value={teams.data?.length} href={`/orgs/${slug}/teams`} loading={teams.loading} />
      </div>

      <SettingsPanel>
        <PanelTitle>How the account works</PanelTitle>
        <p className="mt-1.5 text-[12.5px] leading-normal text-muted-foreground">
          The account is a surface over your workspace set, not another tenancy level. Teams are owned by
          the account and can be granted roles on any workspace; account roles cascade to every workspace,
          current and future. Grants and revocations are audited.
        </p>
        <div className="mt-3.5 space-y-1 text-[12.5px] leading-normal text-muted-foreground">
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
        </div>
      </SettingsPanel>
    </div>
  );
}
