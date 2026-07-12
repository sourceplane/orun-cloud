"use client";

// The Agents fleet home (saas-agents AG7, evolved by saas-agents-fleet AF5):
// what needs you, then what is moving, then what ran, then what it runs as,
// then what it runs on (design §2.1). Everything here is an INFRASTRUCTURE
// fact: session states, the needs-you fold, provider connections. The work
// truth (what the run achieved) lives on the Work surface; a session row
// links to its task, never restates it.

import * as React from "react";
import type { AgentProfile, AgentRecordsEntry, AgentSession } from "@saas/contracts/agents";
import { isTerminalSessionState } from "@saas/contracts/agents";
import { Skeleton } from "@/components/ui/skeleton";
import {
  HeaderStat,
  Kicker,
  ListCard,
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
import { orderFleetRows, sessionLabel, sessionTone } from "@/lib/agents/model";
import { compactAge, compactTokens } from "@/lib/agents/attention";
import { AttentionQueue } from "@/components/agents/attention-queue";
import { RoutinesCard } from "@/components/agents/routines-card";
import { ProviderConnections } from "@/components/agents/provider-connections";
import { CreateProfileDialog } from "@/components/agents/create-profile-dialog";

export function AgentsWorkbench({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const fleet = useApiQuery(qk.orgAgents(orgId), () =>
    wrap(async () => {
      // The core reads gate the page (a real failure here IS the page's
      // failure). The newer secondary surfaces — routines (AF6), records
      // (AF7) — degrade to empty rather than blank the fleet home if they
      // fail (e.g. a role without the routine grant); the page still shows
      // sessions and the needs-you queue.
      const [sessionRows, profileRows, attention] = await Promise.all([
        client.agents.listSessions(orgId),
        client.agents.listProfiles(orgId),
        client.agents.attention(orgId),
      ]);
      const [routineRows, recordRows] = await Promise.all([
        client.agents.listRoutines(orgId).catch(() => []),
        client.agents.records(orgId).catch(() => []),
      ]);
      return {
        sessions: sessionRows,
        profiles: profileRows,
        attention,
        routines: routineRows,
        records: recordRows,
      };
    }),
  );

  const [profileOpen, setProfileOpen] = React.useState(false);
  const data = fleet.data;
  // Both stat numerals come from the same needs-you fold the queue renders —
  // the badge count equals the fold everywhere it appears (AF5 done-when).
  const running = data?.attention.running ?? 0;
  const verdicts = data?.attention.counts.verdict ?? 0;
  const active = data?.sessions.filter((s) => !isTerminalSessionState(s.state)) ?? [];
  const recent = data?.sessions.filter((s) => isTerminalSessionState(s.state)) ?? [];

  return (
    <Screen>
      <PageHeader
        title="Agents"
        description="Hosted orun sessions on your connected compute. A session is infrastructure — what the run achieves lives on Work; a session links to its task, never restates it."
        actions={
          <div className="flex items-center gap-4">
            <HeaderStat value={String(running)} caption="running" />
            <HeaderStat
              value={String(verdicts)}
              caption="need a verdict"
              {...(verdicts > 0 ? { tone: "warning" as const } : {})}
            />
          </div>
        }
      />

      {fleet.loading && !data ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : fleet.error ? (
        <StatusText tone="error">{fleet.error.message}</StatusText>
      ) : (
        <>
          <AttentionQueue
            orgId={orgId}
            orgSlug={orgSlug}
            attention={data!.attention}
            onActed={fleet.reload}
          />

          <Kicker className="mb-2.5">Active sessions</Kicker>
          {active.length === 0 ? (
            <EmptyState
              title="No live sessions"
              description="Sessions appear when an agent is spawned — from a Work item, the CLI (orun agent run), or the API."
            />
          ) : (
            <ListCard>
              {orderFleetRows(active).map((row) => (
                <SessionRow
                  key={row.session.id}
                  session={row.session}
                  treeDepth={row.depth}
                  orgSlug={orgSlug}
                  profiles={data!.profiles}
                />
              ))}
            </ListCard>
          )}

          {recent.length > 0 ? (
            <>
              <Kicker className="mb-2.5 mt-8">Recent</Kicker>
              <ListCard>
                {orderFleetRows(recent).map((row) => (
                  <SessionRow
                    key={row.session.id}
                    session={row.session}
                    treeDepth={row.depth}
                    orgSlug={orgSlug}
                    profiles={data!.profiles}
                  />
                ))}
              </ListCard>
            </>
          ) : null}

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
            <>
              <ListCard>
                {data!.profiles.map((p) => (
                  <ProfileRow
                    key={p.id}
                    profile={p}
                    entry={data!.records.find((r) => r.profileId === p.id)}
                    orgId={orgId}
                    onChanged={fleet.reload}
                  />
                ))}
              </ListCard>
              <p className="mt-2 text-[12px] text-muted-foreground">
                A profile is the identity a session runs as — an agent type bound to a service
                principal with a responsible owner.
              </p>
            </>
          )}

          <RoutinesCard orgId={orgId} routines={data!.routines} onChanged={fleet.reload} />

          <Kicker className="mb-2.5 mt-8">Providers</Kicker>
          <ProviderConnections orgId={orgId} />
        </>
      )}

      <CreateProfileDialog
        orgId={orgId}
        open={profileOpen}
        onOpenChange={setProfileOpen}
        onCreated={fleet.reload}
      />
    </Screen>
  );
}

