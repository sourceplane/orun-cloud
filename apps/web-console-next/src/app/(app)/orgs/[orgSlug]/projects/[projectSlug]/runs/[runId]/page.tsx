"use client";

// The run detail view (OV7), in the Northwind design (scratchpad
// design/run-detail.html): breadcrumb (Activities / run id), a serif hero with
// a live status pill and a mono provenance line, a full-width segmented run
// progress bar, then a 280px/1fr grid — the jobs rail (check / pulsing dot /
// hollow-ring rows) and a terminal-style dark log pane with live-tail. The log
// pane stays dark in both themes (it's a terminal).
//
// One run's projection (status, provenance, timings, job counts) plus its
// plan-DAG jobs (status, component, deps, attempt, failure summary, logs).
// Read-only; consumes getRun + listRunJobs + readRunJobLogs (OV7.4 SDK).
// Project-scoped like the runs list (resolves projectSlug → projectId via the
// projects list). The design's per-step logs are substituted with each JOB's
// real assembled log stream — we don't fabricate steps the projection lacks.

import * as React from "react";
import { useParams } from "next/navigation";
import { Check, Play, X } from "lucide-react";
import type { Run, RunJob } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Breadcrumbs,
  Kicker,
  Pill,
  RunProgress,
  Screen,
  StatusDot,
} from "@/components/ui/northwind";
import { cn } from "@/lib/cn";
import { wrap } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { buildRunDetail, type JobView } from "@/lib/runs-portal/model";
import { ActorBadge, RUN_TONE } from "@/components/activity/run-rows";

const CLOCK_TICK_MS = 5_000;

