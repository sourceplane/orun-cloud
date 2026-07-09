"use client";

// Triage (orun-work-v3 PM5): everything that needs a HUMAN decision, one
// surface — drift, claim suggestions, review-parked work, mentions, and the
// contract-review lane. Every lane is a fold over the two logs: nothing here
// can be dismissed, only ANSWERED — accept mints a reviewing comment, revert
// is a human contract edit, review-parked empties when facts arrive. The
// agent-governance loop closes here: a design run proposes a contract, a
// human reads the diff and answers in the log, attributably.

import * as React from "react";
import Link from "next/link";
import type { WorkContract, WorkContractProposalView, WorkTriageResponse } from "@saas/contracts/work";
import { Button } from "@/components/ui/button";
import { ListCard, PageHeader, Pill, Screen, StatusText } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { rungLabel } from "@/lib/work/model";

export function TriageWorkbench({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const [data, setData] = React.useState<WorkTriageResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      setData(await client.work.triage(orgId));
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "failed to load");
    }
  }, [client, orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const total = data
    ? data.drift.length + data.suggestions.length + data.reviewParked.length + data.mentions.length + data.contractProposals.length
    : 0;

  return (
    <Screen>
      <PageHeader
        title="Triage"
        description="Everything waiting on a human decision — derived from the logs, answered in the logs. Nothing here has a dismiss button."
        actions={
          <Link href={`/orgs/${orgSlug}/work`} className="text-[12.5px] text-muted-foreground underline-offset-2 hover:underline">
            ← Work
          </Link>
        }
      />
      {error ? (
        <StatusText tone="error" className="mt-[30px] block">
          {error}
        </StatusText>
      ) : !data ? (
        <div className="mt-[30px] space-y-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : total === 0 ? (
        <div className="mt-[30px] rounded-xl border bg-card px-6 py-14 text-center">
          <div className="text-[13.5px] font-medium">Nothing needs you</div>
          <p className="mx-auto mt-1.5 max-w-[420px] text-[12.5px] leading-relaxed text-muted-foreground">
            No drift, no ambiguous claims, no parked reviews, no open contract proposals. The queue
            empties by facts arriving and humans answering — and both have.
          </p>
        </div>
      ) : (
        <div className="mt-[30px] flex flex-col gap-[26px]">
          {data.contractProposals.length > 0 ? (
            <ContractReviewLane proposals={data.contractProposals} orgId={orgId} onAnswered={load} />
          ) : null}
          {data.reviewParked.length > 0 ? <ReviewParkedLane tasks={data.reviewParked} /> : null}
          {data.drift.length > 0 ? (
            <Lane title="Drift" hint="merged PRs no open task claims — unplanned changes">
              {data.drift.map((d) => (
                <Row key={d.pr} left={d.pr} right={`→ ${d.affected.join(", ")}`} wash />
              ))}
            </Lane>
          ) : null}
          {data.suggestions.length > 0 ? (
            <Lane title="Claim suggestions" hint="ambiguity suggests, never links — pick the task that owns the PR">
              {data.suggestions.map((s) => (
                <Row key={s.pr} left={s.pr} right={`could claim ${s.taskKeys.join(" or ")}`} />
              ))}
            </Lane>
          ) : null}
          {data.mentions.length > 0 ? (
            <Lane title="Mentions" hint="conversation that names someone — newest first">
              {data.mentions.map((m) => (
                <Row
                  key={m.eventId}
                  left={m.key}
                  right={`${m.handles.map((h) => `@${h}`).join(" ")} — ${m.body.length > 90 ? `${m.body.slice(0, 90)}…` : m.body}`}
                />
              ))}
            </Lane>
          ) : null}
        </div>
      )}
    </Screen>
  );
}

/* ── The contract-review lane (the agent-governance loop closes here) ── */

function contractLines(c: WorkContract): string[] {
  const lines: string[] = [];
  if (c.goal) lines.push(`goal: ${c.goal}`);
  if (c.affects?.length) lines.push(`affects: ${c.affects.join(", ")}`);
  if (c.doneWhen?.length) lines.push(`doneWhen: ${c.doneWhen.join("; ")}`);
  lines.push(`gates: ${c.gates?.length ? c.gates.join(", ") : c.gatesDefined ? "(explicitly none)" : "(undeclared)"}`);
  if (c.deps?.length) lines.push(`deps: ${c.deps.join(", ")}`);
  return lines;
}

