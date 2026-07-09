"use client";

// The work lens, read-only (orun-work v2 WP1). Every rung on this page is the
// fold's output rendered WITH its evidence — nothing here is a stored status,
// and a pin always renders beside observed truth, never instead of it.

import * as React from "react";
import type {
  WorkRung,
  WorkSpecView,
  WorkSummaryResponse,
  WorkTaskView,
} from "@saas/contracts/work";
import { Skeleton } from "@/components/ui/skeleton";
import {
  HeaderStat,
  ListCard,
  PageHeader,
  Pill,
  Screen,
  StatusText,
  type Tone,
} from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { rungLabel, groupTasksBySpec, type SpecGroup } from "@/lib/work/model";
import { TaskActions } from "@/components/work/task-actions";
import { EditWorkItemDialog, WorkCreateMenu } from "@/components/work/create-work-item-dialog";
import { SpecDocSheet } from "@/components/work/spec-doc-sheet";

export function WorkWorkbench({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const summary = useApiQuery(qk.orgWork(orgId), () =>
    wrap(async () => client.work.summary(orgId)),
  );

  // WP1b live-ness: the coordination log IS the sync signal. Prefer the SSE
  // tail (a new event reaches open tabs in ~seconds); each server leg is
  // deliberately bounded, so the loop reconnects from its cursor when a leg
  // ends, and when a leg FAILS it falls back to one 12s poll round before
  // trying the stream again — liveness degrades, never disappears. Any new
  // event (another tab, a teammate, an agent via the MCP) triggers one
  // summary refetch. The mutation/verdict seam is untouched either way.
  const cursor = React.useRef(0);
  React.useEffect(() => {
    if (summary.data) cursor.current = Math.max(cursor.current, summary.data.coordSeq);
  }, [summary.data]);
  const reload = summary.reload;
  React.useEffect(() => {
    const aborter = new AbortController();
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        aborter.signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
    // Trailing debounce: an import burst (dozens of events in one leg) folds
    // into one summary refetch instead of one per event.
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleReload = () => {
      if (reloadTimer !== undefined) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        if (!aborter.signal.aborted) reload();
      }, 300);
    };
    void (async () => {
      while (!aborter.signal.aborted) {
        try {
          for await (const e of client.work.streamEvents(orgId, cursor.current, { signal: aborter.signal })) {
            cursor.current = Math.max(cursor.current, e.seq);
            scheduleReload();
          }
          await sleep(1_000); // bounded leg ended — reconnect from the cursor
        } catch {
          if (aborter.signal.aborted) return;
          try {
            const page = await client.work.listEvents(orgId, cursor.current);
            if (page.events.length > 0) {
              cursor.current = page.seq;
              reload();
            }
          } catch {
            // transient — the next round retries
          }
          await sleep(12_000);
        }
      }
    })();
    return () => {
      if (reloadTimer !== undefined) clearTimeout(reloadTimer);
      aborter.abort();
    };
  }, [client, orgId, reload]);

  const data = summary.data;
  const empty = !data || (data.tasks.length === 0 && data.specs.length === 0);

  let body: React.ReactNode;
  if (summary.loading) {
    body = <WorkSkeleton />;
  } else if (summary.error) {
    body = <ErrorCard code={summary.error.code} message={summary.error.message} />;
  } else if (empty) {
    body = <EmptyWork />;
  } else {
    body = <WorkSummary data={data} orgId={orgId} onMutated={summary.reload} />;
  }

  return (
    <Screen>
      <PageHeader
        title="Work"
        description="Tasks grouped by spec, ordered by how close they are to shipped. Author here or import from git — lifecycle derives from delivery either way."
        {...(data
          ? {
              actions: (
                <div className="flex items-center gap-5">
                  {!empty ? <HeaderStats tasks={data.tasks} /> : null}
                  <WorkCreateMenu orgId={orgId} specs={data.specs} onCreated={reload} />
                </div>
              ),
            }
          : {})}
      />
      {body}
    </Screen>
  );
}

/* ── Header stats ─────────────────────────────────────────────── */