export default function RunDetailPage() {
  const params = useParams<{ orgSlug: string; projectSlug: string; runId: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";
  const runId = params?.runId ?? "";
  return (
    <OrgScope slug={orgSlug}>
      {(org) => <Inner orgId={org.id} orgSlug={orgSlug} projectSlug={projectSlug} runId={runId} />}
    </OrgScope>
  );
}

function Inner({
  orgId,
  orgSlug,
  projectSlug,
  runId,
}: {
  orgId: string;
  orgSlug: string;
  projectSlug: string;
  runId: string;
}) {
  const { client } = useSession();
  // Runs are browsed from the org-level Activities feed now; return there.
  const runsHref = `/orgs/${orgSlug}/activities`;

  // A ticking clock so live durations / relative time stay current.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const projectsList = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = React.useMemo(
    () => projectsList.data?.find((p) => p.slug === projectSlug) ?? null,
    [projectsList.data, projectSlug],
  );
  const projectId = project?.id ?? "pending";
  const repoLabel = project?.name ?? project?.slug ?? projectSlug;

  const run = useApiQuery(
    qk.run(orgId, projectId, runId),
    () => wrap(async () => (await client.state.getRun(orgId, projectId, runId)).run),
    { enabled: !!project },
  );
  const jobs = useApiQuery(
    qk.runJobs(orgId, projectId, runId),
    () => wrap(async () => (await client.state.listRunJobs(orgId, projectId, runId)).jobs),
    { enabled: !!project },
  );

  const [selectedJob, setSelectedJob] = React.useState<string | null>(null);

  const crumbs = (
    <Breadcrumbs
      items={[
        { label: "Activities", href: runsHref },
        { label: runId, mono: true },
      ]}
    />
  );

  if (projectsList.loading || (project && run.loading)) {
    return (
      <Screen detail>
        {crumbs}
        <Skeleton className="h-[72px] w-full rounded-xl" />
        <Skeleton className="mt-[22px] h-1.5 w-full rounded-[3px]" />
        <div className="mt-[26px] grid grid-cols-1 items-start gap-[14px] md:grid-cols-[280px_minmax(0,1fr)]">
          <Skeleton className="h-[260px] w-full rounded-xl" />
          <Skeleton className="h-[320px] w-full rounded-xl" />
        </div>
      </Screen>
    );
  }
  if (projectsList.error || !project) {
    return (
      <Screen detail>
        {crumbs}
        <EmptyState icon={Play} title="Run not found" description={`No repo "${projectSlug}" in this workspace.`} />
      </Screen>
    );
  }
  if (run.error || !run.data) {
    return (
      <Screen detail>
        {crumbs}
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{run.error?.code ?? "not_found"}</CardTitle>
            <CardDescription>{run.error?.message ?? `Run ${runId} was not found.`}</CardDescription>
          </CardHeader>
        </Card>
      </Screen>
    );
  }

  const r: Run = run.data;
  const jobList: RunJob[] = jobs.data ?? [];
  const detail = buildRunDetail(r, jobList, repoLabel, now);
  const hero = detail.hero;
  const activeJobId = selectedJob ?? detail.defaultJobId;
  const activeJob = detail.jobs.find((j) => j.jobId === activeJobId) ?? detail.jobs[0] ?? null;

  const counts = r.jobCounts;
  const totalJobs = counts.queued + counts.running + counts.succeeded + counts.failed;
  const finishedJobs = counts.succeeded + counts.failed;
  const donePct = totalJobs > 0 ? (finishedJobs / totalJobs) * 100 : hero.live ? 0 : 100;
  const runPct = totalJobs > 0 ? (counts.running / totalJobs) * 100 : 0;

  const startedUtc = utcTime(r.startedAt);
  const provenance = [hero.branch, hero.commit7].filter(Boolean).join(" · ") || hero.runId;
  const pillLabel =
    hero.status === "running"
      ? `Running · ${hero.duration}`
      : !hero.live && hero.duration !== "—"
        ? `${hero.statusLabel} · ${hero.duration}`
        : hero.statusLabel;

  return (
    <Screen detail>
      {crumbs}

      {/* hero */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 truncate font-serif text-[26px] font-medium leading-tight tracking-[-0.01em] sm:text-[28px]">
            {hero.repo}
          </h1>
          <Pill tone={RUN_TONE[hero.status]} dot live={hero.status === "running"}>
            {pillLabel}
          </Pill>
        </div>
        <div className="mt-[9px] flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12.5px] text-muted-foreground">
          <span className="font-mono text-xs">{provenance}</span>
          <Sep />
          <span className="flex min-w-0 items-center gap-1.5">
            <ActorBadge actor={hero.actor} />
            <span className="truncate">
              {hero.actor.name} · via {hero.sourceLabel}
            </span>
          </span>
          {hero.env ? (
            <>
              <Sep />
              <span>{hero.envLabel}</span>
            </>
          ) : null}
        </div>
      </div>

      {/* run progress */}
      <RunProgress className="mt-[22px]" donePercent={donePct} runningPercent={runPct} />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-muted-foreground/85">
        <span>
          {finishedJobs} of {totalJobs} jobs finished
        </span>
        <span title={r.startedAt ? formatTimestamp(r.startedAt) : formatTimestamp(r.createdAt)}>
          {startedUtc ? `started ${startedUtc} UTC` : `created ${hero.rel}`}
        </span>
      </div>

      {/* jobs rail + log pane */}
      {jobs.loading ? (
        <div className="mt-[26px] grid grid-cols-1 items-start gap-[14px] md:grid-cols-[280px_minmax(0,1fr)]">
          <Skeleton className="h-[260px] w-full rounded-xl" />
          <Skeleton className="h-[320px] w-full rounded-xl" />
        </div>
      ) : jobs.error ? (
        <Card className="mt-[26px]">
          <CardHeader>
            <CardTitle className="text-destructive">{jobs.error.code}</CardTitle>
            <CardDescription>{jobs.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : detail.jobs.length === 0 ? (
        <div className="mt-[26px]">
          <EmptyState icon={Play} title="No jobs" description="This run has no jobs in its plan DAG." />
        </div>
      ) : (
        <div className="mt-[26px] grid grid-cols-1 items-start gap-[14px] md:grid-cols-[280px_minmax(0,1fr)]">
          {/* jobs rail (stacks above the log pane on mobile) */}
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="px-[18px] pb-[9px] pt-[13px]">
              <Kicker>Jobs · {detail.jobs.length}</Kicker>
            </div>
            {detail.jobs.map((j) => {
              const active = j.jobId === activeJob?.jobId;
              const liveJob = j.status === "running" || j.status === "claimed";
              const okJob = j.status === "succeeded";
              const badJob = j.status === "failed" || j.status === "timed_out";
              const queued = j.status === "queued";
              return (
                <button
                  key={j.jobId}
                  type="button"
                  onClick={() => setSelectedJob(j.jobId)}
                  aria-pressed={active}
                  className={cn(
                    "flex w-full items-center gap-[9px] border-t border-border/50 px-[18px] py-[9px] text-left text-[12.5px] transition-colors",
                    liveJob ? "border-l-2 border-l-info bg-info-soft pl-4" : "hover:bg-muted",
                    active && !liveJob && "bg-secondary/70",
                    (queued || j.status === "canceled") && "text-muted-foreground",
                  )}
                >
                  {okJob ? (
                    <Check aria-hidden className="h-[13px] w-[13px] shrink-0 text-success" strokeWidth={2.4} />
                  ) : badJob ? (
                    <X aria-hidden className="h-[13px] w-[13px] shrink-0 text-destructive" strokeWidth={2.4} />
                  ) : liveJob ? (
                    <StatusDot tone="info" live className="h-2 w-2" />
                  ) : j.status === "canceled" ? (
                    <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-foreground/25" />
                  ) : (
                    <span aria-hidden className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-foreground/30" />
                  )}
                  <span className={cn("min-w-0 flex-1 truncate font-mono", liveJob && "font-semibold")}>
                    {j.name}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[11px]",
                      liveJob ? "text-info" : badJob ? "text-destructive" : "text-muted-foreground/85",
                    )}
                  >
                    {queued
                      ? "queued"
                      : j.status === "canceled"
                        ? "canceled"
                        : liveJob
                          ? `${j.dur}…`
                          : j.dur}
                  </span>
                </button>
              );
            })}
          </div>

          {/* selected job: dark terminal log pane */}
          {activeJob ? (
            <JobLogPanel key={activeJob.jobId} job={activeJob} orgId={orgId} projectId={projectId} runId={runId} />
          ) : null}
        </div>
      )}
    </Screen>
  );
}

function Sep() {
  return (
    <span aria-hidden className="text-foreground/25">
      ·
    </span>
  );
}

/** "HH:MM:SS" UTC clock time of an ISO instant, or null. */
function utcTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString().slice(11, 19);
}

