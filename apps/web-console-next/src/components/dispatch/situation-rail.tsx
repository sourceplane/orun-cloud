"use client";

// The Situation rail (saas-dispatch DX2) — the live answer to "what can I
// hand off, what is running, what needs me", beside the Workspace Agent
// thread. Two planes render side by side and are NEVER merged (D5): work
// cards show fold facts with evidence; session cards show infrastructure
// state; a verdict card links to the session page where a human answers
// (lock 5 — this rail can surface an approval, never resolve one).

import * as React from "react";
import Link from "next/link";
import type { Situation } from "@saas/contracts/dispatch";
import { Button } from "@/components/ui/button";
import { Pill, ListCard, ListCardHeader, ListRow, StatusText } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { sessionTone, sessionLabel } from "@/lib/agents/model";
import type { AgentSessionState } from "@saas/contracts/agents";
import {
  attentionCard,
  budgetView,
  readyCard,
  sessionCard,
  unavailableSections,
} from "@/lib/dispatch/model";

export function SituationRail({
  orgId,
  orgSlug,
  situation,
  loading,
  transport,
  reload,
}: {
  orgId: string;
  orgSlug: string;
  situation: Situation | null;
  loading: boolean;
  transport: "ws" | "off";
  reload: () => void;
}) {
  if (loading && !situation) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }
  if (!situation) return null;
  const degraded = unavailableSections(situation);

  return (
    <div className="grid gap-4">
      {degraded.length > 0 ? (
        <StatusText tone="warning" className="text-[12px]">
          Some sections are unreachable right now: {degraded.join(", ")}.
        </StatusText>
      ) : null}
      <ReadyCardList orgId={orgId} orgSlug={orgSlug} situation={situation} reload={reload} />
      <InFlightCard orgSlug={orgSlug} situation={situation} />
      <WaitingCard orgSlug={orgSlug} situation={situation} />
      <BudgetCard situation={situation} transport={transport} />
    </div>
  );
}

function ReadyCardList({
  orgId,
  orgSlug,
  situation,
  reload,
}: {
  orgId: string;
  orgSlug: string;
  situation: Situation;
  reload: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [busyKey, setBusyKey] = React.useState<string | null>(null);

  async function dispatch(taskKey: string) {
    setBusyKey(taskKey);
    // The one dispatch door (AG9): every gate applies server-side; a refusal
    // reason renders verbatim — the refusal IS the product.
    const res = await wrap(async () => client.agents.dispatchTask(orgId, { taskKey }));
    setBusyKey(null);
    if (res.ok) {
      toast({
        kind: "success",
        title: `${taskKey} dispatched`,
        description: res.data.provisioned === false ? "Session parked — connect a provider to boot it." : undefined,
      });
    } else {
      toast({ kind: "warning", title: `Dispatch refused: ${taskKey}`, description: res.error.message });
    }
    reload();
  }

  return (
    <ListCard>
      <ListCardHeader
        title={
          <span className="flex items-center gap-2">
            Ready
            <Pill tone={situation.ready.length > 0 ? "info" : "neutral"}>{situation.ready.length}</Pill>
          </span>
        }
      />
      {situation.ready.length === 0 ? (
        <p className="px-5 pb-4 text-[12.5px] text-muted-foreground">
          Nothing is Ready and unclaimed. Ready derives from contracts and dependencies — nobody can set it.
        </p>
      ) : (
        situation.ready.map((item) => {
          const card = readyCard(item);
          return (
            <ListRow key={card.key}>
              <div className="min-w-0 flex-1">
                <Link href={card.href(orgSlug)} className="text-[13px] font-medium hover:underline">
                  {card.key} · {card.title}
                </Link>
                {card.evidenceLine ? (
                  <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{card.evidenceLine}</div>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busyKey !== null}
                onClick={() => void dispatch(card.key)}
              >
                {busyKey === card.key ? "Dispatching…" : "Dispatch"}
              </Button>
            </ListRow>
          );
        })
      )}
    </ListCard>
  );
}

function InFlightCard({ orgSlug, situation }: { orgSlug: string; situation: Situation }) {
  return (
    <ListCard>
      <ListCardHeader
        title={
          <span className="flex items-center gap-2">
            In flight
            <Pill tone={situation.inFlight.length > 0 ? "success" : "neutral"}>{situation.inFlight.length}</Pill>
          </span>
        }
      />
      {situation.inFlight.length === 0 ? (
        <p className="px-5 pb-4 text-[12.5px] text-muted-foreground">No live sessions.</p>
      ) : (
        situation.inFlight.map((item) => {
          const card = sessionCard(item);
          return (
            <ListRow key={card.id}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {card.isChild ? <span className="text-muted-foreground">└</span> : null}
                  <Link href={card.href(orgSlug)} className="font-mono text-[12.5px] hover:underline">
                    {card.id}
                  </Link>
                  <Pill tone={sessionTone(card.state as AgentSessionState)}>
                    {sessionLabel(card.state as AgentSessionState)}
                  </Pill>
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">
                  {card.runKind}
                  {card.taskKey ? (
                    <>
                      {" · "}
                      <Link href={`/orgs/${orgSlug}/work?item=${encodeURIComponent(card.taskKey)}`} className="hover:underline">
                        {card.taskKey}
                      </Link>
                    </>
                  ) : null}
                  {card.tokensUsed > 0 ? ` · ${card.tokensUsed.toLocaleString()} tok` : null}
                </div>
              </div>
            </ListRow>
          );
        })
      )}
    </ListCard>
  );
}

function WaitingCard({ orgSlug, situation }: { orgSlug: string; situation: Situation }) {
  return (
    <ListCard>
      <ListCardHeader
        title={
          <span className="flex items-center gap-2">
            Waiting on you
            <Pill tone={situation.waitingOnMe.length > 0 ? "warning" : "neutral"}>{situation.waitingOnMe.length}</Pill>
          </span>
        }
      />
      {situation.waitingOnMe.length === 0 ? (
        <p className="px-5 pb-4 text-[12.5px] text-muted-foreground">Nothing needs a human right now.</p>
      ) : (
        situation.waitingOnMe.map((item, i) => {
          const card = attentionCard(item);
          return (
            <ListRow key={`${card.kind}-${i}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Pill tone="warning">{card.kind}</Pill>
                  <span className="truncate text-[12.5px]">{card.reason}</span>
                </div>
                {card.humanGated ? (
                  <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                    Answered on the session page — approvals never resolve from here.
                  </div>
                ) : null}
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={card.href(orgSlug)}>Open</Link>
              </Button>
            </ListRow>
          );
        })
      )}
    </ListCard>
  );
}

function BudgetCard({ situation, transport }: { situation: Situation; transport: "ws" | "off" }) {
  const view = budgetView(situation.budget);
  return (
    <ListCard>
      <ListCardHeader
        title={
          <span className="flex items-center gap-2">
            Budget
            <Pill tone={transport === "ws" ? "success" : "neutral"}>{transport === "ws" ? "live" : "polling"}</Pill>
          </span>
        }
      />
      <div className="px-5 pb-4">
        {view.hasCeiling ? (
          <>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={
                  view.tone === "error" ? "h-full bg-red-500" : view.tone === "warning" ? "h-full bg-amber-500" : "h-full bg-emerald-500"
                }
                style={{ width: `${view.pct}%` }}
              />
            </div>
            <div className="mt-1.5 text-[12px] text-muted-foreground">{view.label}</div>
          </>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">{view.label}</p>
        )}
      </div>
    </ListCard>
  );
}
