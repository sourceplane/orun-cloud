"use client";

// The epic page (orun-work-v4 WH2): the unit a human approves and an agent
// implements. Two chips, two truth sources — the authored intent ladder
// (Approved@revision, drift rendered loud, V4-2/V4-3) beside derived
// execution. The milestone ladder is the page's spine: ordered, editable
// intent (milestone_edited), with per-milestone progress that is a fold.

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
  ListRow,
  PageHeader,
  Pill,
  Screen,
} from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { rungBadgeVariant, rungLabel } from "@/lib/work/model";
import { Badge } from "@/components/ui/badge";
import { SpecDocSheet } from "@/components/work/spec-doc-sheet";
import { IntentChip, ProgressBar } from "@/components/work/hierarchy-chips";

export function EpicDetail({ orgId, epicKey }: { orgId: string; epicKey: string }) {
  const { client } = useSession();
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? "";

  const summary = useApiQuery(qk.orgWork(orgId), () => wrap(async () => client.work.summary(orgId)));
  const [docOpen, setDocOpen] = React.useState(false);
  const [verdict, setVerdict] = React.useState<string | null>(null);

  const data = summary.data;
  const epic: WorkSpecView | undefined = data?.specs.find((s) => s.key === epicKey);
  const tasks = (data?.tasks ?? []).filter((t) => t.spec === epicKey);

  if (summary.loading) {
    return (
      <Screen>
        <Skeleton className="mt-8 h-8 w-72" />
        <Skeleton className="mt-6 h-40 w-full" />
      </Screen>
    );
  }
  if (!epic) {
    return (
      <Screen>
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

  const crumbs: Array<{ label: React.ReactNode; href?: string; mono?: boolean }> = [
    { label: "Work", href: `/orgs/${orgSlug}/work` },
  ];
  if (epic.initiative) {
    crumbs.push({
      label: epic.initiative,
      href: `/orgs/${orgSlug}/work/initiatives/${encodeURIComponent(epic.initiative)}`,
      mono: true,
    });
  }
  crumbs.push({ label: epic.title });

  return (
    <Screen>
      <Breadcrumbs items={crumbs} />
      <PageHeader
        title={epic.title}
        description="The reviewable, executable unit. Approval covers the document AND the milestone ladder; execution is observed, never asserted."
        actions={
          <div className="flex items-center gap-4">
            <IntentChip intent={epic.intent} />
            <span className="text-[12.5px] text-muted-foreground">
              {complete}/{tasks.length} complete
            </span>
          </div>
        }
      />

      <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-muted-foreground">
        <span className="font-mono">{epic.key}</span>
        {epic.targetDate ? <span>target {epic.targetDate}</span> : null}
        <button
          type="button"
          onClick={() => setDocOpen(true)}
          className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Document{epic.docRef ? "" : " +"}
        </button>
      </div>

      <ApprovalPanel
        orgId={orgId}
        epic={epic}
        ladderCount={ladder.length}
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
        onMutated={summary.reload}
        onVerdict={setVerdict}
      />

      <UnscheduledSection orgSlug={orgSlug} ladder={ladder} tasks={tasks} />

      <SpecDocSheet
        orgId={orgId}
        specKey={epicKey}
        docRef={epic.docRef}
        open={docOpen}
        onOpenChange={setDocOpen}
        onMutated={summary.reload}
      />
    </Screen>
  );
}

/* ── The approval panel (WH4): review → verdicts → the human decision ── */
//
// Approve is disabled-with-reason BEFORE the click (the verdict text the
// mutator would return); a stale revision still 409s server-side. Approval
// seals the EpicSnapshot in the same transaction — the sealed id renders
// here because the approval IS the dispatch artifact.

function ApprovalPanel({
  orgId,
  epic,
  ladderCount,
  onMutated,
  onVerdict,
}: {
  orgId: string;
  epic: WorkSpecView;
  ladderCount: number;
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
    <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-4 py-3">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Review</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void act(() => client.work.requestReview(orgId, epic.key, { revision: epic.docRef }))}
        className="rounded border border-border px-2.5 py-1 text-[12px] text-secondary-foreground hover:bg-muted disabled:opacity-40"
      >
        Request review
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void act(() => client.work.submitVerdict(orgId, epic.key, { verdict: "approve", revision: epic.docRef }))}
        className="rounded border border-border px-2.5 py-1 text-[12px] text-secondary-foreground hover:bg-muted disabled:opacity-40"
      >
        Looks right
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void act(() => client.work.submitVerdict(orgId, epic.key, { verdict: "request_changes", revision: epic.docRef }))}
        className="rounded border border-border px-2.5 py-1 text-[12px] text-secondary-foreground hover:bg-muted disabled:opacity-40"
      >
        Request changes
      </button>
      <span className="mx-1 text-foreground/20">·</span>
      {state === "approved" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => client.work.revokeApproval(orgId, epic.key, {}))}
          className="rounded border border-border px-2.5 py-1 text-[12px] text-secondary-foreground hover:bg-muted disabled:opacity-40"
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
          className="rounded bg-primary px-3 py-1 text-[12px] text-primary-foreground disabled:opacity-40"
        >
          {state === "approved_drifted" ? "Re-approve" : "Approve"}
        </button>
      )}
      {blockReason ? <span className="text-[11.5px] text-muted-foreground">{blockReason}</span> : null}
      {sealedId ? (
        <span className="text-[11.5px] text-muted-foreground">
          sealed <span className="font-mono">{sealedId.slice(0, 14)}…</span> — the frozen brief
        </span>
      ) : null}
    </div>
  );
}

