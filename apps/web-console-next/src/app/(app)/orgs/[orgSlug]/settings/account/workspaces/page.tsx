"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Boxes } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsHeader, SettingsPanel } from "@/components/settings/settings-primitives";
import { ListCard, ListRow, MonoRef } from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

export default function AccountWorkspacesPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const workspaces = useApiQuery(qk.accountWorkspaces(orgId), () =>
    wrap(async () => (await client.account.workspaces(orgId)).workspaces),
  );

  return (
    <div className="space-y-[18px]">
      <SettingsHeader
        title="Workspaces"
        description="Every workspace under this account. Teams and account roles reach all of them."
      />

      {workspaces.loading ? (
        <SettingsPanel className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </SettingsPanel>
      ) : workspaces.error ? (
        <SettingsPanel>
          <div className="text-[13.5px] font-semibold text-destructive">{workspaces.error.code}</div>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">{workspaces.error.message}</p>
        </SettingsPanel>
      ) : !workspaces.data || workspaces.data.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No child workspaces"
          description="This account has no child workspaces yet. New workspaces created under it will appear here."
        />
      ) : (
        <ListCard>
          {workspaces.data.map((w) => (
            <ListRow key={w.orgId} className="items-start">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="truncate text-[13px] font-medium">{w.name}</div>
                <MonoRef className="block truncate">{w.workspaceRef}</MonoRef>
              </div>
              <MonoRef className="shrink-0">{w.orgId}</MonoRef>
            </ListRow>
          ))}
        </ListCard>
      )}
    </div>
  );
}
