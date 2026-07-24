"use client";

// The roster side panel (saas-agent-supervision SV1, design §7.2): a
// dispatcher thread's live implementers, folded from origin — one card per
// ACTIVE implementer with its infra-state pill, delegation tier, cost tick,
// age, and a needs-you marker; terminal ones fold to a "done" count (they live
// on the Implementers surface). Snapshot-first + polled so it stays live
// without a manual refresh, the same liveness discipline as the session page.

import * as React from "react";
import type { RosterImplementer } from "@saas/contracts/agents";
import { Kicker, ListCard, ListRow, Pill } from "@/components/ui/northwind";
import { interfaceTier, sessionLabel, sessionTone } from "@/lib/agents/model";
import { compactAge, compactTokens } from "@/lib/agents/attention";
import { qk, useApiQuery } from "@/lib/query";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";

export function RosterPanel({
  orgId,
  orgSlug,
  chatId,
}: {
  orgId: string;
  orgSlug: string;
  chatId: string;
}) {
  const { client } = useSession();
  const roster = useApiQuery(
    qk.orgAgentChatImplementers(orgId, chatId),
    () => wrap(async () => client.agents.chatImplementers(orgId, chatId)),
    // Poll while there's anything live to watch; react-query pauses it when the
    // tab is hidden. A spawn from this thread appears within the interval.
    { refetchInterval: 4000 },
  );

  const data = roster.data;
  const active = data?.active ?? [];

  return (
    <aside className="min-w-0">
      <Kicker className="mb-2.5">
        Implementers{data ? ` · ${active.length}` : ""}
      </Kicker>
      {data ? (
        <p className="mb-2.5 text-[12px] text-muted-foreground">
          {data.running} running · {data.needsYou} waiting on you · {data.done} done
        </p>
      ) : null}

      {active.length === 0 ? (
        <ListCard>
          <div className="px-3.5 py-3 text-[12.5px] text-muted-foreground">
            {roster.loading ? "Loading…" : "No live implementers from this thread yet."}
          </div>
        </ListCard>
      ) : (
        <ListCard>
          {active.map((entry) => (
            <RosterCard key={entry.session.id} entry={entry} orgSlug={orgSlug} />
          ))}
        </ListCard>
      )}
    </aside>
  );
}

function RosterCard({ entry, orgSlug }: { entry: RosterImplementer; orgSlug: string }) {
  const s = entry.session;
  const tier = interfaceTier(entry.interface);
  const goal = s.taskKey ?? s.workRef ?? s.runKind;
  return (
    <ListRow href={`/orgs/${orgSlug}/agents/${s.id}`} chevron>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[12.5px]">{s.id}</span>
          <Pill tone={sessionTone(s.state)} dot live={s.state === "running"}>
            {sessionLabel(s.state)}
          </Pill>
          <Pill tone={tier.tone}>{tier.label}</Pill>
          {entry.needsYou ? <Pill tone="warning" dot>Needs you</Pill> : null}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
          {goal} · {compactTokens(s.tokensUsed ?? 0)} tok ·{" "}
          {compactAge(s.startedAt ?? s.createdAt, new Date())}
        </div>
      </div>
    </ListRow>
  );
}