/* ── The milestone ladder: ordered intent, derived progress ─────────── */

function MilestoneLadder({
  orgId,
  orgSlug,
  epicKey,
  ladder,
  tasks,
  onMutated,
  onVerdict,
}: {
  orgId: string;
  orgSlug: string;
  epicKey: string;
  ladder: WorkMilestoneView[];
  tasks: WorkTaskView[];
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
      <div className="flex items-center gap-3">
        <Kicker>Milestones</Kicker>
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
        <ListCard className="mt-2.5">
          <div className="px-5 py-6 text-[13px] text-muted-foreground">
            No milestones yet. The ladder is what approval covers — an epic cannot be approved without one
            (you approve the doc AND the plan).
          </div>
        </ListCard>
      ) : (
        <div className="mt-2.5 flex flex-col gap-2">
          {ladder.map((m, i) => (
            <MilestoneRow
              key={m.key}
              m={m}
              orgSlug={orgSlug}
              epicKey={epicKey}
              tasks={tasks.filter((t) => t.milestone === m.key)}
              first={i === 0}
              last={i === ladder.length - 1}
              busy={busy}
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

function MilestoneRow({
  m,
  orgSlug,
  epicKey,
  tasks,
  first,
  last,
  busy,
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
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const total = m.total ?? tasks.length;
  const complete = m.complete ?? tasks.filter((t) => t.lifecycle.rung === "done" || t.lifecycle.rung === "released").length;
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-3">
        <Link
          href={`/orgs/${orgSlug}/work/epics/${encodeURIComponent(epicKey)}/milestones/${encodeURIComponent(m.key)}`}
          className="min-w-0 flex-1"
        >
          <span className="font-mono text-[12.5px] font-semibold text-secondary-foreground">{m.key}</span>
          <span className="ml-2 text-[13px] text-secondary-foreground">{m.title}</span>
          {m.targetDate ? <span className="ml-2 text-[11.5px] text-muted-foreground">target {m.targetDate}</span> : null}
          {m.goal ? <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{m.goal}</div> : null}
        </Link>
        <span className="text-[11.5px] text-muted-foreground">
          {complete}/{total}
        </span>
        <ProgressBar counts={m.progress} total={total} />
        <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
          <button type="button" disabled={busy || first} onClick={onMoveUp} title="Move up" className="rounded px-1 hover:bg-muted disabled:opacity-30">↑</button>
          <button type="button" disabled={busy || last} onClick={onMoveDown} title="Move down" className="rounded px-1 hover:bg-muted disabled:opacity-30">↓</button>
          <button type="button" disabled={busy} onClick={onRemove} title="Remove (blocked while tasks are open)" className="rounded px-1 hover:bg-muted disabled:opacity-30">×</button>
        </span>
      </div>
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
      className="mt-2.5 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-border p-3"
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
        <button type="submit" disabled={!valid || busy} className="rounded bg-primary px-3 py-1.5 text-[12.5px] text-primary-foreground disabled:opacity-40">
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

/* ── Task rows (shared by epic + milestone pages) ────────────────────── */

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
          <ListRow key={t.key}>
            <div className="flex w-full items-center gap-3 px-5 py-3">
              <span className="font-mono text-[12px] text-muted-foreground">{t.key}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-secondary-foreground">{t.title}</span>
              {t.lifecycle.blocked ? <Pill tone="warning">blocked</Pill> : null}
              {t.lifecycle.pinned ? (
                <span title={`pinned by ${t.lifecycle.pinned.by.id}`}>
                  <Pill tone="info">pin: {rungLabel(t.lifecycle.pinned.rung)}</Pill>
                </span>
              ) : null}
              <span title={t.lifecycle.evidence?.join(" · ")}>
                <Badge variant={rungBadgeVariant(t.lifecycle.rung)}>{rungLabel(t.lifecycle.rung)}</Badge>
              </span>
            </div>
          </ListRow>
        ))}
      </ul>
    </ListCard>
  );
}

function UnscheduledSection({
  orgSlug,
  ladder,
  tasks,
}: {
  orgSlug: string;
  ladder: WorkMilestoneView[];
  tasks: WorkTaskView[];
}) {
  const keys = new Set(ladder.map((m) => m.key));
  const unscheduled = tasks.filter((t) => !t.milestone || !keys.has(t.milestone));
  if (unscheduled.length === 0) return null;
  return (
    <section className="mt-[30px]">
      <Kicker>Unscheduled</Kicker>
      <p className="mb-2.5 mt-1 text-[12px] text-muted-foreground">
        Tasks in this epic that no milestone claims — move them from the{" "}
        <Link href={`/orgs/${orgSlug}/work`} className="underline underline-offset-2">
          Work board
        </Link>{" "}
        or leave them as epic-level work.
      </p>
      <HierarchyTaskList tasks={unscheduled} emptyText="" />
    </section>
  );
}
