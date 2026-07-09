"use client";

// Session detail (saas-agents AG7): infrastructure facts + the relayed event
// feed. The feed is the control-plane MIRROR of the runtime's session log —
// the sealed AgentSessionSnapshot in orun's object graph stays the system of
// record. Polls while the session is live; the DO/SSE live tail replaces the
// poll in a later slice.

import * as React from "react";
import Link from "next/link";
import { isTerminalSessionState } from "@saas/contracts/agents";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Breadcrumbs,
  Kicker,
  ListCard,
  ListCardHeader,
  ListRow,
  PageHeader,
  Pill,
  Screen,
  StatCard,
  StatusText,
} from "@/components/ui/northwind";
import { EmptyState } from "@/components/ui/empty-state";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { sessionLabel, sessionTone } from "@/lib/agents/model";

const LIVE_POLL_MS = 5_000;

export function SessionDetail({
  orgId,
  orgSlug,
  sessionId,
}: {
  orgId: string;
  orgSlug: string;
  sessionId: string;
}) {
  const { client } = useSession();
  const session = useApiQuery(qk.orgAgentSession(orgId, sessionId), () =>
    wrap(async () => client.agents.getSession(orgId, sessionId)),
  );
  const events = useApiQuery(qk.orgAgentSessionEvents(orgId, sessionId), () =>
    wrap(async () => client.agents.listSessionEvents(orgId, sessionId)),
  );

  // Poll while live; stop on terminal states.
  const live = session.data ? !isTerminalSessionState(session.data.state) : false;
  const reloadSession = session.reload;
  const reloadEvents = events.reload;
  React.useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      reloadSession();
      reloadEvents();
    }, LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [live, reloadSession, reloadEvents]);

  if (session.loading && !session.data) {
    return (
      <Screen>
        <Skeleton className="h-64 w-full rounded-xl" />
      </Screen>
    );
  }
  if (session.error || !session.data) {
    return (
      <Screen>
        <StatusText tone="error">{session.error?.message ?? "Session not found"}</StatusText>
      </Screen>
    );
  }
  const s = session.data;

  return (
    <Screen>
      <Breadcrumbs
        items={[
          { label: "Agents", href: `/orgs/${orgSlug}/agents` },
          { label: s.id },
        ]}
      />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="font-mono text-[0.85em]">{s.id}</span>
            <Pill tone={sessionTone(s.state)} dot live={s.state === "running"}>
              {sessionLabel(s.state)}
            </Pill>
          </span>
        }
        description={`${s.runKind} run · spawned by ${s.spawnedBy}`}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Created" value={new Date(s.createdAt).toLocaleString()} />
        <StatCard label="Started" value={s.startedAt ? new Date(s.startedAt).toLocaleString() : "—"} />
        <StatCard label="Ended" value={s.endedAt ? new Date(s.endedAt).toLocaleString() : "—"} />
      </div>

      {(s.taskKey || s.workRef || s.prUrl || s.snapshotId) && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {s.taskKey ? (
            <Link href={`/orgs/${orgSlug}/work`}>
              <Pill tone="info">{s.taskKey}</Pill>
            </Link>
          ) : null}
          {s.prUrl ? (
            <a href={s.prUrl} target="_blank" rel="noreferrer">
              <Pill tone="success">Pull request ↗</Pill>
            </a>
          ) : null}
          {s.snapshotId ? <Pill tone="neutral">sealed {s.snapshotId.slice(0, 18)}…</Pill> : null}
        </div>
      )}

      <Kicker className="mb-2.5 mt-8">Session log{live ? " · live" : ""}</Kicker>
      {events.loading && !events.data ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : (events.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No events yet"
          description="The runtime relays its session log here once the sandbox dials home."
        />
      ) : (
        <ListCard>
          <ListCardHeader title={`${events.data!.length} events`} />
          {events.data!.map((e) => (
            <ListRow key={e.seq}>
              <span className="w-10 shrink-0 font-mono text-[11.5px] text-muted-foreground">{e.seq}</span>
              <Pill tone={e.kind === "error" ? "error" : "neutral"} className="shrink-0">
                {e.kind}
              </Pill>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
                {e.payload ? JSON.stringify(e.payload) : ""}
              </span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">
                {new Date(e.at).toLocaleTimeString()}
              </span>
            </ListRow>
          ))}
        </ListCard>
      )}
    </Screen>
  );
}