/** How often live-tail polls the log tail while a job is still producing output. */
const LOG_TAIL_INTERVAL_MS = 3000;

/** Ghost button on the dark terminal header (the design's "Raw log" recipe). */
const DARK_BTN =
  "shrink-0 rounded-[7px] border border-[#404040] bg-transparent px-2.5 py-1 text-[11px] text-[#A8A8A8] transition-colors hover:bg-white/[0.06] hover:text-[#E0E0E0] disabled:pointer-events-none disabled:opacity-50";

/** Terminal-ish tint for a log line — errors red, warnings amber, checks green. */
function lineTint(ln: string): string {
  if (/error|failed|✗/i.test(ln)) return "#E08E88";
  if (/warn/i.test(ln)) return "#D9B96A";
  if (ln.includes("✓")) return "#7FBF98";
  return "#C9C9C9";
}

/**
 * The selected job's header + assembled logs with live-tail, rendered in the
 * design's dark terminal panel (dark in BOTH themes). The initial load
 * replaces; subsequent fetches append from the server's nextSeq cursor. While
 * the log is incomplete and auto-tail is on, it polls the tail every few
 * seconds (silently, so the panel doesn't flicker); it stops the moment the
 * server reports `complete`.
 */
function JobLogPanel({
  job,
  orgId,
  projectId,
  runId,
}: {
  job: JobView;
  orgId: string;
  projectId: string;
  runId: string;
}) {
  const { client } = useSession();
  const [content, setContent] = React.useState("");
  const [nextSeq, setNextSeq] = React.useState(0);
  const [complete, setComplete] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [autoTail, setAutoTail] = React.useState(true);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);
  // Guards against overlapping fetches if one tick's request outlives the interval.
  const inFlight = React.useRef(false);

  const fetchFrom = React.useCallback(
    async (seq: number, reset: boolean, silent = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (!silent) setLoading(true);
      const res = await wrap(() => client.state.readRunJobLogs(orgId, projectId, runId, job.jobId, seq));
      if (res.ok) {
        setContent((prev) => (reset ? res.data.content : prev + res.data.content));
        setNextSeq(res.data.nextSeq);
        setComplete(res.data.complete);
        setError(null);
      } else {
        setError({ code: res.error.code, message: res.error.message });
      }
      if (!silent) setLoading(false);
      inFlight.current = false;
    },
    [client, orgId, projectId, runId, job.jobId],
  );

  // Reload from the start whenever the selected job changes (keyed remount also
  // resets local state, but this drives the initial fetch).
  React.useEffect(() => {
    setContent("");
    setComplete(false);
    setAutoTail(true);
    void fetchFrom(0, true);
  }, [fetchFrom]);

  // Live-tail: while incomplete and auto-tail is on, poll the tail silently.
  React.useEffect(() => {
    if (!autoTail || complete) return;
    const id = setInterval(() => void fetchFrom(nextSeq, false, true), LOG_TAIL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoTail, complete, nextSeq, fetchFrom]);

  const lines = React.useMemo(() => (content ? content.replace(/\n$/, "").split("\n") : []), [content]);

  const liveJob = job.status === "running" || job.status === "claimed";
  const okJob = job.status === "succeeded";
  const badJob = job.status === "failed" || job.status === "timed_out";

  return (
    <div className="min-w-0 overflow-hidden rounded-xl bg-[#171717]">
      {/* panel header */}
      <div className="flex min-w-0 items-center gap-2.5 border-b border-[#333333] px-[18px] py-3">
        <span
          aria-hidden
          className={cn(
            "h-[7px] w-[7px] shrink-0 rounded-full",
            liveJob
              ? "animate-livepulse bg-[#7FA6E0]"
              : okJob
                ? "bg-[#7FBF98]"
                : badJob
                  ? "bg-[#E08E88]"
                  : "bg-[#707070]",
          )}
        />
        <span className="truncate font-mono text-[12.5px] font-semibold text-[#F0F0F0]">{job.name}</span>
        <span className="shrink-0 text-[11.5px] text-[#737373]">
          {complete ? "complete" : autoTail ? "streaming" : "paused"}
        </span>
        {job.attempt > 1 ? (
          <span className="hidden shrink-0 font-mono text-[11px] text-[#737373] sm:inline">
            attempt {job.attempt}
          </span>
        ) : null}
        {job.deps.length > 0 ? (
          <span
            className="hidden shrink-0 font-mono text-[11px] text-[#737373] sm:inline"
            title={job.deps.join(", ")}
          >
            needs {job.deps.length}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="font-mono text-[11px] text-[#737373]">{job.dur}</span>
          {complete ? null : (
            <>
              <button
                type="button"
                onClick={() => setAutoTail((on) => !on)}
                title={autoTail ? "Pause live tail" : "Resume live tail"}
                aria-pressed={autoTail}
                className={DARK_BTN}
              >
                {autoTail ? "Live" : "Paused"}
              </button>
              <button
                type="button"
                onClick={() => void fetchFrom(nextSeq, false)}
                disabled={loading}
                className={DARK_BTN}
              >
                Refresh
              </button>
            </>
          )}
        </div>
      </div>

      {/* failure summary banner */}
      {job.errorText ? (
        <div className="border-b border-[#333333] bg-[#C94A44]/15 px-[18px] py-2.5 font-mono text-[12px] text-[#E39A95]">
          {job.errorText}
        </div>
      ) : null}

      {/* terminal log body */}
      <div className="px-5 pb-5 pt-4 font-mono text-[12px] leading-[1.85] text-[#C9C9C9]">
        {error ? (
          <p className="text-[#E08E88]">
            {error.code}: {error.message}
          </p>
        ) : lines.length === 0 ? (
          <p className="text-[#737373]">{loading ? "Loading…" : "No log output for this job."}</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            {lines.map((ln, i) => (
              <div key={i} className="flex gap-3.5 whitespace-pre">
                <span className="shrink-0 select-none text-[#555555]">{String(i + 1).padStart(3, " ")}</span>
                <span style={{ color: lineTint(ln) }}>{ln || " "}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
