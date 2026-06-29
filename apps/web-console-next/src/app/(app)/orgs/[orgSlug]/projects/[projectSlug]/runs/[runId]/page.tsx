"use client";

// OV7 — the run detail view. One run's projection (status, provenance, timings)
// plus its plan-DAG jobs (status, component, deps, attempt, failure summary).
// Read-only; consumes getRun + listRunJobs (OV7.4 SDK). Project-scoped like the
// runs list (resolves projectSlug → projectId via the projects list).

import * as React from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Play } from "lucide-react";
import type { Run, RunStatus, RunJob, RunJobStatus } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { wrap } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

function runStatusVariant(status: RunStatus): "success" | "destructive" | "warning" | "secondary" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "destructive";
    case "running":
    case "pending":
      return "warning";
    case "canceled":
      return "secondary";
  }
}

function jobStatusVariant(status: RunJobStatus): "success" | "destructive" | "warning" | "secondary" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
    case "timed_out":
      return "destructive";
    case "running":
    case "claimed":
      return "warning";
    case "queued":
    case "canceled":
      return "secondary";
  }
}

const fmt = formatTimestamp;

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
  const [openJob, setOpenJob] = React.useState<string | null>(null);

  const projectsList = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = React.useMemo(
    () => projectsList.data?.find((p) => p.slug === projectSlug) ?? null,
    [projectsList.data, projectSlug],
  );
  const projectId = project?.id ?? "pending";

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

  const backLink = (
    <Link
      href={runsHref}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Back to activities
    </Link>
  );

  if (projectsList.loading || (project && run.loading)) {
    return (
      <div className="space-y-5">
        {backLink}
        <Card>
          <CardContent className="space-y-2 pt-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }
  if (projectsList.error || !project) {
    return (
      <div className="space-y-5">
        {backLink}
        <EmptyState icon={Play} title="Run not found" description={`No repo "${projectSlug}" in this workspace.`} />
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
  return (
    <div className="space-y-5">
      {backLink}

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate font-mono text-lg font-semibold tracking-tight">{r.runId}</h1>
          <p className="text-sm text-muted-foreground">{r.source === "ci" ? "CI run" : "CLI run"}</p>
        </div>
        <Badge variant={runStatusVariant(r.status)}>{r.status}</Badge>
      </header>

      <Card>
        <CardContent className="pt-6">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <Pair label="Environment" value={r.environment ?? "—"} />
            <Pair label="Commit" value={r.git.commit ? r.git.commit.slice(0, 12) : "—"} mono />
            <Pair label="Ref" value={r.git.ref ?? "—"} mono />
            <Pair label="Plan digest" value={r.planDigest.slice(0, 19)} mono />
            <Pair label="Created" value={fmt(r.createdAt)} />
            <Pair label="Started" value={fmt(r.startedAt)} />
            <Pair label="Finished" value={fmt(r.finishedAt)} />
            <Pair
              label="Jobs"
              value={`${r.jobCounts.succeeded}✓ ${r.jobCounts.failed}✗ ${r.jobCounts.running + r.jobCounts.queued}⋯`}
            />
          </dl>
        </CardContent>
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Jobs</h2>
        {jobs.loading ? (
          <Card>
            <CardContent className="space-y-2 pt-6">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </CardContent>
          </Card>
        ) : jobs.error ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">{jobs.error.code}</CardTitle>
              <CardDescription>{jobs.error.message}</CardDescription>
            </CardHeader>
          </Card>
        ) : !jobs.data || jobs.data.length === 0 ? (
          <EmptyState icon={Play} title="No jobs" description="This run has no jobs in its plan DAG." />
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Component</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Deps</TableHead>
                  <TableHead>Attempt</TableHead>
                  <TableHead>Finished</TableHead>
                  <TableHead className="text-right">Logs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.data.map((j: RunJob) => (
                  <TableRow key={j.jobId}>
                    <TableCell className="font-mono text-xs">{j.jobId}</TableCell>
                    <TableCell className="text-sm">
                      {j.component ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={jobStatusVariant(j.status)}>{j.status}</Badge>
                      {j.errorText ? (
                        <span className="ml-2 text-xs text-muted-foreground" title={j.errorText}>
                          {j.errorText.length > 48 ? `${j.errorText.slice(0, 48)}…` : j.errorText}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{j.deps.length > 0 ? j.deps.join(", ") : "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{j.attempt}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmt(j.finishedAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={openJob === j.jobId ? "secondary" : "ghost"}
                        onClick={() => setOpenJob((cur) => (cur === j.jobId ? null : j.jobId))}
                      >
                        Logs
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}

        {openJob ? (
          <JobLogs
            orgId={orgId}
            projectId={projectId}
            runId={runId}
            jobId={openJob}
            onClose={() => setOpenJob(null)}
          />
        ) : null}
      </section>
    </div>
  );
}

/** How often live-tail polls the log tail while a job is still producing output. */
const LOG_TAIL_INTERVAL_MS = 3000;

/**
 * A job's assembled logs with live-tail. The initial load replaces; subsequent
 * fetches append from the server's nextSeq cursor. While the log is incomplete
 * and auto-tail is on, it polls the tail every few seconds (silently, so the
 * panel doesn't flicker); it stops the moment the server reports `complete`.
 */
function JobLogs({
  orgId,
  projectId,
  runId,
  jobId,
  onClose,
}: {
  orgId: string;
  projectId: string;
  runId: string;
  jobId: string;
  onClose: () => void;
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

  // Fetch from `seq`; reset replaces (initial load), else append (tail). `silent`
  // skips the loading flag so the periodic tail doesn't visibly flicker.
  const fetchFrom = React.useCallback(
    async (seq: number, reset: boolean, silent = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (!silent) setLoading(true);
      const res = await wrap(() => client.state.readRunJobLogs(orgId, projectId, runId, jobId, seq));
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
    [client, orgId, projectId, runId, jobId],
  );

  // Reload from the start whenever the selected job changes.
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="font-mono text-sm">{jobId} · logs</CardTitle>
        <div className="flex items-center gap-2">
          {complete ? (
            <Badge variant="secondary">complete</Badge>
          ) : (
            <>
              <Button
                size="sm"
                variant={autoTail ? "secondary" : "outline"}
                onClick={() => setAutoTail((on) => !on)}
                title={autoTail ? "Pause live tail" : "Resume live tail"}
                aria-label="Live-tail logs"
                aria-pressed={autoTail}
              >
                {autoTail ? "Live" : "Paused"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void fetchFrom(nextSeq, false)} loading={loading}>
                Refresh
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-destructive">
            {error.code}: {error.message}
          </p>
        ) : content.length === 0 ? (
          <p className="text-sm text-muted-foreground">{loading ? "Loading…" : "No log output for this job."}</p>
        ) : (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 font-mono text-[11px] leading-relaxed">
            {content}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function Pair({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-dashed py-1 last:border-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={mono ? "truncate font-mono text-xs" : "truncate"} title={value}>
        {value}
      </dd>
    </div>
  );
}
