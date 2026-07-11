"use client";

// The Tasks-lens container (orun-work v2 WP1 lineage, reshaped by
// orun-work-v5 WV2/WV6). Owns the data plumbing the lens renders: the
// summary fold, the SSE live-tail, cycles, the agents plane, and the
// optimistic overlay — every rung on this surface is the fold's output
// rendered WITH its evidence, and a pin always renders beside observed
// truth, never instead of it. The old spec-grouped workbench and its view
// bar were retired in WV6; the Work home (work-home.tsx) is the only
// mount point.

import * as React from "react";
import type { AgentProfile, AgentSession } from "@saas/contracts/agents";
import type { WorkCycleView } from "@saas/contracts/work";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusText } from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { applyFilters, type BoardFilters, type WorkLayout } from "@/lib/work/board";
import { begin, confirm, overlay, prune, reject, type OptimisticEntry, type TaskPatch } from "@/lib/work/optimistic";
import { WorkCreateMenu, type WorkItemKind } from "@/components/work/create-work-item-dialog";
import { CyclesSection } from "@/components/work/cycles-section";
import { WorkBoard } from "@/components/work/work-board";
import { TasksLens } from "@/components/work/work-tasks-lens";
import { DisplayMenu, FilterMenu } from "@/components/work/work-lens-controls";
import { useParams } from "next/navigation";

