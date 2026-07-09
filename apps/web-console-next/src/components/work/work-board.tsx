"use client";

// The kanban board (orun-work-v3 PM2). Columns are RUNGS — the fold's
// output, never a stored layout. The honest drag semantics (the epic's
// spine):
//   * drop on ANOTHER column  → mints a PIN: a public, attributed override
//     rendered beside observed truth, auto-expiring when facts catch up.
//     The note affordance ships with the drop dialog.
//   * drop back on the fold's own column → clears the pin (facts are there).
//   * drop on the SAME column → appends `ordered` — pure backlog intent.
//   * a rejected drop renders the mutator's 422 verdict inline on the card.
// Nothing in this file writes a rung; the category is unrepresentable.

import * as React from "react";
import type { WorkCycleView, WorkPriority, WorkRung, WorkTaskView } from "@saas/contracts/work";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/northwind";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { rungLabel } from "@/lib/work/model";
import { boardColumns, dropIntent, PRIORITY_OPTIONS } from "@/lib/work/board";
import type { TaskPatch } from "@/lib/work/optimistic";

const BOARD_VIEW = "board"; // the `ordered` event's view namespace

/** PM4: the optimistic runner — apply the patch locally, confirm on the
 *  mutation's seq, roll back on a verdict. Optional so the board still
 *  works standalone (mutations just wait for the SSE refetch). */
export type ApplyIntent = (key: string, patch: TaskPatch, call: () => Promise<{ seq: number }>) => Promise<void>;

