"use client";

// The epic page (orun-work-v4 WH2, resurfaced by orun-work-v5 WV4 to
// design.md §3.5): the unit a human approves and an agent implements.
// Two chips, two truth sources — the authored intent ladder
// (Approved@revision, drift rendered loud, V4-2/V4-3) beside derived
// execution. The milestone ladder is the page's spine: diamonds on a rail,
// ordered intent (milestone_edited), per-milestone progress that is a fold.
// The drift banner's primary action names the revision it would approve —
// approval is content-addressed all the way into the button label.

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type {
  WorkMilestoneView,
  WorkSpecView,
  WorkTaskView,
} from "@saas/contracts/work";
import {
  Breadcrumbs,
  Kicker,
  ListCard,
  OwnerAvatar,
  Pill,
  Screen,
} from "@/components/ui/northwind";
import { Button } from "@/components/ui/button";
import {
  AgentAvatar,
  MilestoneRail,
  TaskRungMark,
  WorkMeter,
} from "@/components/ui/northwind-work";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { rungLabel } from "@/lib/work/model";
import { meterSegments, milestoneDiamondState } from "@/lib/work/rungs";
import { targetLabel } from "@/lib/work/home";
import { SpecDocSheet } from "@/components/work/spec-doc-sheet";
import { IntentChip, shortDigest } from "@/components/work/hierarchy-chips";
import { TaskPeek } from "@/components/work/work-task-peek";
import { EditWorkItemDialog, type InitiativeOption } from "@/components/work/create-work-item-dialog";