function HeaderStats({ tasks }: { tasks: WorkTaskView[] }) {
  const open = tasks.filter(
    (t) => t.lifecycle.rung !== "released" && t.lifecycle.rung !== "canceled",
  ).length;
  const released = tasks.filter((t) => t.lifecycle.rung === "released").length;
  return (
    <div className="flex gap-6">
      <HeaderStat
        value={open}
        caption={open === 1 ? "open task" : "open tasks"}
        className="text-left sm:text-right"
      />
      <HeaderStat
        value={released}
        caption="released"
        tone="success"
        className="text-left sm:text-right"
      />
    </div>
  );
}

/* ── Summary (spec groups) ────────────────────────────────────── */

function WorkSummary({
  data,
  orgId,
  onMutated,
}: {
  data: WorkSummaryResponse;
  orgId: string;
  onMutated: () => void;
}) {
  const groups = groupTasksBySpec(data.tasks);
  const specsByKey = new Map(data.specs.map((s) => [s.key, s]));
  // A spec with no tasks yet still renders (you can now create one in the
  // console and write its doc before any task exists).
  const grouped = new Set(groups.map((g) => g.spec));
  const emptySpecs = data.specs.filter((s) => !grouped.has(s.key));

  return (
    <div className="mt-[30px] flex flex-col gap-[26px]">
      {data.initiatives.length > 0 ? <Initiatives initiatives={data.initiatives} orgId={orgId} onMutated={onMutated} /> : null}
      {data.drift.length > 0 ? <DriftInbox drift={data.drift} /> : null}
      {data.suggestions.length > 0 ? <Suggestions suggestions={data.suggestions} /> : null}
      {groups.map((group) => (
        <SpecGroupSection
          key={group.spec ?? "__inbox__"}
          group={group}
          {...(group.spec ? { spec: specsByKey.get(group.spec) } : {})}
          orgId={orgId}
          onMutated={onMutated}
        />
      ))}
      {emptySpecs.map((s) => (
        <SpecGroupSection
          key={s.key}
          group={{ spec: s.key, tasks: [] }}
          spec={s}
          orgId={orgId}
          onMutated={onMutated}
        />
      ))}
    </div>
  );
}

function SpecGroupSection({
  group,
  spec,
  orgId,
  onMutated,
}: {
  group: SpecGroup;
  spec?: WorkSpecView | undefined;
  orgId: string;
  onMutated: () => void;
}) {
  const title = spec?.title;
  const [docOpen, setDocOpen] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const total = group.tasks.length;
  const done = group.tasks.filter(
    (t) => t.lifecycle.rung === "released" || t.lifecycle.rung === "done",
  ).length;
  const active = group.tasks.filter(
    (t) => t.lifecycle.rung === "in_review" || t.lifecycle.rung === "in_progress",
  ).length;

  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2.5">
        {group.spec ? (
          <span
            className="truncate font-mono text-[12.5px] font-semibold text-secondary-foreground"
            {...(title && title !== group.spec ? { title } : {})}
          >
            {group.spec}
          </span>
        ) : (
          <span className="text-[12.5px] font-semibold text-muted-foreground">Inbox</span>
        )}
        <span className="shrink-0 text-[11.5px] text-muted-foreground/85">
          {total} {total === 1 ? "task" : "tasks"}
          {group.spec ? "" : " · no spec yet"}
        </span>
        {group.spec && spec ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setDocOpen(true)}
              className="rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Doc{spec.docRef ? "" : " +"}
            </button>
            <button
              type="button"
              onClick={() => setRenameOpen(true)}
              className="rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Rename
            </button>
          </span>
        ) : null}
        {group.spec && total > 0 ? (
          <span
            aria-hidden
            className="ml-auto flex h-[5px] w-20 shrink-0 overflow-hidden rounded-[3px] bg-[#EDEDED] dark:bg-secondary sm:w-40"
          >
            {done > 0 ? <span className="bg-success" style={{ width: `${(done / total) * 100}%` }} /> : null}
            {active > 0 ? (
              <span className="bg-warning-accent" style={{ width: `${(active / total) * 100}%` }} />
            ) : null}
          </span>
        ) : null}
      </div>
      {total > 0 ? (
        <ListCard>
          <ul>
            {group.tasks.map((task) => (
              <TaskRow key={task.key} task={task} orgId={orgId} onMutated={onMutated} />
            ))}
          </ul>
        </ListCard>
      ) : (
        <ListCard>
          <div className="px-5 py-4 text-[12.5px] text-muted-foreground">
            No tasks yet — create one from the New menu, or write the doc first.
          </div>
        </ListCard>
      )}
      {group.spec && spec ? (
        <>
          <SpecDocSheet
            orgId={orgId}
            specKey={group.spec}
            docRef={spec.docRef}
            open={docOpen}
            onOpenChange={setDocOpen}
            onMutated={onMutated}
          />
          <EditWorkItemDialog
            orgId={orgId}
            itemKey={group.spec}
            currentTitle={title ?? group.spec}
            open={renameOpen}
            onOpenChange={setRenameOpen}
            onSaved={onMutated}
          />
        </>
      ) : null}
    </section>
  );
}