export function WorkWorkbench({
  orgId,
  requestKind = null,
  onRequestKindConsumed,
}: {
  orgId: string;
  /** WV5: the home's keyboard grammar (`c`) asks for a create dialog. */
  requestKind?: WorkItemKind | null;
  onRequestKindConsumed?: (() => void) | undefined;
}) {
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

  // PM2: layout (list | board) + filters. Both live in Display/Filter now;
  // filters apply to BOTH layouts (the board additionally splits by rung).
  const [layout, setLayout] = React.useState<WorkLayout>("list");
  const [filters, setFilters] = React.useState<BoardFilters>({});

  // PM3: authored time-boxes — loaded beside the summary; derived counts
  // refresh whenever the summary does (same mutation signal).
  const [cycles, setCycles] = React.useState<WorkCycleView[]>([]);
  const summaryData = summary.data;
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await client.work.listCycles(orgId);
        if (!cancelled) setCycles(res.cycles);
      } catch {
        // cycles are additive; the page renders without them
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, orgId, summaryData]);

  // PM5: the agent project surface — profiles are assignable seats, live
  // sessions join tasks by taskKey as INFRA facts beside the rungs. Both
  // are additive: the page renders fine when the agents plane is absent.
  const [agentProfiles, setAgentProfiles] = React.useState<AgentProfile[]>([]);
  const [sessions, setSessions] = React.useState<AgentSession[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const profiles = await client.agents.listProfiles(orgId);
        if (!cancelled) setAgentProfiles(profiles);
      } catch {
        // agents plane absent/denied — assign menu just doesn't render
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, orgId]);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await client.agents.listSessions(orgId);
        if (!cancelled) setSessions(list);
      } catch {
        // no session chips, nothing else changes
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, orgId, summaryData]);
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const sessionsByTask = React.useMemo(() => {
    const terminal = new Set(["completed", "failed", "canceled", "expired"]);
    const map = new Map<string, AgentSession>();
    for (const sess of sessions) {
      if (sess.taskKey && !terminal.has(sess.state)) map.set(sess.taskKey, sess);
    }
    return map;
  }, [sessions]);
  const sessionHref = React.useCallback((sessionId: string) => `/orgs/${orgSlug}/agents/${sessionId}`, [orgSlug]);

  // PM4 flow: the optimistic overlay — intent renders immediately, the SSE
  // tail confirms it (prune when coordSeq catches the mutation's seq), and a
  // 422 verdict rolls the overlay back so the fold's answer shows through.
  const [optimistic, setOptimistic] = React.useState<OptimisticEntry[]>([]);
  const coordSeq = summary.data?.coordSeq ?? 0;
  React.useEffect(() => {
    setOptimistic((entries) => prune(entries, coordSeq));
  }, [coordSeq]);
  const applyIntent = React.useCallback(
    async (key: string, patch: TaskPatch, call: () => Promise<{ seq: number }>) => {
      let id = 0;
      setOptimistic((entries) => {
        const res = begin(entries, key, patch);
        id = res.id;
        return res.entries;
      });
      try {
        const out = await call();
        setOptimistic((entries) => confirm(entries, id, out.seq));
      } catch (err) {
        setOptimistic((entries) => reject(entries, id)); // rollback; caller renders the verdict
        throw err;
      }
    },
    [],
  );

  // PM4: Cmd-K verbs land here as query params (?new=task|spec|initiative,
  // ?layout=board|list) — consumed once, then stripped from the URL. WV5
  // adds the keyboard path via the requestKind prop.
  const [requestedKind, setRequestedKind] = React.useState<WorkItemKind | null>(null);
  React.useEffect(() => {
    if (requestKind) {
      setRequestedKind(requestKind);
      onRequestKindConsumed?.();
    }
  }, [requestKind, onRequestKindConsumed]);
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const created = params.get("new");
    const layoutParam = params.get("layout");
    if (created === "task" || created === "spec" || created === "initiative") setRequestedKind(created);
    if (layoutParam === "board" || layoutParam === "list") setLayout(layoutParam);
    if (created || layoutParam) {
      params.delete("new");
      params.delete("layout");
      const qs = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    }
  }, []);

  const data = summary.data;
  const empty = !data || (data.tasks.length === 0 && data.specs.length === 0);
  const filteredTasks = data ? overlay(applyFilters(data.tasks, filters), optimistic) : [];

  let body: React.ReactNode;
  if (summary.loading) {
    body = <WorkSkeleton />;
  } else if (summary.error) {
    body = <ErrorCard code={summary.error.code} message={summary.error.message} />;
  } else if (!data || empty) {
    body = <EmptyWork />;
  } else if (layout === "board") {
    body = (
      <WorkBoard
        orgId={orgId}
        tasks={filteredTasks}
        cycles={cycles}
        agentProfiles={agentProfiles}
        sessionsByTask={sessionsByTask}
        sessionHref={sessionHref}
        applyIntent={applyIntent}
        onMutated={summary.reload}
      />
    );
  } else {
    body = (
      <TasksLens
        data={{ ...data, tasks: filteredTasks }}
        orgId={orgId}
        cycles={cycles}
        sessionsByTask={sessionsByTask}
        sessionHref={sessionHref}
        onMutated={summary.reload}
      />
    );
  }

  return (
    <>
      {data && !empty ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <FilterMenu tasks={data.tasks} filters={filters} onFiltersChange={setFilters} />
            <DisplayMenu
              orgId={orgId}
              layout={layout}
              filters={filters}
              onLayoutChange={setLayout}
              onFiltersChange={setFilters}
            />
          </div>
          <WorkCreateMenu
            orgId={orgId}
            specs={data.specs}
            onCreated={reload}
            requestedKind={requestedKind}
            onRequestConsumed={() => setRequestedKind(null)}
          />
        </div>
      ) : null}
      {body}
      {data && !empty && (cycles.length > 0 || data.tasks.length > 0) ? (
        <div className="mt-[26px]" id="cycles">
          <CyclesSection orgId={orgId} cycles={cycles} onMutated={reload} />
        </div>
      ) : null}
    </>
  );
}

/* ── Empty / error / loading ──────────────────────────────────── */

function EmptyWork() {
  return (
    <div className="mt-5 rounded-xl border bg-card px-6 py-14 text-center">
      <div className="text-[13.5px] font-medium">Nothing here yet</div>
      <p className="mx-auto mt-1.5 max-w-[460px] text-[12.5px] leading-relaxed text-muted-foreground">
        Create an epic or task from the New menu above, or import a specs tree with{" "}
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
    <div className="mt-5 rounded-xl border bg-card px-6 py-8">
      <StatusText tone="error" className="font-medium">
        {code}
      </StatusText>
      <p className="mt-1.5 text-[12.5px] text-muted-foreground">{message}</p>
    </div>
  );
}

function WorkSkeleton() {
  return (
    <div aria-hidden className="mt-5 space-y-3">
      <Skeleton className="h-11 w-full rounded-[10px]" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