export function EpicDetail({ orgId, epicKey }: { orgId: string; epicKey: string }) {
  const { client } = useSession();
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? "";

  const summary = useApiQuery(qk.orgWork(orgId), () => wrap(async () => client.work.summary(orgId)));
  const [docOpen, setDocOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [verdict, setVerdict] = React.useState<string | null>(null);
  const [peekKey, setPeekKey] = React.useState<string | null>(null);

  const data = summary.data;
  const epic: WorkSpecView | undefined = data?.specs.find((s) => s.key === epicKey);
  const initiativeOptions: InitiativeOption[] = React.useMemo(
    () => (data?.initiatives ?? []).map((i) => ({ key: i.key, title: i.title })),
    [data?.initiatives],
  );
  const tasks = React.useMemo(
    () => (data?.tasks ?? []).filter((t) => t.spec === epicKey),
    [data?.tasks, epicKey],
  );
  const initiativeTitle = data?.initiatives.find((i) => i.key === epic?.initiative)?.title;

  if (summary.loading) {
    return (
      <Screen detail className="max-w-[1140px]">
        <Skeleton className="mt-8 h-8 w-72" />
        <Skeleton className="mt-6 h-40 w-full" />
      </Screen>
    );
  }
  if (!epic) {
    return (
      <Screen detail className="max-w-[1140px]">
        <Breadcrumbs
          items={[
            { label: "Work", href: `/orgs/${orgSlug}/work` },
            { label: epicKey, mono: true },
          ]}
        />
        <div className="text-[13px] text-muted-foreground">Unknown epic {epicKey}.</div>
      </Screen>
    );
  }

  const ladder = epic.milestones ?? [];
  const complete = tasks.filter((t) => t.lifecycle.rung === "done" || t.lifecycle.rung === "released").length;
  const drifted = epic.intent?.state === "approved_drifted";
  const peekTask = peekKey ? tasks.find((t) => t.key === peekKey) : undefined;

  const crumbs: Array<{ label: React.ReactNode; href?: string; mono?: boolean }> = [
    { label: "Work", href: `/orgs/${orgSlug}/work` },
  ];
  if (epic.initiative) {
    crumbs.push({
      label: initiativeTitle ?? epic.initiative,
      href: `/orgs/${orgSlug}/work/initiatives/${encodeURIComponent(epic.initiative)}`,
      ...(initiativeTitle ? {} : { mono: true }),
    });
  }
  crumbs.push({ label: epic.title });

  return (
    <Screen detail className="max-w-[1140px]">
      <Breadcrumbs items={crumbs} className="mb-4" />
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_250px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-serif text-[26px] font-medium leading-tight tracking-[-0.01em]">
              {epic.title}
            </h1>
            <IntentChip intent={epic.intent} />
            {epic.intent?.state !== "canceled" ? (
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Edit
              </button>
            ) : null}
          </div>
          <p className="mt-2 max-w-[560px] text-[13.5px] leading-normal text-muted-foreground">
            The reviewable, executable unit. Approval covers the document and the milestone ladder;
            execution is observed, never asserted.
          </p>

          {drifted ? (
            <DriftBanner
              orgId={orgId}
              epic={epic}
              onReview={() => setDocOpen(true)}
              onMutated={summary.reload}
              onVerdict={setVerdict}
            />
          ) : null}

          <ApprovalPanel
            orgId={orgId}
            epic={epic}
            ladderCount={ladder.length}
            hideApprove={drifted}
            onMutated={summary.reload}
            onVerdict={setVerdict}
          />

          {verdict ? (
            <div className="mt-3 rounded-md border border-warning-accent/40 bg-warning/10 px-3 py-2 text-[12.5px]">
              {verdict}
            </div>
          ) : null}

          <MilestoneLadder
            orgId={orgId}
            orgSlug={orgSlug}
            epicKey={epicKey}
            ladder={ladder}
            tasks={tasks}
            onOpenTask={setPeekKey}
            onMutated={summary.reload}
            onVerdict={setVerdict}
          />

          <UnscheduledSection ladder={ladder} tasks={tasks} onOpenTask={setPeekKey} />
        </div>

        {/* the rail (§3.5): properties · intent · working on it */}
        <aside className="sticky top-6 hidden flex-col gap-[18px] pt-1.5 lg:flex">
          <div>
            <Kicker className="mb-2">Properties</Kicker>
            <div className="flex flex-col gap-[9px] text-[12.5px]">
              <RailRow label="Key">
                <span className="font-mono text-[11.5px] text-secondary-foreground">{epic.key}</span>
              </RailRow>
              {epic.initiative ? (
                <RailRow label="Initiative">
                  <Link
                    href={`/orgs/${orgSlug}/work/initiatives/${encodeURIComponent(epic.initiative)}`}
                    className="font-medium text-secondary-foreground hover:underline"
                  >
                    {initiativeTitle ?? epic.initiative}
                  </Link>
                </RailRow>
              ) : null}
              {epic.targetDate ? (
                <RailRow label="Target">
                  <span className="font-medium">{targetLabel(epic.targetDate, new Date())}</span>
                </RailRow>
              ) : null}
              <RailRow label="Progress">
                <span className="font-medium">
                  {complete}/{tasks.length} tasks
                </span>
              </RailRow>
            </div>
          </div>

          <div className="border-t border-border/70 pt-3.5">
            <Kicker className="mb-2">Intent</Kicker>
            <div className="flex flex-col gap-[9px] text-[12.5px]">
              <RailRow label="State">
                <IntentChip intent={epic.intent} compact />
              </RailRow>
              {epic.intent?.approval?.revision ? (
                <RailRow label="Approved">
                  <span className="font-mono text-[11.5px] text-secondary-foreground">
                    @{shortDigest(epic.intent.approval.revision)}
                    {epic.intent.approval.at ? ` · ${epic.intent.approval.at.slice(0, 10)}` : ""}
                  </span>
                </RailRow>
              ) : null}
              {epic.intent?.approval ? (
                <RailRow label="By">
                  <span className="font-medium">{epic.intent.approval.by.id}</span>
                </RailRow>
              ) : null}
              <RailRow label="Document">
                <button
                  type="button"
                  onClick={() => setDocOpen(true)}
                  className="font-mono text-[11.5px] text-[hsl(var(--link))] hover:underline"
                >
                  spec.md{epic.docRef ? ` @${shortDigest(epic.docRef)}` : " +"}
                </button>
              </RailRow>
            </div>
          </div>

          <WorkingOnIt tasks={tasks} />

          {epic.intent?.state !== "canceled" ? (
            <div className="border-t border-border/70 pt-3.5">
              <Kicker className="mb-2">Danger zone</Kicker>
              <RetireEpicButton
                orgId={orgId}
                epicKey={epicKey}
                onRetired={summary.reload}
                onVerdict={setVerdict}
              />
            </div>
          ) : null}
        </aside>
      </div>

      <EditWorkItemDialog
        orgId={orgId}
        itemKey={epicKey}
        currentTitle={epic.title}
        currentTargetDate={epic.targetDate}
        currentInitiative={epic.initiative}
        withTargetDate
        initiativeOptions={initiativeOptions}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={summary.reload}
      />

      <SpecDocSheet
        orgId={orgId}
        specKey={epicKey}
        docRef={epic.docRef}
        open={docOpen}
        onOpenChange={setDocOpen}
        onMutated={summary.reload}
      />
      {peekTask ? (
        <TaskPeek
          orgId={orgId}
          orgSlug={orgSlug}
          task={peekTask}
          spec={epic}
          onClose={() => setPeekKey(null)}
          onMutated={summary.reload}
        />
      ) : null}
    </Screen>
  );
}

function RailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

/** Retire an epic — cancel is the model's native "delete": a terminal,
 *  attributed, append-only intent, never a row removal (§ append-only). It is
 *  effectively permanent, so it asks once before it writes. */
function RetireEpicButton({
  orgId,
  epicKey,
  onRetired,
  onVerdict,
}: {
  orgId: string;
  epicKey: string;
  onRetired: () => void;
  onVerdict: (v: string | null) => void;
}) {
  const { client } = useSession();
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  if (!confirming) {
    return (
      <div>
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          Retire epic
        </Button>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          Moves the epic to <span className="font-medium">Canceled</span>. Nothing is deleted — the record
          and its history stay; agents stop picking up its work.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] leading-snug text-[hsl(var(--warning-ink))]">
        Retire this epic? This is terminal — it cannot be un-canceled.
      </p>
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          loading={busy}
          onClick={() => {
            setBusy(true);
            onVerdict(null);
            void client.work
              .cancelItem(orgId, epicKey)
              .then(() => {
                setConfirming(false);
                onRetired();
              })
              .catch((err: { message?: string }) => onVerdict(err.message ?? "The mutator rejected that."))
              .finally(() => setBusy(false));
          }}
        >
          Retire
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
          Keep
        </Button>
      </div>
    </div>
  );
}

/** Who is actually on it — folded from task assignees; humans round,
 *  agents square-star, at equal rank (V5-F). */
function WorkingOnIt({ tasks }: { tasks: WorkTaskView[] }) {
  const subjects = new Set<string>();
  for (const t of tasks) {
    if (t.lifecycle.rung === "in_progress" || t.lifecycle.rung === "in_review") {
      for (const a of t.assignees ?? []) subjects.add(a);
    }
  }
  if (subjects.size === 0) return null;
  const all = [...subjects];
  const agents = all.filter((s) => s.startsWith("sp_"));
  const humans = all.filter((s) => !s.startsWith("sp_"));
  return (
    <div className="border-t border-border/70 pt-3.5">
      <Kicker className="mb-2">Working on it</Kicker>
      <div className="flex items-center gap-2 text-[12.5px]">
        {humans.slice(0, 4).map((s) => (
          <OwnerAvatar key={s} name={s.replace(/^usr_/, "")} size={18} />
        ))}
        {agents.slice(0, 3).map((s) => (
          <AgentAvatar key={s} title={s} />
        ))}
        <span className="text-[11.5px] text-muted-foreground/85">
          {humans.length > 0 ? `${humans.length} human${humans.length === 1 ? "" : "s"}` : ""}
          {humans.length > 0 && agents.length > 0 ? " · " : ""}
          {agents.length > 0 ? `${agents.length} agent${agents.length === 1 ? "" : "s"}` : ""}
        </span>
      </div>
    </div>
  );
}

/* ── The drift banner (§3.5) ──────────────────────────────────────────── */

function DriftBanner({
  orgId,
  epic,
  onReview,
  onMutated,
  onVerdict,
}: {
  orgId: string;
  epic: WorkSpecView;
  onReview: () => void;
  onMutated: () => void;
  onVerdict: (v: string | null) => void;
}) {
  const { client } = useSession();
  const [busy, setBusy] = React.useState(false);
  const approvedRev = epic.intent?.approval?.revision;
  const currentRev = epic.intent?.currentRevision ?? epic.docRef;
  const what = epic.intent?.docDrifted
    ? `the document is now @${shortDigest(currentRev)}`
    : "the milestone ladder changed";
  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-3 rounded-[10px] border border-[hsl(var(--warning-border))] bg-warning-wash px-4 py-3">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="hsl(var(--warning))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <line x1="12" x2="12" y1="9" y2="13" />
        <line x1="12" x2="12.01" y1="17" y2="17" />
      </svg>
      <span className="min-w-[220px] flex-1 text-[12.5px] leading-normal text-[hsl(var(--warning-ink))]">
        Approved at <span className="font-mono text-[11.5px]">@{shortDigest(approvedRev)}</span> — {what}.
        Re-approval required before agents pick up new tasks.
      </span>
      <span className="flex gap-2">
        <button
          type="button"
          onClick={onReview}
          className="rounded-lg border border-[hsl(var(--warning-border))] bg-card px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          Review changes
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onVerdict(null);
            void client.work
              .approve(orgId, epic.key, { revision: epic.docRef })
              .then(() => onMutated())
              .catch((err: { message?: string }) => onVerdict(err.message ?? "The mutator rejected that."))
              .finally(() => setBusy(false));
          }}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
        >
          Re-approve {currentRev ? `@${shortDigest(currentRev)}` : ""}
        </button>
      </span>
    </div>
  );
}

