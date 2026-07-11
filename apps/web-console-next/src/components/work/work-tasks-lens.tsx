"use client";

// The Tasks lens (orun-work-v5 WV2) — the day view of the Work home, per
// specs/epics/orun-work-v5/design.md §3.3. The cycle bar and every group
// band render the fold; the only writes on this surface are the ones the
// workbench already owned (rename, comment, pin, assign, spawn) — WV-1.

import * as React from "react";
import type { AgentSession } from "@saas/contracts/agents";
import type {
  WorkCycleView,
  WorkRung,
  WorkSummaryResponse,
  WorkTaskView,
} from "@saas/contracts/work";
import { ListCard, Pill } from "@/components/ui/northwind";
import { GroupBand, RungIcon, TaskRungMark, TruthCaption } from "@/components/ui/northwind-work";
import { rungLabel } from "@/lib/work/model";
import { activeCycle, cycleBarModel, taskGroups } from "@/lib/work/home";
import { TaskActions } from "@/components/work/task-actions";
import { EditWorkItemDialog } from "@/components/work/create-work-item-dialog";
import { TaskConversationSheet } from "@/components/work/task-conversation-sheet";
import { AssigneeChip, SessionChip } from "@/components/work/work-board";
import { SpawnAgentDialog } from "@/components/agents/spawn-agent-dialog";

const GROUP_LABEL_TONE: Partial<Record<WorkRung, string>> = {
  in_progress: "text-warning",
  in_review: "text-info",
  ready: "text-secondary-foreground",
  draft: "text-muted-foreground",
  done: "text-foreground",
  released: "text-success",
  canceled: "text-muted-foreground/70",
};

export function TasksLens({
  data,
  orgId,
  cycles,
  sessionsByTask,
  sessionHref,
  onMutated,
}: {
  data: WorkSummaryResponse;
  orgId: string;
  cycles: WorkCycleView[];
  sessionsByTask?: Map<string, AgentSession> | undefined;
  sessionHref?: ((sessionId: string) => string) | undefined;
  onMutated: () => void;
}) {
  const groups = taskGroups(data.tasks);
  const specTitles = React.useMemo(
    () => new Map(data.specs.map((s) => [s.key, s.title])),
    [data.specs],
  );
  return (
    <div className="mt-4">
      <CycleBar cycles={cycles} />
      {groups.length === 0 ? (
        <ListCard className="mt-3">
          <div className="px-5 py-8 text-[13px] text-muted-foreground">
            No tasks match. Loosen the filter, or create one from the New menu — lifecycle derives from
            delivery either way.
          </div>
        </ListCard>
      ) : (
        <ListCard className="mt-3">
          {groups.map((group) => (
            <React.Fragment key={group.rung}>
              <GroupBand
                icon={<RungIcon rung={group.rung} size={12} />}
                label={rungLabel(group.rung)}
                labelClassName={GROUP_LABEL_TONE[group.rung] ?? "text-muted-foreground"}
                count={group.tasks.length}
              />
              <ul>
                {group.tasks.map((task) => (
                  <TaskLensRow
                    key={task.key}
                    task={task}
                    orgId={orgId}
                    specTitle={task.spec ? specTitles.get(task.spec) : undefined}
                    session={sessionsByTask?.get(task.key)}
                    sessionHref={sessionHref}
                    onMutated={onMutated}
                  />
                ))}
              </ul>
            </React.Fragment>
          ))}
        </ListCard>
      )}
      <TruthCaption>
        Every status above is folded from delivery truth — never typed in. Pins render beside what the
        fold observes, attributed.
      </TruthCaption>
    </div>
  );
}

/* ── The cycle bar ──────────────────────────────────────────────────── */

