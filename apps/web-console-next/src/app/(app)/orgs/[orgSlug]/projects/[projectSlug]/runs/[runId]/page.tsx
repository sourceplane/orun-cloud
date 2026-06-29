"use client";

// The run detail view (OV7), redesigned to the visual contract
// (`specs/epics/saas-catalog-portal/design/Service_Catalog.dc.html` → run
// detail): a status hero (identity + provenance + actor), a jobs rail, and a
// terminal-style log panel for the selected job with live-tail.
//
// One run's projection (status, provenance, timings, job counts) plus its
// plan-DAG jobs (status, component, deps, attempt, failure summary, logs).
// Read-only; consumes getRun + listRunJobs + readRunJobLogs (OV7.4 SDK).
// Project-scoped like the runs list (resolves projectSlug → projectId via the
// projects list). The design's per-step logs are substituted with each JOB's
// real assembled log stream — we don't fabricate steps the projection lacks.

import * as React from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Play } from "lucide-react";
import type { Run, RunJob } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { wrap } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { buildRunDetail, type JobView } from "@/lib/runs-portal/model";
import { StatusMark, ActorChip } from "@/components/activity/run-status-icon";

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

  const backLink = (
    <div className="flex h-[34px] items-center gap-2.5 text-[13px] text-muted-foreground">
      <span className="text-muted-foreground/80">{orgSlug}</span>
      <span className="text-muted-foreground/40">/</span>
      <Link href={runsHref} className="transition-colors hover:text-foreground">
        Activity
      </Link>
      <span className="text-muted-foreground/40">/</span>
      <span className="truncate font-mono text-foreground">{runId}</span>
      <Link
        href={runsHref}
        className="ml-auto inline-flex items-center gap-1.5 rounded-[7px] border border-border px-[11px] py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All runs
      </Link>
    </div>
  );

  if (projectsList.loading || (project && run.loading)) {
    return (
      <div className="space-y-5">
        {backLink}
        <Skeleton className="h-[68px] w-full rounded-xl" />
        <div className="grid grid-cols-1 gap-[18px] md:grid-cols-[248px_minmax(0,1fr)]">
          <Skeleton className="h-[260px] w-full rounded-[13px]" />
          <Skeleton className="h-[260px] w-full rounded-[13px]" />
        </div>
      </div>
    );
  }
  if (projectsList.error || !project) {
    return (
      <div className="space-y-5">
        {backLink}
        <EmptyState icon={Play} title="Run not found" description={`No repo "${projectSlug}" in this organization.`} />
      </div>
    );
  }
  if (run.error || !run.data) {
    return (
      <div className="space-y-5">
        {backLink}
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{run.error?.code ?? "not_found"}</CardTitle>
            <CardDescription>{run.error?.message ?? `Run ${runId} was not found.`}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const r: Run = run.data;
  const jobList: RunJob[] = jobs.data ?? [];
  const detail = buildRunDetail(r, jobList, repoLabel, now);
  const activeJobId = selectedJob ?? detail.defaultJobId;
  const activeJob = detail.jobs.find((j) => j.jobId === activeJobId) ?? detail.jobs[0] ?? null;

  return (
    <div className="space-y-5">
      {backLink}

      {/* HERO */}
      <div className="flex items-start gap-[15px]">
        <StatusMark vis={detail.hero.vis} box={42} glyph={20} radius={11} strokeWidth={2.2} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 truncate text-[19px] font-semibold tracking-[-0.01em] text-foreground">
              {detail.hero.title}
            </h1>
            <span className="text-[12.5px]" style={{ color: detail.hero.vis.color }}>
              {detail.hero.statusLabel}
            </span>
          </div>
          <div className="mt-[9px] flex flex-wrap items-center gap-2 font-mono text-[12px] text-muted-foreground/70">
            <span className="text-muted-foreground">{detail.hero.repo}</span>
            <Dot />
            <span>{detail.hero.runId}</span>
            <Dot />
            <span>{detail.hero.provenance}</span>
            <span className="inline-flex h-[19px] items-center rounded-[5px] border border-border bg-muted px-[7px] text-muted-foreground">
              {detail.hero.envLabel}
            </span>
          </div>
          <div className="mt-[10px] flex flex-wrap items-center gap-2">
            <ActorChip actor={detail.hero.actor} box={18} />
            <span className="text-[12px] text-muted-foreground">
              {detail.hero.actor.name} triggered via {detail.hero.sourceLabel}
            </span>
            <span className="font-mono text-[12px] text-muted-foreground/70" title={formatTimestamp(r.createdAt)}>
              · {detail.hero.rel} · {detail.hero.duration}
            </span>
          </div>
        </div>
      </div>

      {/* JOBS + LOGS */}
      {jobs.loading ? (
        <div className="grid grid-cols-1 gap-[18px] md:grid-cols-[248px_minmax(0,1fr)]">
          <Skeleton className="h-[260px] w-full rounded-[13px]" />
          <Skeleton className="h-[260px] w-full rounded-[13px]" />
        </div>
      ) : jobs.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{jobs.error.code}</CardTitle>
            <CardDescription>{jobs.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : detail.jobs.length === 0 ? (
        <EmptyState icon={Play} title="No jobs" description="This run has no jobs in its plan DAG." />
      ) : (
        <div className="grid grid-cols-1 items-start gap-[18px] md:grid-cols-[248px_minmax(0,1fr)]">
          {/* jobs rail */}
          <div className="rounded-[13px] border border-border bg-card p-2">
            <div className="flex items-center gap-[7px] px-[9px] pb-[9px] pt-[7px]">
              <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">Jobs</span>
              <span className="font-mono text-[11px] text-muted-foreground/70">{detail.jobs.length}</span>
            </div>
            {detail.jobs.map((j) => {
              const active = j.jobId === activeJob?.jobId;
              return (
                <button
                  key={j.jobId}
                  type="button"
                  onClick={() => setSelectedJob(j.jobId)}
                  className="mb-0.5 flex w-full items-center gap-2.5 rounded-[9px] border px-2.5 py-[9px] text-left transition-colors"
                  style={{
                    borderColor: active ? "hsl(var(--border))" : "transparent",
                    background: active ? "hsl(var(--primary) / 0.07)" : "transparent",
                  }}
                >
                  <StatusMark vis={j.vis} box={18} glyph={13} radius={5} strokeWidth={2.2} />
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[13px]"
                    style={{ color: active ? "hsl(var(--foreground))" : "hsl(var(--foreground) / 0.85)" }}
                  >
                    {j.name}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">{j.dur}</span>
                </button>
              );
            })}
          </div>

          {/* selected job: header + log stream */}
          {activeJob ? (
            <JobLogPanel
              key={activeJob.jobId}
              job={activeJob}
              orgId={orgId}
              projectId={projectId}
              runId={runId}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function Dot() {
  return <span className="text-muted-foreground/40">·</span>;
}

/** How often live-tail polls the log tail while a job is still producing output. */
const LOG_TAIL_INTERVAL_MS = 3000;

/**
 * The selected job's header + assembled logs with live-tail, rendered in the
 * design's terminal panel. The initial load replaces; subsequent fetches append
 * from the server's nextSeq cursor. While the log is incomplete and auto-tail is
 * on, it polls the tail every few seconds (silently, so the panel doesn't
 * flicker); it stops the moment the server reports `complete`.
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

  return (
    <div className="overflow-hidden rounded-[13px] border border-border bg-card">
      {/* panel header */}
      <div className="flex items-center gap-2.5 border-b border-border bg-muted/40 px-4 py-[13px]">
        <StatusMark vis={job.vis} box={20} glyph={14} radius={5} strokeWidth={2.2} />
        <span className="font-mono text-[13.5px] font-semibold text-foreground">{job.name}</span>
        {job.attempt > 1 ? (
          <span className="font-mono text-[11.5px] text-muted-foreground/70">attempt {job.attempt}</span>
        ) : null}
        {job.deps.length > 0 ? (
          <span className="hidden font-mono text-[11.5px] text-muted-foreground/70 sm:inline" title={job.deps.join(", ")}>
            needs {job.deps.length}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[12px] text-muted-foreground/70">{job.dur}</span>
          {complete ? (
            <span className="rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              complete
            </span>
          ) : (
            <>
              <Button
                size="sm"
                variant={autoTail ? "secondary" : "outline"}
                onClick={() => setAutoTail((on) => !on)}
                title={autoTail ? "Pause live tail" : "Resume live tail"}
                aria-pressed={autoTail}
              >
                {autoTail ? "Live" : "Paused"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void fetchFrom(nextSeq, false)} loading={loading}>
                Refresh
              </Button>
            </>
          )}
        </div>
      </div>

      {/* failure summary banner */}
      {job.errorText ? (
        <div
          className="border-b border-border px-4 py-2.5 font-mono text-[12px]"
          style={{ background: "hsl(var(--destructive) / 0.08)", color: "hsl(var(--destructive))" }}
        >
          {job.errorText}
        </div>
      ) : null}

      {/* terminal log body */}
      <div className="bg-background px-4 py-3 font-mono text-[12px] leading-[1.7]">
        {error ? (
          <p className="text-destructive">
            {error.code}: {error.message}
          </p>
        ) : lines.length === 0 ? (
          <p className="text-muted-foreground/60">{loading ? "Loading…" : "No log output for this job."}</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            {lines.map((ln, i) => (
              <div key={i} className="flex gap-3.5">
                <span className="shrink-0 select-none text-muted-foreground/30">{String(i + 1).padStart(3, " ")}</span>
                <span className="min-w-0 whitespace-pre-wrap break-words text-foreground/80">{ln || " "}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