/* ── The approval panel (WH4): review → verdicts → the human decision ── */

function ApprovalPanel({
  orgId,
  epic,
  ladderCount,
  hideApprove = false,
  onMutated,
  onVerdict,
}: {
  orgId: string;
  epic: WorkSpecView;
  ladderCount: number;
  /** When the drift banner owns Re-approve, the panel keeps only reviews. */
  hideApprove?: boolean;
  onMutated: () => void;
  onVerdict: (v: string | null) => void;
}) {
  const { client } = useSession();
  const [busy, setBusy] = React.useState(false);
  const [sealedId, setSealedId] = React.useState<string | null>(null);
  const state = epic.intent?.state ?? "draft";
  const approvable = state !== "canceled";
  const blockReason =
    ladderCount === 0
      ? "An epic cannot be approved without a milestone ladder — you approve the doc AND the plan (V4-2)."
      : null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onVerdict(null);
    try {
      await fn();
      onMutated();
    } catch (err) {
      const e = err as { message?: string };
      onVerdict(e.message ?? "The mutator rejected that.");
    } finally {
      setBusy(false);
    }
  };

  if (!approvable) return null;
  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-2.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Review</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void act(() => client.work.requestReview(orgId, epic.key, { revision: epic.docRef }))}
        className="rounded-lg border border-border px-2.5 py-1 text-[12px] text-secondary-foreground hover:bg-muted disabled:opacity-40"
      >
        Request review
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void act(() => client.work.submitVerdict(orgId, epic.key, { verdict: "approve", revision: epic.docRef }))}
        className="rounded-lg border border-border px-2.5 py-1 text-[12px] text-secondary-foreground hover:bg-muted disabled:opacity-40"
      >
        Looks right
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void act(() => client.work.submitVerdict(orgId, epic.key, { verdict: "request_changes", revision: epic.docRef }))}
        className="rounded-lg border border-border px-2.5 py-1 text-[12px] text-secondary-foreground hover:bg-muted disabled:opacity-40"
      >
        Request changes
      </button>
      {!hideApprove ? (
        <>
          <span className="mx-1 text-foreground/20">·</span>
          {state === "approved" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => client.work.revokeApproval(orgId, epic.key, {}))}
              className="rounded-lg border border-border px-2.5 py-1 text-[12px] text-secondary-foreground hover:bg-muted disabled:opacity-40"
            >
              Revoke approval
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || blockReason !== null}
              title={blockReason ?? "Human-only: seals the frozen brief (epic@hash) an agent implements against"}
              onClick={() =>
                void act(async () => {
                  const out = await client.work.approve(orgId, epic.key, { revision: epic.docRef });
                  setSealedId(out.snapshot);
                })
              }
              className="rounded-lg bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground disabled:opacity-40"
            >
              Approve{epic.docRef ? ` @${shortDigest(epic.docRef)}` : ""}
            </button>
          )}
        </>
      ) : null}
      {blockReason ? <span className="text-[11.5px] text-muted-foreground">{blockReason}</span> : null}
      {sealedId ? (
        <span className="text-[11.5px] text-muted-foreground">
          sealed <span className="font-mono">{sealedId.slice(0, 14)}…</span> — the frozen brief
        </span>
      ) : null}
    </div>
  );
}