/* ── Initiatives (v3 PM0: envelope-only groupings; no rung, no contract) ── */

function Initiatives({
  initiatives,
  orgId,
  onMutated,
}: {
  initiatives: WorkSummaryResponse["initiatives"];
  orgId: string;
  onMutated: () => void;
}) {
  const [editing, setEditing] = React.useState<string | null>(null);
  const current = initiatives.find((i) => i.key === editing);
  return (
    <section>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="text-[12.5px] font-semibold text-muted-foreground">Initiatives</span>
        <span className="text-[11.5px] text-muted-foreground/85">
          strategic groupings — progress is a rollup, never a number anyone types
        </span>
      </div>
      <ListCard>
        {initiatives.map((i) => (
          <div
            key={i.key}
            className="flex items-baseline gap-3 border-t border-border/50 px-5 py-2.5 first:border-t-0"
          >
            <span className="min-w-[56px] shrink-0 font-mono text-[11.5px] text-secondary-foreground">
              {i.key}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px]">{i.title}</span>
            {i.description ? (
              <span className="hidden min-w-0 flex-1 truncate text-[12px] text-muted-foreground sm:block">
                {i.description}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setEditing(i.key)}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Edit
            </button>
          </div>
        ))}
      </ListCard>
      {current ? (
        <EditWorkItemDialog
          orgId={orgId}
          itemKey={current.key}
          currentTitle={current.title}
          currentDescription={current.description}
          withDescription
          open
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            onMutated();
          }}
        />
      ) : null}
    </section>
  );
}

/* ── Task rows ────────────────────────────────────────────────── */

const RUNG_PILL_TONE: Partial<Record<WorkRung, Tone>> = {
  released: "success",
  in_review: "warning",
  in_progress: "warning",
  ready: "neutral",
};

const RUNG_PILL_CLASS: Partial<Record<WorkRung, string>> = {
  done: "bg-[#EDEDED] text-foreground dark:bg-secondary dark:text-foreground",
  draft: "border border-border bg-background text-muted-foreground",
  canceled: "border border-border bg-background text-muted-foreground/70",
};

function RungPill({ rung }: { rung: WorkRung }) {
  return (
    <Pill tone={RUNG_PILL_TONE[rung] ?? "neutral"} className={RUNG_PILL_CLASS[rung] ?? ""}>
      {rungLabel(rung)}
    </Pill>
  );
}