function SessionRow({
  session,
  treeDepth = 0,
  orgSlug,
  profiles,
}: {
  session: AgentSession;
  /** Delegation indent (AF4): children nest one gutter step per level. */
  treeDepth?: number;
  orgSlug: string;
  profiles: AgentProfile[];
}) {
  const profile = profiles.find((p) => p.id === session.profileId);
  const live = !isTerminalSessionState(session.state);
  return (
    <ListRow href={`/orgs/${orgSlug}/agents/${session.id}`} chevron>
      <div className="min-w-0 flex-1" style={treeDepth > 0 ? { paddingLeft: treeDepth * 16 } : undefined}>
        <div className="flex items-center gap-2">
          {treeDepth > 0 ? <span className="text-[12px] text-muted-foreground/60">├</span> : null}
          <span className="truncate font-mono text-[12.5px]">{session.id}</span>
          <Pill tone={sessionTone(session.state)} dot live={session.state === "running"}>
            {sessionLabel(session.state)}
          </Pill>
          <Pill tone="neutral">{session.runKind}</Pill>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
          {profile ? `${profile.name} · ` : ""}
          {session.workRef ? `${session.workRef} · ` : session.taskKey ? `${session.taskKey} · ` : ""}
          {session.failureReason
            ? `${session.failureReason} — task rung untouched · `
            : ""}
          spawned by {session.spawnedBy}
        </div>
      </div>
      <span className="shrink-0 font-mono text-[12px] text-muted-foreground">
        {compactTokens(session.tokensUsed)} tok
      </span>
      <span className="shrink-0 font-mono text-[12px] text-muted-foreground">
        {compactAge(live ? session.startedAt ?? session.createdAt : session.endedAt ?? session.createdAt, new Date())}
      </span>
    </ListRow>
  );
}

/** A profile row with its track record and — when the record clears the
 * workspace bar — the promotion suggestion (AF7). The suggestion never
 * applies itself: Apply is the human ack, and the server attaches the
 * record it computed as the movement's evidence. */
function ProfileRow({
  profile,
  entry,
  orgId,
  onChanged,
}: {
  profile: AgentProfile;
  entry: AgentRecordsEntry | undefined;
  orgId: string;
  onChanged: () => void;
}) {
  const { client } = useSession();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const record = entry?.record;
  const promotion = entry?.promotion;
  const evidence = profile.autonomyEvidence as
    | { direction?: string; at?: string; by?: string; trigger?: string }
    | undefined;

  const promote = React.useCallback(async () => {
    if (!promotion?.suggested) return;
    setBusy(true);
    setError(null);
    try {
      await client.agents.setProfileAutonomy(orgId, profile.id, {
        autonomyDefault: promotion.suggested,
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Promotion failed");
    } finally {
      setBusy(false);
    }
  }, [client, orgId, profile.id, promotion, onChanged]);

  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">{profile.name}</span>
          <Pill tone="neutral">{profile.agentType}</Pill>
          {promotion?.eligible && promotion.suggested ? (
            <Pill tone="info">promotion suggested</Pill>
          ) : null}
        </div>
        <div className="mt-0.5 text-[12px] text-muted-foreground">
          {profile.harness} · {profile.model} · owner {profile.owner} · autonomy {profile.autonomyDefault}
          {evidence?.direction && evidence.at
            ? ` · ${evidence.direction} ${new Date(evidence.at).toLocaleDateString()}${
                evidence.direction === "demoted" && evidence.trigger
                  ? ` (${evidence.trigger})`
                  : evidence.by
                    ? ` by ${evidence.by}`
                    : ""
              }`
            : ""}
        </div>
        {error ? <StatusText tone="error">{error}</StatusText> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {record ? (
          <span className="font-mono text-[12px] text-muted-foreground">
            {record.sessions} runs
            {record.completionRate !== null ? ` · ${Math.round(record.completionRate * 100)}% completed` : ""}
          </span>
        ) : null}
        {promotion?.eligible && promotion.suggested ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void promote()}>
            Promote to {promotion.suggested}
          </Button>
        ) : null}
      </div>
    </ListRow>
  );
}