/* ── The milestone ladder: diamonds on a rail (§3.5) ─────────────────── */

function MilestoneLadder({
  orgId,
  orgSlug,
  epicKey,
  ladder,
  tasks,
  onOpenTask,
  onMutated,
  onVerdict,
}: {
  orgId: string;
  orgSlug: string;
  epicKey: string;
  ladder: WorkMilestoneView[];
  tasks: WorkTaskView[];
  onOpenTask: (key: string) => void;
  onMutated: () => void;
  onVerdict: (v: string | null) => void;
}) {
  const { client } = useSession();
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onVerdict(null);
    try {
      await fn();
      onMutated();
    } catch (err) {
      const e = err as { message?: string };
      onVerdict(e.message ?? "The mutator rejected that change.");
    } finally {
      setBusy(false);
    }
  };

  const move = (m: WorkMilestoneView, dir: -1 | 1) => {
    const idx = ladder.findIndex((x) => x.key === m.key);
    const swap = ladder[idx + dir];
    if (!swap) return;
    void act(async () => {
      await client.work.editMilestone(orgId, epicKey, { op: "reorder", key: m.key, ordinal: swap.ordinal });
      await client.work.editMilestone(orgId, epicKey, { op: "reorder", key: swap.key, ordinal: m.ordinal });
    });
  };

  return (
    <section className="mt-[30px]">
      <div className="mb-3.5 flex items-center gap-3">
        <Kicker>Milestone ladder</Kicker>
        <button
          type="button"
          disabled={busy}
          onClick={() => setAdding(true)}
          className="rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          + Add
        </button>
      </div>
      {ladder.length === 0 && !adding ? (
        <ListCard>
          <div className="px-5 py-6 text-[13px] text-muted-foreground">
            No milestones yet. The ladder is what approval covers — an epic cannot be approved without one
            (you approve the doc AND the plan).
          </div>
        </ListCard>
      ) : (
        <div>
          {ladder.map((m, i) => (
            <MilestoneRung
              key={m.key}
              m={m}
              orgSlug={orgSlug}
              epicKey={epicKey}
              tasks={tasks.filter((t) => t.milestone === m.key)}
              first={i === 0}
              last={i === ladder.length - 1 && !adding}
              busy={busy}
              onOpenTask={onOpenTask}
              onMoveUp={() => move(m, -1)}
              onMoveDown={() => move(m, 1)}
              onRemove={() =>
                void act(async () => client.work.editMilestone(orgId, epicKey, { op: "remove", key: m.key }))
              }
            />
          ))}
        </div>
      )}
      {adding ? (
        <AddMilestoneForm
          existing={ladder.map((m) => m.key)}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={(fields) =>
            void act(async () => {
              await client.work.editMilestone(orgId, epicKey, { op: "create", ...fields });
              setAdding(false);
            })
          }
        />
      ) : null}
    </section>
  );
}

