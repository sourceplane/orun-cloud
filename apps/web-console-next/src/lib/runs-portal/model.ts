/**
 * Runs-portal view-model (Activities redesign).
 *
 * The pure heart of the org-wide Activities feed and the run detail view: it
 * maps the platform's `Run[]` / `RunJob[]` projections into the row / live-card
 * / summary / facet / detail shapes the design renders, and reproduces the
 * design's status split, summary rollup, and facet logic against REAL data.
 *
 * Honest by construction: every field is derived from the run projection
 * (status, git provenance, environment, job counts, actor, timings). The design
 * carries fictional commit-message titles and per-step logs; we substitute the
 * run's real identity (branch → commit → run id) for the title and drive the
 * detail panel from the job's actual log stream, rather than fabricating them.
 *
 * Pure and dependency-free so the workbench, the run detail view, and the unit
 * tests share one mapping. Time-dependent output ("5m ago", elapsed duration)
 * takes an explicit `now` so it is deterministic under test.
 */

import type { Run, RunJob, RunStatus, ActorRef } from "@saas/contracts/state";
import { RUN_STATUS, JOB_STATUS, actorAvatar, sourceLabel, type StatusVisual, type ActorAvatar } from "./palette";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A run's branch: its git ref with the `refs/heads/` prefix stripped. */
export function branchOf(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const b = ref.replace(/^refs\/heads\//, "");
  return b || null;
}

/** Short commit sha (7 chars), or null. */
export function shortCommit(commit: string | null | undefined): string | null {
  if (!commit) return null;
  return commit.slice(0, 7);
}

/** A run is "live" while it has not reached a terminal state. */
export function isLive(status: RunStatus): boolean {
  return status === "running" || status === "pending";
}

/** Compact relative-past label, e.g. "just now" / "5m ago" / "2h ago" / "3d ago". */
export function formatRelative(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(diff / HOUR_MS);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(diff / DAY_MS)}d ago`;
}

/** Seconds between two ISO instants (end defaults to `now`); null if unstarted. */
export function durationSeconds(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  now: number,
): number | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return null;
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  return Math.max(0, Math.round((end - start) / 1000));
}

/** Human duration, e.g. "0m 20s" / "2m 38s" / "1h 04m"; "—" when unknown. */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Per-status job tallies + percentages for the row's stacked jobs bar. */
export interface JobsBar {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  queued: number;
  okPct: number;
  failPct: number;
  runPct: number;
  queuedPct: number;
  hasFail: boolean;
  /** Single-bar progress for live runs: finished + half of running, of total. */
  progress: number;
}

function jobsBar(counts: Run["jobCounts"]): JobsBar {
  const total = counts.queued + counts.running + counts.succeeded + counts.failed;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  return {
    total,
    succeeded: counts.succeeded,
    failed: counts.failed,
    running: counts.running,
    queued: counts.queued,
    okPct: pct(counts.succeeded),
    failPct: pct(counts.failed),
    runPct: pct(counts.running),
    queuedPct: pct(counts.queued),
    hasFail: counts.failed > 0,
    progress: total > 0 ? Math.round(((counts.succeeded + counts.running * 0.5) / total) * 100) : 0,
  };
}

/** A decorated run row — everything the table, live card, and mobile card need. */
export interface RunRow {
  /** React/list key, unique across repos. */
  key: string;
  runId: string;
  /** Truncated run id for the mono sub-line. */
  shortId: string;
  /** Owning project id (the row resolves its detail href from this). */
  projectId: string;
  /** Repo display label. */
  repo: string;
  /** Prominent title — branch → short commit → short id (honest substitute for
   *  the design's commit-message title, which the projection does not carry). */
  title: string;
  status: RunStatus;
  vis: StatusVisual;
  live: boolean;
  env: string | null;
  envLabel: string;
  branch: string | null;
  commit: string | null;
  commit7: string | null;
  /** "main · a1b2c3d" style provenance sub-line. */
  provenance: string;
  source: Run["source"];
  sourceLabel: string;
  actor: ActorAvatar;
  jobs: JobsBar;
  duration: string;
  /** Relative created time, e.g. "5m ago". */
  rel: string;
  createdAt: string;
  /** Raw created epoch ms (for summary bucketing). */
  createdMs: number;
}

/** Map one run projection into its decorated row. */
export function decorateRun(run: Run, repoLabel: string, now: number): RunRow {
  const vis = RUN_STATUS[run.status];
  const branch = branchOf(run.git.ref);
  const commit7 = shortCommit(run.git.commit);
  const title = branch ?? commit7 ?? run.runId.slice(0, 10);
  const provBits = [branch, commit7].filter((x): x is string => !!x);
  return {
    key: `${run.projectId}:${run.runId}`,
    runId: run.runId,
    shortId: run.runId.length > 12 ? `${run.runId.slice(0, 6)}…${run.runId.slice(-4)}` : run.runId,
    projectId: run.projectId,
    repo: repoLabel,
    title,
    status: run.status,
    vis,
    live: isLive(run.status),
    env: run.environment,
    envLabel: run.environment ?? "—",
    branch,
    commit: run.git.commit || null,
    commit7,
    provenance: provBits.length > 0 ? provBits.join(" · ") : "—",
    source: run.source,
    sourceLabel: sourceLabel(run.source),
    actor: actorAvatar(run.createdBy, run.source),
    jobs: jobsBar(run.jobCounts),
    duration: formatDuration(durationSeconds(run.startedAt, run.finishedAt, now)),
    rel: formatRelative(run.createdAt, now),
    createdAt: run.createdAt,
    createdMs: new Date(run.createdAt).getTime() || 0,
  };
}

/** Split decorated rows into the live (in-progress) and done buckets. */
export function splitRuns(rows: readonly RunRow[]): { live: RunRow[]; done: RunRow[] } {
  const live: RunRow[] = [];
  const done: RunRow[] = [];
  for (const r of rows) (r.live ? live : done).push(r);
  return { live, done };
}

// ── Status facets ────────────────────────────────────────────

/** The "all" facet plus one per real run status, in the design's order. */
export const FACET_DEFS: ReadonlyArray<{ key: "all" | RunStatus; label: string }> = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "succeeded", label: "Succeeded" },
  { key: "failed", label: "Failed" },
  { key: "pending", label: "Pending" },
  { key: "canceled", label: "Canceled" },
];

/** A rendered status facet pill: label, count over the feed, and active flag. */
export interface StatusFacet {
  key: "all" | RunStatus;
  label: string;
  count: number;
  active: boolean;
}

/**
 * Build the facet pills with counts over the currently-loaded feed. Status is a
 * CLIENT-side facet (counts always reflect the rows on screen), so a facet with
 * no rows still renders with a 0 — the design shows the full vocabulary.
 */
export function buildFacets(rows: readonly RunRow[], active: "all" | RunStatus): StatusFacet[] {
  return FACET_DEFS.map(({ key, label }) => ({
    key,
    label,
    count: key === "all" ? rows.length : rows.filter((r) => r.status === key).length,
    active: active === key,
  }));
}

/** Apply a status facet to a row set ("all" passes everything through). */
export function applyFacet(rows: readonly RunRow[], active: "all" | RunStatus): RunRow[] {
  return active === "all" ? [...rows] : rows.filter((r) => r.status === active);
}

// ── Summary strip ────────────────────────────────────────────

/** One sparkline bar: height in px and opacity. */
export interface SparkBar {
  h: number;
  op: number;
}

/** The five-up summary strip, computed over the loaded feed. */
export interface RunSummary {
  /** Runs created in the last 24h. */
  today: number;
  /** Success rate over finished (succeeded + failed) runs, 0–100. */
  rate: number;
  /** Runs currently running. */
  running: number;
  /** Runs failed in the last 24h. */
  failed: number;
  /** Median finished-run duration, formatted. */
  p50: string;
  /** 14-bucket histogram of runs-per-hour over the last 24h. */
  spark: SparkBar[];
}

const SPARK_BUCKETS = 14;
const SPARK_MIN_H = 5;
const SPARK_MAX_H = 24;

/** Compute the summary rollup + sparkline over the decorated feed. */
export function summarize(rows: readonly RunRow[], runs: readonly Run[], now: number): RunSummary {
  const dayAgo = now - DAY_MS;
  const today = rows.filter((r) => r.createdMs >= dayAgo).length;
  const succeeded = rows.filter((r) => r.status === "succeeded").length;
  const failedTotal = rows.filter((r) => r.status === "failed").length;
  const finished = succeeded + failedTotal;
  const rate = finished > 0 ? Math.round((succeeded / finished) * 100) : 0;
  const running = rows.filter((r) => r.status === "running").length;
  const failed = rows.filter((r) => r.status === "failed" && r.createdMs >= dayAgo).length;

  // Median finished-run duration from the raw projections (start → finish).
  const durs: number[] = [];
  for (const run of runs) {
    if (run.status !== "succeeded" && run.status !== "failed") continue;
    const d = durationSeconds(run.startedAt, run.finishedAt, now);
    if (d != null) durs.push(d);
  }
  durs.sort((a, b) => a - b);
  const p50 = durs.length > 0 ? formatDuration(durs[Math.floor((durs.length - 1) / 2)]!) : "—";

  // 14 hourly buckets across the last 24h; height scaled to the busiest bucket.
  const counts = new Array<number>(SPARK_BUCKETS).fill(0);
  const windowMs = SPARK_BUCKETS * HOUR_MS;
  const windowStart = now - windowMs;
  for (const r of rows) {
    if (r.createdMs < windowStart || r.createdMs > now) continue;
    const idx = Math.min(SPARK_BUCKETS - 1, Math.floor((r.createdMs - windowStart) / HOUR_MS));
    counts[idx]! += 1;
  }
  const max = Math.max(1, ...counts);
  const spark: SparkBar[] = counts.map((c) => ({
    h: Math.round(SPARK_MIN_H + (c / max) * (SPARK_MAX_H - SPARK_MIN_H)),
    op: c > 0 ? 0.9 : 0.22,
  }));

  return { today, rate, running, failed, p50, spark };
}

// ── Run detail ───────────────────────────────────────────────

/** A decorated job for the run detail jobs rail. */
export interface JobView {
  jobId: string;
  /** Display name — the acted-on component, else the job id. */
  name: string;
  status: RunJob["status"];
  vis: StatusVisual;
  /** Formatted job duration. */
  dur: string;
  deps: string[];
  attempt: number;
  errorText: string | null;
}

/** The run detail hero — the run's identity and provenance. */
export interface RunHero {
  runId: string;
  title: string;
  status: RunStatus;
  vis: StatusVisual;
  statusLabel: string;
  repo: string;
  env: string | null;
  envLabel: string;
  branch: string | null;
  commit7: string | null;
  /** "main @ a1b2c3d" provenance. */
  provenance: string;
  source: Run["source"];
  sourceLabel: string;
  actor: ActorAvatar;
  rel: string;
  duration: string;
  live: boolean;
}

/** Everything the run detail view renders, minus the (async) log stream. */
export interface RunDetailModel {
  hero: RunHero;
  jobs: JobView[];
  /** The job to select on first paint (first failed/running, else the first). */
  defaultJobId: string | null;
}

function heroOf(run: Run, repoLabel: string, now: number): RunHero {
  const vis = RUN_STATUS[run.status];
  const branch = branchOf(run.git.ref);
  const commit7 = shortCommit(run.git.commit);
  const provBits = [branch, commit7].filter((x): x is string => !!x);
  return {
    runId: run.runId,
    title: branch ?? commit7 ?? run.runId.slice(0, 10),
    status: run.status,
    vis,
    statusLabel: vis.label,
    repo: repoLabel,
    env: run.environment,
    envLabel: run.environment ?? "—",
    branch,
    commit7,
    provenance: provBits.length > 0 ? provBits.join(" @ ") : "—",
    source: run.source,
    sourceLabel: sourceLabel(run.source),
    actor: actorAvatar(run.createdBy, run.source),
    rel: formatRelative(run.createdAt, now),
    duration: formatDuration(durationSeconds(run.startedAt, run.finishedAt, now)),
    live: isLive(run.status),
  };
}

function decorateJob(job: RunJob, now: number): JobView {
  const vis = JOB_STATUS[job.status];
  return {
    jobId: job.jobId,
    name: job.component ?? job.jobId,
    status: job.status,
    vis,
    dur: formatDuration(durationSeconds(job.startedAt, job.finishedAt, now)),
    deps: job.deps,
    attempt: job.attempt,
    errorText: job.errorText,
  };
}

const JOB_ATTENTION = new Set<RunJob["status"]>(["failed", "timed_out", "running", "claimed"]);

/** Build the run detail view-model from a run projection and its plan-DAG jobs. */
export function buildRunDetail(
  run: Run,
  jobs: readonly RunJob[],
  repoLabel: string,
  now: number,
): RunDetailModel {
  const decorated = jobs.map((j) => decorateJob(j, now));
  const attention = decorated.find((j) => JOB_ATTENTION.has(j.status));
  return {
    hero: heroOf(run, repoLabel, now),
    jobs: decorated,
    defaultJobId: attention?.jobId ?? decorated[0]?.jobId ?? null,
  };
}

/** Convenience used by callers that only have an `ActorRef` (e.g. row tooltips). */
export function actorName(actor: ActorRef | null | undefined, source: Run["source"]): string {
  return actorAvatar(actor, source).name;
}
