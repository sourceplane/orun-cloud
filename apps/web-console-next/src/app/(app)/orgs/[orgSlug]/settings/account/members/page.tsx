"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Users } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsHeader, SettingsPanel } from "@/components/settings/settings-primitives";
import { ListCard, ListRow, Pill } from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import type { AccountMemberOrigin } from "@saas/contracts/membership";

function OriginBadge({ origin }: { origin: AccountMemberOrigin }) {
  if (origin === "account_role") {
    // The cascade admins the roster exists to surface: authority everywhere,
    // membership nowhere.
    return <Pill tone="warning">account role only</Pill>;
  }
  if (origin === "both") {
    return <Pill tone="info">member + account role</Pill>;
  }
  return <Pill tone="neutral">member</Pill>;
}

export default function AccountMembersPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const members = useApiQuery(qk.accountMembers(orgId), () =>
    wrap(async () => (await client.account.members(orgId)).members),
  );

  return (
    <div className="space-y-[18px]">
      <SettingsHeader
        title="Account members"
        description="Everyone with account-level presence: members of the account root, plus holders of account-wide roles — including admins who appear in no workspace member list."
      />

      {members.loading ? (
        <SettingsPanel className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </SettingsPanel>
      ) : members.error ? (
        <SettingsPanel>
          <div className="text-[13.5px] font-semibold text-destructive">{members.error.code}</div>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">{members.error.message}</p>
        </SettingsPanel>
      ) : !members.data || members.data.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No account members"
          description="No one holds account-level membership or an account role yet."
        />
      ) : (
        <ListCard>
          {members.data.map((m) => (
            <ListRow key={m.subjectId} className="items-start">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-xs">{m.subjectId}</span>
                  <OriginBadge origin={m.origin} />
                </div>
                <div className="text-[11.5px] text-muted-foreground">
                  {m.accountRoles.length > 0 ? m.accountRoles.join(", ") : "—"}
                </div>
              </div>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">
                {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : "—"}
              </span>
            </ListRow>
          ))}
        </ListCard>
      )}
    </div>
  );
}