function MilestoneRung({
  m,
  orgSlug,
  epicKey,
  tasks,
  first,
  last,
  busy,
  onOpenTask,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  m: WorkMilestoneView;
  orgSlug: string;
  epicKey: string;
  tasks: WorkTaskView[];
  first: boolean;
  last: boolean;
  busy: boolean;
  onOpenTask: (key: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const total = m.total ?? tasks.length;
  const complete =
    m.complete ?? tasks.filter((t) => t.lifecycle.rung === "done" || t.lifecycle.rung === "released").length;
  const counts = m.progress ?? {};
  const state = milestoneDiamondState(counts, total);
  const seg = meterSegments(counts, total);
  // Complete milestones fold shut; the active ladder stays open (§3.5).
  const [open, setOpen] = React.useState(state !== "complete");

  const chip =
    state === "complete" ? (
      <Pill tone="success">Complete</Pill>
    ) : state === "active" ? (
      <Pill tone="warning">Active{m.targetDate ? ` · target ${targetLabel(m.targetDate, new Date())}` : ""}</Pill>
    ) : (
      <Pill tone="neutral">Upcoming{m.targetDate ? ` · target ${targetLabel(m.targetDate, new Date())}` : ""}</Pill>
    );

  return (
    <MilestoneRail state={state} last={last}>
      <div className="group/ms flex cursor-pointer select-none flex-wrap items-center gap-2.5" onClick={() => setOpen(!open)}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="hsl(var(--work-idle))"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 transition-transform duration-150"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        <Link
          href={`/orgs/${orgSlug}/work/epics/${encodeURIComponent(epicKey)}/milestones/${encodeURIComponent(m.key)}`}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-[11px] text-muted-foreground/85 hover:text-foreground"
        >
          {m.key}
        </Link>
        <span className="text-[13.5px] font-semibold">{m.title}</span>
        {chip}
        <span className="ml-auto flex items-center gap-2">
          <WorkMeter donePct={seg.donePct} activePct={seg.activePct} width={70} />
          <span className="text-[11.5px] tabular-nums text-muted-foreground">
            {complete}/{total}
          </span>
          <span
            className="flex shrink-0 items-center gap-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/ms:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" disabled={busy || first} onClick={onMoveUp} title="Move up" className="rounded px-1 hover:bg-muted disabled:opacity-30">↑</button>
            <button type="button" disabled={busy || last} onClick={onMoveDown} title="Move down" className="rounded px-1 hover:bg-muted disabled:opacity-30">↓</button>
            <button type="button" disabled={busy} onClick={onRemove} title="Remove (blocked while tasks are open)" className="rounded px-1 hover:bg-muted disabled:opacity-30">×</button>
          </span>
        </span>
      </div>
      {m.goal && open ? <div className="mt-1 pl-[22px] text-[12px] text-muted-foreground">{m.goal}</div> : null}
      {open && tasks.length > 0 ? (
        <div className="mt-2.5">
          <MilestoneTaskList tasks={tasks} onOpenTask={onOpenTask} />
        </div>
      ) : null}
    </MilestoneRail>
  );
}

/** Dense task rows inside a milestone (or the unscheduled shelf) — the v5
 *  grammar: derived glyph · key · title · pin badge · rung chip. Click
 *  opens the peek (§3.6). */
function MilestoneTaskList({
  tasks,
  onOpenTask,
}: {
  tasks: WorkTaskView[];
  onOpenTask: (key: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-[10px] border bg-card">
      {tasks.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onOpenTask(t.key)}
          className="flex w-full items-center gap-3 border-t border-border/50 px-4 py-2 text-left transition-colors duration-100 first:border-t-0 hover:bg-muted/60"
        >
          <TaskRungMark lifecycle={t.lifecycle} />
          <span className="w-[46px] shrink-0 font-mono text-[11.5px] text-muted-foreground/85">{t.key}</span>
          <span className="min-w-0 flex-1 truncate text-[13px]">{t.title}</span>
          {t.lifecycle.blocked ? <Pill tone="error">blocked</Pill> : null}
          <Pill tone="neutral" className="hidden sm:inline-flex">
            {rungLabel(t.lifecycle.rung)}
          </Pill>
          {t.assignees?.length ? (
            t.assignees[0]!.startsWith("sp_") ? (
              <AgentAvatar title={t.assignees[0]} />
            ) : (
              <OwnerAvatar name={t.assignees[0]!.replace(/^usr_/, "")} size={18} />
            )
          ) : (
            <OwnerAvatar name="?" unowned size={18} />
          )}
        </button>
      ))}
    </div>
  );
}