export function WorkBoard({
  orgId,
  tasks,
  cycles = [],
  applyIntent,
  onMutated,
}: {
  orgId: string;
  tasks: WorkTaskView[];
  cycles?: WorkCycleView[];
  applyIntent?: ApplyIntent | undefined;
  onMutated: () => void;
}) {
  const { client } = useSession();
  const [verdicts, setVerdicts] = React.useState<Record<string, string>>({});
  const [pinDraft, setPinDraft] = React.useState<{ task: WorkTaskView; rung: WorkRung } | null>(null);
  const [dragOver, setDragOver] = React.useState<WorkRung | null>(null);

  const columns = boardColumns(tasks);
  const byKey = new Map(tasks.map((t) => [t.key, t]));

  const setVerdict = (key: string, message: string | null) =>
    setVerdicts((v) => {
      const next = { ...v };
      if (message === null) delete next[key];
      else next[key] = message;
      return next;
    });

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setVerdict(key, null);
    try {
      await fn();
      onMutated();
    } catch (err) {
      const e = err as { message?: string };
      setVerdict(key, e.message ?? "rejected");
    }
  };

  const handleDrop = (rung: WorkRung) => (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(null);
    const key = event.dataTransfer.getData("text/work-task");
    const task = key ? byKey.get(key) : undefined;
    if (!task) return;
    const intent = dropIntent(task, rung);
    if (intent.kind === "order") {
      // Same column: backlog ordering — position = index the card lands at
      // (tail for a plain column drop). Pure intent, no ceremony.
      const column = columns.find((c) => c.rung === rung);
      void run(key, () => client.work.order(orgId, key, { view: BOARD_VIEW, order: column?.tasks.length ?? 0 }));
    } else if (intent.kind === "unpin") {
      void run(key, () => client.work.pin(orgId, key, { rung: null }));
    } else {
      // Cross-column: an honest gesture needs an author — open the pin
      // dialog with its note affordance instead of pretending it moved.
      setPinDraft({ task, rung: intent.rung });
    }
  };

  return (
    <div className="mt-[30px] overflow-x-auto pb-2">
      <div className="flex min-w-max gap-3">
        {columns.map(({ rung, tasks: cards }) => (
          <section
            key={rung}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(rung);
            }}
            onDragLeave={() => setDragOver((r) => (r === rung ? null : r))}
            onDrop={handleDrop(rung)}
            className={cn(
              "w-[248px] shrink-0 rounded-xl border bg-card/60 px-2 pb-2 pt-2.5 transition-colors",
              dragOver === rung && "border-foreground/30 bg-muted/70",
            )}
          >
            <div className="mb-2 flex items-baseline gap-2 px-1.5">
              <span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                {rungLabel(rung)}
              </span>
              <span className="text-[11px] text-muted-foreground/70">{cards.length}</span>
            </div>
            <ul className="flex min-h-[40px] flex-col gap-1.5">
              {cards.map((task) => (
                <BoardCard
                  key={task.key}
                  orgId={orgId}
                  task={task}
                  cycles={cycles}
                  verdict={verdicts[task.key]}
                  onRun={run}
                  applyIntent={applyIntent}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {pinDraft ? (
        <PinDropDialog
          orgId={orgId}
          task={pinDraft.task}
          rung={pinDraft.rung}
          onClose={() => setPinDraft(null)}
          onRun={run}
        />
      ) : null}
    </div>
  );
}

/* ── Cards ─────────────────────────────────────────────────────── */

const PRIORITY_TONE: Record<WorkPriority, string> = {
  urgent: "text-destructive",
  high: "text-warning-accent",
  medium: "text-foreground",
  low: "text-muted-foreground",
  none: "text-muted-foreground/60",
};

const ESTIMATE_OPTIONS = [1, 2, 3, 5, 8, 13];

function BoardCard({
  orgId,
  task,
  cycles,
  verdict,
  onRun,
  applyIntent,
}: {
  orgId: string;
  task: WorkTaskView;
  cycles: WorkCycleView[];
  verdict: string | undefined;
  onRun: (key: string, fn: () => Promise<unknown>) => Promise<void>;
  applyIntent?: ApplyIntent | undefined;
}) {
  const { client } = useSession();
  const lc = task.lifecycle;
  const [labelOpen, setLabelOpen] = React.useState(false);
  const [labelDraft, setLabelDraft] = React.useState("");

  // With the optimistic store the patch renders before the wire answers;
  // without it the call just waits for the SSE refetch. Verdict handling is
  // onRun's either way.
  const intent = (patch: TaskPatch, call: () => Promise<{ seq: number }>) => () =>
    applyIntent ? applyIntent(task.key, patch, call) : call();

  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/work-task", task.key);
        e.dataTransfer.effectAllowed = "move";
      }}
      className="cursor-grab rounded-lg border bg-card px-3 py-2.5 shadow-xs active:cursor-grabbing"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground/85">{task.key}</span>
        {task.priority && task.priority !== "none" ? (
          <span className={cn("text-[10.5px] font-semibold uppercase", PRIORITY_TONE[task.priority])}>
            {task.priority}
          </span>
        ) : null}
        {task.estimate !== undefined ? (
          <span className="text-[10.5px] text-muted-foreground">{task.estimate}pt</span>
        ) : null}
        <span className="ml-auto">
          <CardMenu
            task={task}
            cycles={cycles}
            onCycle={(cycle) =>
              void onRun(task.key, intent({ cycleKey: cycle }, () => client.work.setCycle(orgId, task.key, { cycle })))
            }
            onPriority={(p) =>
              void onRun(task.key, intent({ priority: p }, () => client.work.setPriority(orgId, task.key, { priority: p })))
            }
            onEstimate={(points) =>
              void onRun(task.key, intent({ estimate: points }, () => client.work.setEstimate(orgId, task.key, { points })))
            }
            onAddLabel={() => {
              setLabelDraft("");
              setLabelOpen(true);
            }}
            onRemoveLabel={(label) =>
              void onRun(task.key, intent({ removeTag: label }, () => client.work.label(orgId, task.key, { label, remove: true })))
            }
          />
        </span>
      </div>
      <div className="mt-1 text-[12.5px] leading-snug">{task.title}</div>
      {(task.tags?.length || lc.pinned || lc.blocked) ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {lc.pinned ? (
            // Pin-beside-truth: the card sits in its pinned column, and this
            // chip says who claims it and where the evidence actually is.
            <span title={lc.pinned.note ? `note: ${lc.pinned.note}` : undefined}>
              <Pill tone="warning">
                {lc.pinned.by.id.slice(0, 12)} says {rungLabel(lc.pinned.rung)} — evidence says {rungLabel(lc.rung)}
              </Pill>
            </span>
          ) : null}
          {lc.blocked ? <Pill tone="error">blocked</Pill> : null}
          {task.tags?.map((tag) => (
            <span key={tag} className="rounded-full border border-border px-1.5 py-px text-[10.5px] text-muted-foreground">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {lc.evidence?.length ? (
        <div className="mt-1 truncate text-[10.5px] text-muted-foreground/75">{lc.evidence[0]}</div>
      ) : null}
      {verdict ? <p className="mt-1 text-[11px] text-destructive">verdict: {verdict}</p> : null}
      <Dialog open={labelOpen} onOpenChange={setLabelOpen}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle className="text-[14px]">Add label to {task.key}</DialogTitle>
            <DialogDescription>Free-form workspace labels — pure intent, filterable.</DialogDescription>
          </DialogHeader>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const label = labelDraft.trim();
              if (!label) return;
              setLabelOpen(false);
              void onRun(task.key, intent({ addTag: label }, () => client.work.label(orgId, task.key, { label })));
            }}
          >
            <Input value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)} placeholder="infra" autoFocus />
            <Button size="sm" type="submit" disabled={!labelDraft.trim()}>
              Add
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function CardMenu({
  task,
  cycles,
  onCycle,
  onPriority,
  onEstimate,
  onAddLabel,
  onRemoveLabel,
}: {
  task: WorkTaskView;
  cycles: WorkCycleView[];
  onCycle: (cycle: string | null) => void;
  onPriority: (p: WorkPriority) => void;
  onEstimate: (points: number | null) => void;
  onAddLabel: () => void;
  onRemoveLabel: (label: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${task.key}`}
          className="rounded px-1 text-[13px] leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ⋯
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-[11px]">Priority</DropdownMenuLabel>
        {PRIORITY_OPTIONS.map((p) => (
          <DropdownMenuItem key={p} onSelect={() => onPriority(p)} className="text-[12px]">
            {p}
            {(task.priority ?? "none") === p ? " ✓" : ""}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px]">Estimate</DropdownMenuLabel>
        <div className="flex flex-wrap gap-1 px-2 pb-1.5">
          {ESTIMATE_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onEstimate(n)}
              className={cn(
                "rounded border px-1.5 py-0.5 text-[11px]",
                task.estimate === n ? "border-foreground/40 bg-muted" : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {n}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onEstimate(null)}
            className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
          >
            clear
          </button>
        </div>
        {cycles.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px]">Cycle</DropdownMenuLabel>
            {cycles.map((c) => (
              <DropdownMenuItem key={c.key} onSelect={() => onCycle(c.key)} className="text-[12px]">
                {c.name}
                {task.cycleKey === c.key ? " ✓" : ""}
              </DropdownMenuItem>
            ))}
            {task.cycleKey ? (
              <DropdownMenuItem onSelect={() => onCycle(null)} className="text-[12px] text-muted-foreground">
                Remove from cycle
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onAddLabel} className="text-[12px]">
          Add label…
        </DropdownMenuItem>
        {task.tags?.map((tag) => (
          <DropdownMenuItem key={tag} onSelect={() => onRemoveLabel(tag)} className="text-[12px] text-muted-foreground">
            Remove “{tag}”
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── The honest-drop dialog (pin with note affordance) ─────────── */

function PinDropDialog({
  orgId,
  task,
  rung,
  onClose,
  onRun,
}: {
  orgId: string;
  task: WorkTaskView;
  rung: WorkRung;
  onClose: () => void;
  onRun: (key: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { client } = useSession();
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const confirm = async () => {
    setBusy(true);
    await onRun(task.key, () =>
      client.work.pin(orgId, task.key, { rung, ...(note.trim() ? { note: note.trim() } : {}) }),
    );
    setBusy(false);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            Pin {task.key} to {rungLabel(rung)}?
          </DialogTitle>
          <DialogDescription>
            The board can’t move what the evidence hasn’t — this mints a public, attributed override
            rendered <em>beside</em> observed truth ({rungLabel(task.lifecycle.rung)}), expiring the moment
            facts catch up.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why? (optional note, shown on the pin)"
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} onClick={() => void confirm()}>
            Pin it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
