"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { SettingsHeader, SettingsPanel } from "@/components/settings/settings-primitives";
import { ListCard, ListRow, Pill } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import type { FactOrigin } from "@saas/sdk";

function ProvenanceBadge({ via, teamName }: { via: FactOrigin | undefined; teamName: (id: string) => string }) {
  if (!via) return <span className="text-muted-foreground">—</span>;
  if (via.kind === "team") {
    // teams-foundation TF4 — legible provenance: resolve the immutable team_ id to
    // the team's display name ("via Team Payments") rather than the raw id.
    return <Pill tone="info">via Team {via.teamId ? teamName(via.teamId) : ""}</Pill>;
  }
  if (via.kind === "account_cascade") {
    return <Pill tone="neutral">account</Pill>;
  }
  return <Pill tone="neutral">direct</Pill>;
}

/**
 * Effective-access viewer (saas-settings-ia SI3 — the "Access" tab of People &
 * Access). Shows what the signed-in actor can do in this workspace and how each
 * permission reaches them — directly, through a team, or cascaded from the
 * account — the provenance lens over the roster.
 */
export function AccessPanel({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const access = useApiQuery(qk.effectiveAccess(orgId), () =>
    wrap(async () => (await client.teams.effectiveAccess(orgId)).permissions),
  );
  // TF4 — resolve team_ ids in provenance to legible names/handles.
  const teams = useApiQuery(qk.teams(orgId), () =>
    wrap(async () => (await client.teams.listTeams(orgId)).teams),
  );
  const teamName = React.useCallback(
    (id: string): string => {
      const t = (teams.data ?? []).find((x) => x.id === id);
      if (!t) return id;
      return t.handle ? `${t.name} (@${t.handle})` : t.name;
    },
    [teams.data],
  );

  const allowed = React.useMemo(
    () => (access.data ?? []).filter((p) => p.allow),
    [access.data],
  );

  return (
    <div className="space-y-[18px]">
      <SettingsHeader
        title="Effective access"
        description="What you can do in this workspace, and how each permission reaches you — directly, through a team, or cascaded from the account."
      />

      {access.loading ? (
        <SettingsPanel className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </SettingsPanel>
      ) : access.error ? (
        <SettingsPanel>
          <div className="text-[13.5px] font-semibold text-destructive">{access.error.code}</div>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">{access.error.message}</p>
        </SettingsPanel>
      ) : allowed.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No permissions here"
          description="You have no granted actions in this workspace yet."
        />
      ) : (
        <ListCard>
          {allowed.map((p) => (
            <ListRow key={p.action}>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{p.action}</span>
              <ProvenanceBadge via={p.via} teamName={teamName} />
            </ListRow>
          ))}
        </ListCard>
      )}
    </div>
  );
}
