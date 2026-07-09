"use client";

// The Agents surface (saas-agents AG7): hosted orun sessions — the fleet
// view. Everything here is an INFRASTRUCTURE fact (design §4.1): session
// states, sandbox liveness, provider connections. The work truth (what the
// run achieved) lives on the Work surface; a session row links to its task,
// never restates it.

import * as React from "react";
import type { AgentProfile, AgentSession } from "@saas/contracts/agents";
import { Skeleton } from "@/components/ui/skeleton";
import {
  HeaderStat,
  Kicker,
  ListCard,
  ListCardHeader,
  ListRow,
  PageHeader,
  Pill,
  Screen,
  StatusText,
} from "@/components/ui/northwind";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { sessionLabel, sessionTone } from "@/lib/agents/model";
import { ProviderConnections } from "@/components/agents/provider-connections";
import { CreateProfileDialog } from "@/components/agents/create-profile-dialog";

export function AgentsWorkbench({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const sessions = useApiQuery(qk.orgAgents(orgId), () =>
    wrap(async () => {
      const [sessionRows, profileRows] = await Promise.all([
        client.agents.listSessions(orgId),
        client.agents.listProfiles(orgId),
      ]);
      return { sessions: sessionRows, profiles: profileRows };
    }),
  );

  const [profileOpen, setProfileOpen] = React.useState(false);
  const data = sessions.data;
  const running = data?.sessions.filter((s) => s.state === "running").length ?? 0;
  const active = data?.sessions.filter((s) =>
    ["requested", "provisioning", "running", "awaiting_approval"].includes(s.state),
  ).length;

  return (
    <Screen>
      <PageHeader
        title="Agents"
        description="Hosted orun sessions on your connected compute. Spawn from Work; watch the run here."
        actions={
          <div className="flex items-center gap-4">
            <HeaderStat value={String(running)} caption="running" />
            <HeaderStat value={String(active ?? "—")} caption="active" />
          </div>
        }
      />

      <Kicker className="mb-2.5">Providers</Kicker>
      <ProviderConnections orgId={orgId} />

      <Kicker className="mb-2.5 mt-8">Sessions</Kicker>
      {sessions.loading && !data ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : sessions.error ? (
        <StatusText tone="error">{sessions.error.message}</StatusText>
      ) : (data?.sessions.length ?? 0) === 0 ? (
        <EmptyState
          title="No sessions yet"
          description="Sessions appear when an agent is spawned — from a Work item, the CLI (orun agent run), or the API. Connect Daytona and Anthropic above to unlock hosted runs."
        />
      ) : (
        <ListCard>
          <ListCardHeader title="Hosted sessions" />
          {data!.sessions.map((s) => (
            <SessionRow key={s.id} session={s} orgSlug={orgSlug} profiles={data!.profiles} />
          ))}
        </ListCard>
      )}

      <div className="mb-2.5 mt-8 flex items-center justify-between">
        <Kicker className="mb-0">Profiles</Kicker>
        {(data?.profiles.length ?? 0) > 0 ? (
          <Button size="sm" variant="outline" onClick={() => setProfileOpen(true)}>
            New profile
          </Button>
        ) : null}
      </div>
      {(data?.profiles.length ?? 0) === 0 ? (
        <EmptyState
          title="No agent profiles"
          description="A profile binds an orun agent type to a service principal with a responsible owner. It's the identity a session runs as."
          primaryAction={{ label: "New profile", onClick: () => setProfileOpen(true) }}
        />
      ) : (
        <ListCard>
          <ListCardHeader title="Agent profiles" />
          {data!.profiles.map((p) => (
            <ListRow key={p.id}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">{p.name}</span>
                  <Pill tone="neutral">{p.agentType}</Pill>
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">
                  {p.harness} · {p.model} · owner {p.owner} · autonomy {p.autonomyDefault}
                </div>
              </div>
            </ListRow>
          ))}
        </ListCard>
      )}

      <CreateProfileDialog
        orgId={orgId}
        open={profileOpen}
        onOpenChange={setProfileOpen}
        onCreated={sessions.reload}
      />
    </Screen>
  );
}

function SessionRow({
  session,
  orgSlug,
  profiles,
}: {
  session: AgentSession;
  orgSlug: string;
  profiles: AgentProfile[];
}) {
  const profile = profiles.find((p) => p.id === session.profileId);
  return (
    <ListRow href={`/orgs/${orgSlug}/agents/${session.id}`} chevron>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[12.5px]">{session.id}</span>
          <Pill tone={sessionTone(session.state)} dot live={session.state === "running"}>
            {sessionLabel(session.state)}
          </Pill>
          <Pill tone="neutral">{session.runKind}</Pill>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
          {profile ? `${profile.name} · ` : ""}
          {session.taskKey ? `${session.taskKey} · ` : ""}
          spawned by {session.spawnedBy} · {new Date(session.createdAt).toLocaleString()}
        </div>
      </div>
    </ListRow>
  );
}