function CycleBar({ cycles }: { cycles: WorkCycleView[] }) {
  const now = React.useMemo(() => new Date(), []);
  const cycle = activeCycle(cycles, now);
  if (!cycle) return null;
  const model = cycleBarModel(cycle, now);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[10px] border bg-card px-4 py-2.5">
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="shrink-0 text-muted-foreground"
        aria-hidden
      >
        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
      <span className="text-[13px] font-semibold">
        {model.name}
        <span className="ml-2 font-normal text-muted-foreground">{model.rangeLabel}</span>
      </span>
      <span aria-hidden className="flex h-1 w-28 overflow-hidden rounded-sm bg-[hsl(var(--work-track))]">
        <span className="bg-success" style={{ width: `${Math.min(100, model.pct)}%` }} />
      </span>
      <span className="text-xs text-muted-foreground">{model.statusLabel}</span>
      <a href="#cycles" className="ml-auto text-xs text-muted-foreground transition-colors hover:text-foreground">
        Cycle report →
      </a>
    </div>
  );
}

/* ── Rows ───────────────────────────────────────────────────────────── */

function TaskLensRow({
  task,
  orgId,
  specTitle,
  session,
  sessionHref,
  onMutated,
}: {
  task: WorkTaskView;
  orgId: string;
  specTitle?: string | undefined;
  session?: AgentSession | undefined;
  sessionHref?: ((sessionId: string) => string) | undefined;
  onMutated: () => void;
}) {
  const lc = task.lifecycle;
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [threadOpen, setThreadOpen] = React.useState(false);
  const [agentOpen, setAgentOpen] = React.useState(false);
  return (
    <li className="group border-t border-border/50 px-[18px] py-2.5 transition-colors duration-100 first:border-t-0 hover:bg-muted/60">
      <div className="flex min-h-[20px] flex-wrap items-center gap-x-3 gap-y-1.5">
        <TaskRungMark lifecycle={lc} />
        <span className="min-w-[48px] shrink-0 font-mono text-[11.5px] text-muted-foreground/85">
          {task.key}
        </span>
        <button
          type="button"
          onClick={() => setRenameOpen(true)}
          className="min-w-0 flex-1 truncate text-left text-[13px] decoration-border underline-offset-2 hover:underline"
          title="Edit title"
        >
          {task.title}
        </button>
        {session ? <SessionChip session={session} href={sessionHref?.(session.id)} /> : null}
        {task.priority && task.priority !== "none" ? (
          <span className="hidden shrink-0 text-[10.5px] font-semibold uppercase text-muted-foreground lg:inline">
            {task.priority}
          </span>
        ) : null}
        {task.tags?.map((tag) => (
          <span
            key={tag}
            className="hidden shrink-0 rounded-full border border-border px-1.5 py-px text-[10.5px] text-muted-foreground xl:inline"
          >
            {tag}
          </span>
        ))}
        <span className="hidden shrink-0 sm:inline-flex" {...(specTitle ? { title: specTitle } : {})}>
          <Pill tone="neutral" className="font-mono text-[10.5px]">
            {task.spec ? task.spec : "inbox · no epic"}
          </Pill>
        </span>
        {lc.blocked ? <Pill tone="error">blocked</Pill> : null}
        {task.assignees?.map((a) => <AssigneeChip key={a} subject={a} />)}
        <button
          type="button"
          onClick={() => setThreadOpen(true)}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground opacity-0 transition-all duration-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          Thread
        </button>
        <button
          type="button"
          onClick={() => setAgentOpen(true)}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground opacity-0 transition-all duration-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          Agent
        </button>
        <TaskActions orgId={orgId} task={task} onMutated={onMutated} />
      </div>
      {lc.evidence?.length ? (
        <div className="mt-1 truncate text-[11.5px] text-muted-foreground/85 sm:pl-[76px]">
          {lc.evidence[0]}
        </div>
      ) : null}
      <EditWorkItemDialog
        orgId={orgId}
        itemKey={task.key}
        currentTitle={task.title}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onSaved={onMutated}
      />
      <TaskConversationSheet
        orgId={orgId}
        taskKey={task.key}
        open={threadOpen}
        onOpenChange={setThreadOpen}
        onMutated={onMutated}
      />
      <SpawnAgentDialog
        orgId={orgId}
        itemKey={task.key}
        runKind="implementation"
        open={agentOpen}
        onOpenChange={setAgentOpen}
      />
    </li>
  );
}