function TaskRow({
  task,
  orgId,
  onMutated,
}: {
  task: WorkTaskView;
  orgId: string;
  onMutated: () => void;
}) {
  const lc = task.lifecycle;
  const [renameOpen, setRenameOpen] = React.useState(false);
  return (
    <li className="group border-t border-border/50 px-5 py-3 transition-colors duration-100 first:border-t-0 hover:bg-muted/60">
      <div className="flex min-h-[20px] flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-[56px] shrink-0 font-mono text-[11.5px] text-muted-foreground/85">
          {task.key}
        </span>
        <button
          type="button"
          onClick={() => setRenameOpen(true)}
          className="min-w-0 flex-1 truncate text-left text-[13.5px] hover:underline decoration-border underline-offset-2"
          title="Edit title"
        >
          {task.title}
        </button>
        <EditWorkItemDialog
          orgId={orgId}
          itemKey={task.key}
          currentTitle={task.title}
          open={renameOpen}
          onOpenChange={setRenameOpen}
          onSaved={onMutated}
        />
        <TaskActions orgId={orgId} task={task} onMutated={onMutated} />
        {lc.pinned ? (
          <span
            className="shrink-0"
            title={`pinned by ${lc.pinned.by.id}${lc.pinned.note ? ` — ${lc.pinned.note}` : ""}`}
          >
            <Pill tone="warning">pinned {rungLabel(lc.pinned.rung)}</Pill>
          </span>
        ) : null}
        {lc.blocked ? <Pill tone="error">blocked</Pill> : null}
        <RungPill rung={lc.rung} />
      </div>
      {lc.evidence?.length ? (
        <div className="mt-1 truncate text-[11.5px] text-muted-foreground/85 sm:pl-[68px]">
          {lc.evidence[0]}
        </div>
      ) : null}
    </li>
  );
}

/* ── Drift & suggestions ──────────────────────────────────────── */

function DriftInbox({ drift }: { drift: WorkSummaryResponse["drift"] }) {
  return (
    <section>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="text-[12.5px] font-semibold text-muted-foreground">Drift inbox</span>
        <span className="text-[11.5px] text-muted-foreground/85">
          merged PRs no open task claims — unplanned changes
        </span>
      </div>
      <ListCard>
        {drift.map((d) => (
          <div
            key={d.pr}
            className="flex items-baseline gap-3 border-t border-border/50 bg-warning-wash px-5 py-2.5 first:border-t-0"
          >
            <span className="min-w-[56px] shrink-0 font-mono text-[11.5px] text-secondary-foreground">
              {d.pr}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
              → {d.affected.join(", ")}
            </span>
          </div>
        ))}
      </ListCard>
    </section>
  );
}

function Suggestions({ suggestions }: { suggestions: WorkSummaryResponse["suggestions"] }) {
  return (
    <section>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="text-[12.5px] font-semibold text-muted-foreground">Claim suggestions</span>
        <span className="text-[11.5px] text-muted-foreground/85">
          PRs whose components match more than one open task — ambiguity suggests, never links
        </span>
      </div>
      <ListCard>
        {suggestions.map((s) => (
          <div
            key={s.pr}
            className="flex items-baseline gap-3 border-t border-border/50 px-5 py-2.5 first:border-t-0"
          >
            <span className="min-w-[56px] shrink-0 font-mono text-[11.5px] text-secondary-foreground">
              {s.pr}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
              could claim {s.taskKeys.join(" or ")}
            </span>
          </div>
        ))}
      </ListCard>
    </section>
  );
}

/* ── Empty / error / loading ──────────────────────────────────── */

function EmptyWork() {
  return (
    <div className="mt-[30px] rounded-xl border bg-card px-6 py-14 text-center">
      <div className="text-[13.5px] font-medium">Nothing here yet</div>
      <p className="mx-auto mt-1.5 max-w-[460px] text-[12.5px] leading-relaxed text-muted-foreground">
        Create a spec or task from the New menu above, or import a specs tree with{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
          orun work import specs/ --workspace …
        </code>{" "}
        — either way, lifecycle derives from delivery history, not from anything you type.
      </p>
    </div>
  );
}

function ErrorCard({ code, message }: { code: string; message: string }) {
  return (
    <div className="mt-[30px] rounded-xl border bg-card px-6 py-8">
      <StatusText tone="error" className="font-medium">
        {code}
      </StatusText>
      <p className="mt-1.5 text-[12.5px] text-muted-foreground">{message}</p>
    </div>
  );
}

function WorkSkeleton() {
  return (
    <div aria-hidden className="mt-[30px] space-y-[26px]">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i}>
          <Skeleton className="mb-2.5 h-4 w-44" />
          <Skeleton className="h-36 w-full rounded-xl" />
        </div>
      ))}
    </div>
  );
}

const RUNG_ORDER: WorkRung[] = ["released", "done", "in_review", "in_progress", "ready", "draft", "canceled"];
export { RUNG_ORDER };