function AddMilestoneForm({
  existing,
  busy,
  onCancel,
  onSubmit,
}: {
  existing: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (fields: { key: string; title: string; goal?: string; targetDate?: string }) => void;
}) {
  const [key, setKey] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [goal, setGoal] = React.useState("");
  const [targetDate, setTargetDate] = React.useState("");
  const keyTaken = existing.includes(key);
  const valid = /^[A-Z]{1,6}[0-9]{1,3}[a-z]?$/.test(key) && title.trim().length > 0 && !keyTaken;
  return (
    <form
      className="mt-2.5 flex flex-wrap items-end gap-2 rounded-[10px] border border-dashed border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit({ key, title: title.trim(), ...(goal.trim() ? { goal: goal.trim() } : {}), ...(targetDate ? { targetDate } : {}) });
      }}
    >
      <label className="flex flex-col text-[11px] uppercase tracking-wide text-muted-foreground">
        Key
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="M1" className="mt-1 w-20 rounded border border-border bg-background px-2 py-1 font-mono text-[12.5px] text-foreground" />
      </label>
      <label className="flex min-w-48 flex-1 flex-col text-[11px] uppercase tracking-wide text-muted-foreground">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Foundation" className="mt-1 rounded border border-border bg-background px-2 py-1 text-[12.5px] text-foreground" />
      </label>
      <label className="flex min-w-48 flex-1 flex-col text-[11px] uppercase tracking-wide text-muted-foreground">
        Goal
        <input value={goal} onChange={(e) => setGoal(e.target.value)} className="mt-1 rounded border border-border bg-background px-2 py-1 text-[12.5px] text-foreground" />
      </label>
      <label className="flex flex-col text-[11px] uppercase tracking-wide text-muted-foreground">
        Target
        <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="mt-1 rounded border border-border bg-background px-2 py-1 text-[12.5px] text-foreground" />
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={!valid || busy} className="rounded-lg bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-40">
          Add milestone
        </button>
        <button type="button" onClick={onCancel} className="rounded px-2 py-1.5 text-[12.5px] text-muted-foreground hover:bg-muted">
          Cancel
        </button>
      </div>
      {keyTaken ? <div className="w-full text-[11.5px] text-warning-accent">Key {key} already exists — milestone keys are immutable.</div> : null}
    </form>
  );
}

