"use client";

// The design page (orun-work-v4 WH3): the durable home of "AI proposes,
// humans decide". A design is a doc chain + a structured proposal; the
// proposal preview renders the exact tree adoption would mint (epics →
// milestones → task skeletons). Review verdicts collect on the timeline —
// agents may advise, only humans adopt (V4-2) — and adoption freezes the
// record forever (V4-4).

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { WorkProposalEpic, WorkTimelineEntry } from "@saas/contracts/work";
import {
  Breadcrumbs,
  Kicker,
  ListCard,
  PageHeader,
  Pill,
  Screen,
  type Tone,
} from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { SpecDocSheet } from "@/components/work/spec-doc-sheet";
import { shortDigest } from "@/components/work/hierarchy-chips";

const STATE_TONE: Record<string, Tone> = {
  draft: "neutral",
  in_review: "info",
  adopted: "success",
  superseded: "neutral",
  canceled: "neutral",
};

export function DesignDetail({ orgId, designKey }: { orgId: string; designKey: string }) {
  const { client } = useSession();
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? "";

  const design = useApiQuery(qk.orgWorkDesign(orgId, designKey), () =>
    wrap(async () => client.work.getDesign(orgId, designKey)),
  );
  const timeline = useApiQuery(qk.orgWorkTimeline(orgId, designKey), () =>
    wrap(async () => client.work.timeline(orgId, designKey)),
  );

  const [docOpen, setDocOpen] = React.useState(false);
  const [verdictNote, setVerdictNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string> | null>(null); // null = all

  const reloadAll = () => {
    design.reload();
    timeline.reload();
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setVerdictNote(null);
    try {
      await fn();
      reloadAll();
    } catch (err) {
      const e = err as { message?: string };
      setVerdictNote(e.message ?? "The mutator rejected that.");
    } finally {
      setBusy(false);
    }
  };

  if (design.loading) {
    return (
      <Screen>
        <Skeleton className="mt-8 h-8 w-72" />
        <Skeleton className="mt-6 h-40 w-full" />
      </Screen>
    );
  }
  if (design.error || !design.data) {
    return (
      <Screen>
        <Breadcrumbs
          items={[
            { label: "Work", href: `/orgs/${orgSlug}/work` },
            { label: "Initiatives", href: `/orgs/${orgSlug}/work/initiatives` },
            { label: designKey, mono: true },
          ]}
        />
        <div className="text-[13px] text-muted-foreground">
          {design.error ? `${design.error.code}: ${design.error.message}` : `Unknown design ${designKey}.`}
        </div>
      </Screen>
    );
  }
  const d = design.data;
  const state = d.intent.state;
  const decided = state === "adopted" || state === "superseded" || state === "canceled";
  const epics = d.proposal?.epics ?? [];
  const chosen = (slug: string) => selected === null || selected.has(slug);
  const toggle = (slug: string) => {
    setSelected((cur) => {
      const next = new Set(cur ?? epics.map((e) => e.slug));
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  return (
    <Screen>
      <Breadcrumbs
        items={[
          { label: "Work", href: `/orgs/${orgSlug}/work` },
          { label: "Initiatives", href: `/orgs/${orgSlug}/work/initiatives` },
          {
            label: d.initiative,
            href: `/orgs/${orgSlug}/work/initiatives/${encodeURIComponent(d.initiative)}`,
            mono: true,
          },
          { label: d.title },
        ]}
      />
      <PageHeader
        title={d.title}
        description="A living product + technical specification, sealed against the context it assumed. Adoption mints its proposal into epics — the record freezes here either way."
        actions={
          <div className="flex items-center gap-3">
            <Pill tone={STATE_TONE[state] ?? "neutral"}>
              {state === "in_review" ? "In Review" : state.charAt(0).toUpperCase() + state.slice(1)}
            </Pill>
          </div>
        }
      />

      <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-muted-foreground">
        <span className="font-mono">{d.key}</span>
        <span>
          by {d.createdBy.type === "agent" ? "agent " : ""}
          {d.createdBy.id}
        </span>
        {d.docRef ? <span className="font-mono">doc @{shortDigest(d.docRef)}</span> : null}
        <span className="font-mono" title="What this design assumed: catalog digest + log cursors at creation">
          context coord {d.context.coordSeq} · obs {d.context.obsSeq}
          {d.context.catalog ? ` · catalog @${shortDigest(d.context.catalog)}` : ""}
        </span>
        <button
          type="button"
          onClick={() => setDocOpen(true)}
          className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Document{d.docRef ? "" : " +"}
        </button>
      </div>

      {d.intent.state === "adopted" ? (
        <div className="mt-3 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-[12.5px]">
          Adopted{d.intent.adoptedBy ? ` by ${d.intent.adoptedBy.id}` : ""}
          {d.intent.adoptedRevision ? ` at @${shortDigest(d.intent.adoptedRevision)}` : ""} — minted{" "}
          {(d.intent.minted ?? []).map((k, i) => (
            <React.Fragment key={k}>
              {i > 0 ? ", " : ""}
              <Link href={`/orgs/${orgSlug}/work/epics/${encodeURIComponent(k)}`} className="underline underline-offset-2">
                {k}
              </Link>
            </React.Fragment>
          ))}
          . Adoption is not approval: minted epics start as Drafts.
        </div>
      ) : null}
      {d.intent.state === "superseded" ? (
        <div className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12.5px] text-muted-foreground">
          Superseded{d.intent.supersededBy ? ` by ${d.intent.supersededBy}` : ""}. The record above stays —
          a design is never silently mutated into agreement with what shipped.
        </div>
      ) : null}
      {verdictNote ? (
        <div className="mt-3 rounded-md border border-warning-accent/40 bg-warning/10 px-3 py-2 text-[12.5px]">
          {verdictNote}
        </div>
      ) : null}

      <section className="mt-[30px]">
        <div className="flex flex-wrap items-center gap-3">
          <Kicker>Proposal</Kicker>
          {!decided ? (
            <span className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => client.work.requestReview(orgId, d.key, {}))}
                className="rounded border border-border px-2.5 py-1 text-[12px] text-secondary-foreground hover:bg-muted disabled:opacity-40"
              >
                Request review
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => client.work.submitVerdict(orgId, d.key, { verdict: "approve" }))}
                className="rounded border border-border px-2.5 py-1 text-[12px] text-secondary-foreground hover:bg-muted disabled:opacity-40"
              >
                Looks right
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => client.work.submitVerdict(orgId, d.key, { verdict: "request_changes" }))}
                className="rounded border border-border px-2.5 py-1 text-[12px] text-secondary-foreground hover:bg-muted disabled:opacity-40"
              >
                Request changes
              </button>
              <button
                type="button"
                disabled={busy || epics.length === 0 || (selected !== null && selected.size === 0)}
                onClick={() =>
                  void act(() =>
                    client.work.adoptDesign(orgId, d.key, selected === null ? {} : { epics: [...selected] }),
                  )
                }
                className="rounded bg-primary px-3 py-1 text-[12px] text-primary-foreground disabled:opacity-40"
                title="Human-only: mints the checked epics, their milestone ladders, and task skeletons in one attributed transaction"
              >
                Adopt{selected !== null && selected.size < epics.length ? ` (${selected.size})` : ""}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => client.work.supersedeDesign(orgId, d.key, {}))}
                className="rounded px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted disabled:opacity-40"
              >
                Supersede
              </button>
            </span>
          ) : null}
        </div>
        <p className="mb-2.5 mt-1 text-[12px] text-muted-foreground">
          The exact tree adoption mints. Uncheck epics for a partial adoption; nothing is created until a
          human clicks Adopt.
        </p>
        {epics.length === 0 ? (
          <ListCard>
            <div className="px-5 py-6 text-[13px] text-muted-foreground">
              No structured proposal yet — the document above is the design&apos;s prose half; a proposal
              (epics → milestones → task skeletons) arrives from a design run or an edit.
            </div>
          </ListCard>
        ) : (
          <div className="flex flex-col gap-2.5">
            {epics.map((pe) => (
              <ProposalEpicCard
                key={pe.slug}
                epic={pe}
                checked={chosen(pe.slug)}
                disabled={decided || busy}
                onToggle={() => toggle(pe.slug)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-[30px]">
        <Kicker>Activity</Kicker>
        <div className="mt-2.5">
          <DesignTimeline entries={timeline.data?.entries ?? []} loading={timeline.loading} />
        </div>
      </section>

      <SpecDocSheet
        orgId={orgId}
        specKey={d.key}
        docRef={d.docRef}
        open={docOpen}
        onOpenChange={setDocOpen}
        onMutated={reloadAll}
      />
    </Screen>
  );
}

function ProposalEpicCard({
  epic,
  checked,
  disabled,
  onToggle,
}: {
  epic: WorkProposalEpic;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const skeletonsByMilestone = new Map<string, number>();
  for (const ts of epic.taskSkeletons ?? []) {
    const k = ts.milestone ?? "";
    skeletonsByMilestone.set(k, (skeletonsByMilestone.get(k) ?? 0) + 1);
  }
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <label className="flex items-center gap-2.5">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} className="accent-primary" />
        <span className="font-mono text-[12.5px] font-semibold text-secondary-foreground">{epic.slug}</span>
        <span className="text-[13px] text-secondary-foreground">{epic.title}</span>
        {epic.docSeed ? (
          <span className="font-mono text-[11px] text-muted-foreground">seed @{shortDigest(epic.docSeed)}</span>
        ) : null}
      </label>
      {(epic.milestones ?? []).length > 0 ? (
        <ul className="mt-2.5 flex flex-col gap-1 pl-7">
          {(epic.milestones ?? []).map((m) => (
            <li key={m.key} className="text-[12.5px] text-secondary-foreground">
              <span className="font-mono font-semibold">{m.key}</span> {m.title}
              {m.goal ? <span className="text-muted-foreground"> — {m.goal}</span> : null}
              {skeletonsByMilestone.get(m.key) ? (
                <span className="ml-1.5 text-[11.5px] text-muted-foreground">
                  · {skeletonsByMilestone.get(m.key)} task{skeletonsByMilestone.get(m.key) === 1 ? "" : "s"}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {skeletonsByMilestone.get("") ? (
        <div className="mt-1 pl-7 text-[11.5px] text-muted-foreground">
          + {skeletonsByMilestone.get("")} epic-level task{skeletonsByMilestone.get("") === 1 ? "" : "s"}
        </div>
      ) : null}
    </div>
  );
}

const TIMELINE_LABEL: Record<string, string> = {
  item_created: "created the design",
  doc_edited: "edited the document",
  review_requested: "requested review",
  design_adopted: "adopted the design",
  superseded: "superseded the design",
  comment_added: "commented",
};

function DesignTimeline({ entries, loading }: { entries: WorkTimelineEntry[]; loading: boolean }) {
  if (loading) return <Skeleton className="h-16 w-full" />;
  const events = entries.filter((e) => e.type === "event" && e.event);
  if (events.length === 0) {
    return (
      <ListCard>
        <div className="px-5 py-4 text-[12.5px] text-muted-foreground">No activity yet.</div>
      </ListCard>
    );
  }
  return (
    <ListCard>
      <ul>
        {events.map((entry, i) => {
          const e = entry.event!;
          const payload = (e.payload ?? {}) as { verdict?: string; note?: string; revision?: string; body?: string };
          let label = TIMELINE_LABEL[e.kind] ?? e.kind;
          if (e.kind === "review_submitted") {
            label = payload.verdict === "approve" ? "reviewed: looks right" : "reviewed: requested changes";
          }
          return (
            <li key={e.eventId || i} className="flex flex-wrap items-baseline gap-x-2 border-b border-border/60 px-5 py-2.5 text-[12.5px] last:border-b-0">
              <span className="font-medium text-secondary-foreground">
                {e.actor.type === "agent" ? "agent " : e.actor.type === "automation" ? "automation " : ""}
                {e.actor.id}
              </span>
              <span className="text-muted-foreground">{label}</span>
              {payload.revision ? <span className="font-mono text-[11px] text-muted-foreground">@{shortDigest(payload.revision)}</span> : null}
              {payload.note || payload.body ? (
                <span className="text-muted-foreground">— “{payload.note ?? payload.body}”</span>
              ) : null}
              <span className="ml-auto text-[11px] text-muted-foreground/70">{e.at.slice(0, 16).replace("T", " ")}</span>
            </li>
          );
        })}
      </ul>
    </ListCard>
  );
}