function ContractReviewLane({
  proposals,
  orgId,
  onAnswered,
}: {
  proposals: WorkContractProposalView[];
  orgId: string;
  onAnswered: () => void;
}) {
  const { client } = useSession();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [verdicts, setVerdicts] = React.useState<Record<string, string>>({});

  const answer = async (p: WorkContractProposalView, mode: "accept" | "revert") => {
    setBusy(p.eventId);
    setVerdicts((v) => ({ ...v, [p.eventId]: "" }));
    try {
      if (mode === "accept") {
        // Accept IS a comment: a human review naming the proposal, in the log.
        await client.work.comment(orgId, p.key, {
          body: `contract proposal accepted (${p.proposedBy.id})`,
          reviewsEvent: p.eventId,
        });
      } else {
        // Revert IS a human contract edit — restoring what was in effect
        // before the proposal (attributed, visible, ordinary).
        await client.work.editContract(orgId, p.key, { contract: p.previousContract ?? {} });
      }
      onAnswered();
    } catch (err) {
      const e = err as { message?: string };
      setVerdicts((v) => ({ ...v, [p.eventId]: e.message ?? "rejected" }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Lane
      title="Contract review"
      hint="an agent changed its own definition of done — it applied, and it flagged; answer in the log"
    >
      {proposals.map((p) => (
        <div key={p.eventId} className="border-t border-border/50 px-5 py-3 first:border-t-0">
          <div className="flex items-baseline gap-2.5">
            <span className="min-w-[56px] shrink-0 font-mono text-[11.5px] text-secondary-foreground">{p.key}</span>
            <Pill tone="warning">{p.proposedBy.type}</Pill>
            <span className="text-[11.5px] text-muted-foreground">{p.proposedBy.id}</span>
            <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground/70">{p.at.slice(0, 16)}</span>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border border-border/60 px-3 py-2">
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                before (revert target)
              </div>
              {p.previousContract ? (
                contractLines(p.previousContract).map((l, i) => (
                  <div key={i} className="truncate font-mono text-[11px] text-muted-foreground">
                    {l}
                  </div>
                ))
              ) : (
                <div className="text-[11px] text-muted-foreground/70">no contract</div>
              )}
            </div>
            <div className="rounded-md border border-warning-accent/40 px-3 py-2">
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                proposed (now in effect)
              </div>
              {contractLines(p.contract).map((l, i) => (
                <div key={i} className="truncate font-mono text-[11px]">
                  {l}
                </div>
              ))}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" loading={busy === p.eventId} onClick={() => void answer(p, "accept")}>
              Accept
            </Button>
            <Button size="sm" variant="outline" loading={busy === p.eventId} onClick={() => void answer(p, "revert")}>
              Revert
            </Button>
            {verdicts[p.eventId] ? (
              <span className="text-[11.5px] text-destructive">verdict: {verdicts[p.eventId]}</span>
            ) : null}
          </div>
        </div>
      ))}
    </Lane>
  );
}

function ReviewParkedLane({ tasks }: { tasks: WorkTriageResponse["reviewParked"] }) {
  return (
    <Lane
      title="Review-parked"
      hint="merged, but the fold won't call it Done — gates unknown or red (P-7); empties when facts arrive"
    >
      {tasks.map((t) => (
        <Row
          key={t.key}
          left={t.key}
          right={`${t.title} — ${rungLabel(t.lifecycle.rung)}${t.lifecycle.evidence?.[0] ? ` · ${t.lifecycle.evidence[0]}` : ""}`}
        />
      ))}
    </Lane>
  );
}

/* ── Shared lane chrome ── */

function Lane({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="text-[12.5px] font-semibold text-muted-foreground">{title}</span>
        <span className="text-[11.5px] text-muted-foreground/85">{hint}</span>
      </div>
      <ListCard>{children}</ListCard>
    </section>
  );
}

function Row({ left, right, wash }: { left: string; right: string; wash?: boolean }) {
  return (
    <div
      className={`flex items-baseline gap-3 border-t border-border/50 px-5 py-2.5 first:border-t-0 ${wash ? "bg-warning-wash" : ""}`}
    >
      <span className="min-w-[56px] shrink-0 font-mono text-[11.5px] text-secondary-foreground">{left}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{right}</span>
    </div>
  );
}