/* ── Task rows (shared by the milestone page) ────────────────────────── */

export function HierarchyTaskList({ tasks, emptyText }: { tasks: WorkTaskView[]; emptyText: string }) {
  if (tasks.length === 0) {
    return (
      <ListCard>
        <div className="px-5 py-4 text-[12.5px] text-muted-foreground">{emptyText}</div>
      </ListCard>
    );
  }
  return (
    <ListCard>
      <ul>
        {tasks.map((t) => (
          <li key={t.key} className="flex w-full items-center gap-3 border-t border-border/50 px-5 py-2.5 first:border-t-0">
            <TaskRungMark lifecycle={t.lifecycle} />
            <span className="font-mono text-[12px] text-muted-foreground">{t.key}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-secondary-foreground">{t.title}</span>
            {t.lifecycle.blocked ? <Pill tone="error">blocked</Pill> : null}
            <span title={t.lifecycle.evidence?.join(" · ")}>
              <Pill tone="neutral">{rungLabel(t.lifecycle.rung)}</Pill>
            </span>
          </li>
        ))}
      </ul>
    </ListCard>
  );
}

function UnscheduledSection({
  ladder,
  tasks,
  onOpenTask,
}: {
  ladder: WorkMilestoneView[];
  tasks: WorkTaskView[];
  onOpenTask: (key: string) => void;
}) {
  const keys = new Set(ladder.map((m) => m.key));
  const unscheduled = tasks.filter((t) => !t.milestone || !keys.has(t.milestone));
  if (unscheduled.length === 0) return null;
  return (
    <section className="mt-[30px]">
      <Kicker>Unscheduled</Kicker>
      <p className="mb-2.5 mt-1 text-[12px] text-muted-foreground">
        Tasks in this epic that no milestone claims — epic-level work until a milestone takes them.
      </p>
      <MilestoneTaskList tasks={unscheduled} onOpenTask={onOpenTask} />
    </section>
  );
}
