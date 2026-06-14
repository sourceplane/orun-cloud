// An in-memory state.run_jobs / state.runs store that models the exact
// compare-and-set semantics the run-coordination repository relies on, so the
// contention + lease-recovery tests exercise the REAL repository SQL paths
// through createStateRepository(executor) — not a hand-rolled stand-in.
//
// The atomicity contract we model: each `execute(...)` call mutates the store
// SYNCHRONOUSLY (no await yields mid-statement), exactly as Postgres applies a
// single UPDATE under a row lock. That is what makes the claim conditional
// write a true compare-and-set: of N interleaved claims for one job, the first
// to run its synchronous UPDATE flips the row; the rest see status != 'queued'
// and match zero rows.

import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

export interface RunJobRow {
  id: string;
  org_id: string;
  project_id: string;
  run_id: string;
  job_id: string;
  component: string | null;
  deps: string[];
  status: string;
  runner_id: string | null;
  lease_expires_at: string | null;
  attempt: number;
  error_text: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  org_id: string;
  project_id: string;
  environment: string | null;
  run_ulid: string;
  plan_digest: string;
  source: string;
  status: string;
  git_commit: string | null;
  git_ref: string | null;
  git_dirty: boolean;
  labels: string;
  created_by: string | null;
  created_by_kind: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export class FakeRunStore {
  jobs: RunJobRow[] = [];
  runs: RunRow[] = [];
  /** A virtual clock so lease-expiry tests don't sleep. now() reads this. */
  clock = new Date("2026-06-14T10:00:00.000Z");
  executeCount = 0;

  now(): Date {
    return this.clock;
  }

  advance(seconds: number): void {
    this.clock = new Date(this.clock.getTime() + seconds * 1000);
  }

  addRun(over: Partial<RunRow> & Pick<RunRow, "id" | "org_id" | "project_id" | "run_ulid">): void {
    this.runs.push({
      environment: null,
      plan_digest: "sha256:" + "0".repeat(64),
      source: "cli",
      status: "pending",
      git_commit: null,
      git_ref: null,
      git_dirty: false,
      labels: "{}",
      created_by: null,
      created_by_kind: null,
      started_at: null,
      finished_at: null,
      created_at: this.clock.toISOString(),
      updated_at: this.clock.toISOString(),
      ...over,
    });
  }

  addJob(over: Partial<RunJobRow> & Pick<RunJobRow, "id" | "org_id" | "project_id" | "run_id" | "job_id">): void {
    this.jobs.push({
      component: null,
      deps: [],
      status: "queued",
      runner_id: null,
      lease_expires_at: null,
      attempt: 1,
      error_text: null,
      started_at: null,
      finished_at: null,
      created_at: this.clock.toISOString(),
      updated_at: this.clock.toISOString(),
      ...over,
    });
  }

  private depsSucceeded(job: RunJobRow): boolean {
    for (const dep of job.deps) {
      const ok = this.jobs.some(
        (d) => d.run_id === job.run_id && d.job_id === dep && d.status === "succeeded",
      );
      if (!ok) return false;
    }
    return true;
  }

  private leaseSecondsFromInterval(value: unknown): number {
    return Number(value);
  }

  /**
   * Interpret exactly the statements the repository emits. Synchronous mutation
   * (the returned Promise resolves already-applied) models single-statement
   * atomicity.
   */
  executor(): SqlExecutor {
    const store = this;
    return {
      execute<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<SqlExecutorResult<T>> {
        store.executeCount += 1;
        const rows = store.run(text, params) as unknown as T[];
        return Promise.resolve({ rows, rowCount: rows.length });
      },
    };
  }

  private run(text: string, params: unknown[]): Record<string, unknown>[] {
    const t = text.replace(/\s+/g, " ").trim();
    const now = this.clock;

    // Best-effort event/audit writes from the sweep + handlers — no-op in the
    // store (the events repo is exercised in its own package tests).
    if (t.includes("events.event_log") || t.includes("events.audit_entries")) {
      return [{ _event: {}, _audit: {} }];
    }

    // ── Claim: UPDATE … SET status='claimed' … WHERE status='queued' AND deps ──
    if (t.startsWith("UPDATE state.run_jobs j SET status = 'claimed'")) {
      const [orgId, projectId, runId, jobId, runnerId, leaseSecStr] = params as string[];
      const job = this.jobs.find(
        (r) => r.org_id === orgId && r.project_id === projectId && r.run_id === runId && r.job_id === jobId,
      );
      if (!job || job.status !== "queued" || !this.depsSucceeded(job)) return [];
      job.status = "claimed";
      job.runner_id = runnerId!;
      job.lease_expires_at = new Date(now.getTime() + this.leaseSecondsFromInterval(leaseSecStr) * 1000).toISOString();
      job.started_at = job.started_at ?? now.toISOString();
      job.updated_at = now.toISOString();
      return [{ ...job, deps: JSON.stringify(job.deps) }];
    }

    // ── Heartbeat: UPDATE … SET lease_expires_at = … WHERE runner & live lease ──
    if (t.startsWith("UPDATE state.run_jobs SET lease_expires_at =") && t.includes("status = CASE WHEN status = 'claimed'")) {
      const [orgId, projectId, runId, jobId, runnerId, leaseSecStr] = params as string[];
      const job = this.jobs.find(
        (r) => r.org_id === orgId && r.project_id === projectId && r.run_id === runId && r.job_id === jobId,
      );
      if (
        !job ||
        job.runner_id !== runnerId ||
        !(job.status === "claimed" || job.status === "running") ||
        !job.lease_expires_at ||
        new Date(job.lease_expires_at) <= now
      ) {
        return [];
      }
      job.lease_expires_at = new Date(now.getTime() + this.leaseSecondsFromInterval(leaseSecStr) * 1000).toISOString();
      if (job.status === "claimed") job.status = "running";
      job.updated_at = now.toISOString();
      return [{ ...job, deps: JSON.stringify(job.deps) }];
    }

    // ── Update (terminal transition): UPDATE … SET status=$6 … runner & lease ──
    if (t.startsWith("UPDATE state.run_jobs SET status = $6, error_text = $7, finished_at = now()")) {
      const [orgId, projectId, runId, jobId, runnerId, status, errorText] = params as string[];
      const job = this.jobs.find(
        (r) => r.org_id === orgId && r.project_id === projectId && r.run_id === runId && r.job_id === jobId,
      );
      if (
        !job ||
        job.runner_id !== runnerId ||
        !(job.status === "claimed" || job.status === "running") ||
        !job.lease_expires_at ||
        new Date(job.lease_expires_at) <= now
      ) {
        return [];
      }
      job.status = status!;
      job.error_text = errorText ?? null;
      job.finished_at = now.toISOString();
      job.lease_expires_at = null;
      job.updated_at = now.toISOString();
      return [{ ...job, deps: JSON.stringify(job.deps) }];
    }

    // ── Sweep re-queue ──
    if (t.startsWith("UPDATE state.run_jobs SET status = 'queued', runner_id = NULL")) {
      const [nowIso, maxAttempts, limit] = params as [string, number, number];
      const cutoff = new Date(nowIso);
      const candidates = this.jobs
        .filter(
          (j) =>
            (j.status === "claimed" || j.status === "running") &&
            j.lease_expires_at !== null &&
            new Date(j.lease_expires_at) <= cutoff &&
            j.attempt < maxAttempts,
        )
        .sort((a, b) => (a.lease_expires_at! < b.lease_expires_at! ? -1 : 1))
        .slice(0, limit);
      const out: Record<string, unknown>[] = [];
      for (const job of candidates) {
        job.status = "queued";
        job.runner_id = null;
        job.lease_expires_at = null;
        job.attempt += 1;
        job.updated_at = now.toISOString();
        out.push({ ...job, deps: JSON.stringify(job.deps) });
      }
      return out;
    }

    // ── Sweep timeout ──
    if (t.startsWith("UPDATE state.run_jobs SET status = 'timed_out'")) {
      const [nowIso, maxAttempts, limit] = params as [string, number, number];
      const cutoff = new Date(nowIso);
      const candidates = this.jobs
        .filter(
          (j) =>
            (j.status === "claimed" || j.status === "running") &&
            j.lease_expires_at !== null &&
            new Date(j.lease_expires_at) <= cutoff &&
            j.attempt >= maxAttempts,
        )
        .sort((a, b) => (a.lease_expires_at! < b.lease_expires_at! ? -1 : 1))
        .slice(0, limit);
      const out: Record<string, unknown>[] = [];
      for (const job of candidates) {
        job.status = "timed_out";
        job.lease_expires_at = null;
        job.finished_at = now.toISOString();
        job.error_text = job.error_text ?? "Lease lapsed after maximum attempts";
        job.updated_at = now.toISOString();
        out.push({ ...job, deps: JSON.stringify(job.deps) });
      }
      return out;
    }

    // ── Cancel jobs ──
    if (t.startsWith("UPDATE state.run_jobs SET status = 'canceled'")) {
      const [orgId, projectId, runId] = params as string[];
      for (const job of this.jobs) {
        if (
          job.org_id === orgId &&
          job.project_id === projectId &&
          job.run_id === runId &&
          !["succeeded", "failed", "timed_out", "canceled"].includes(job.status)
        ) {
          job.status = "canceled";
          job.lease_expires_at = null;
          job.finished_at = job.finished_at ?? now.toISOString();
          job.updated_at = now.toISOString();
        }
      }
      return [];
    }

    // ── Cancel run ──
    if (t.startsWith("UPDATE state.runs SET status = 'canceled'")) {
      const [orgId, projectId, id] = params as string[];
      const run = this.runs.find((r) => r.org_id === orgId && r.project_id === projectId && r.id === id);
      if (!run || ["succeeded", "failed", "canceled"].includes(run.status)) return [];
      run.status = "canceled";
      run.finished_at = run.finished_at ?? now.toISOString();
      run.updated_at = now.toISOString();
      return [{ ...run }];
    }

    // ── Reconcile run status ──
    if (t.startsWith("UPDATE state.runs SET status = $4")) {
      const [orgId, projectId, id, next, isTerminal] = params as [string, string, string, string, boolean];
      const run = this.runs.find((r) => r.org_id === orgId && r.project_id === projectId && r.id === id);
      if (!run || ["succeeded", "failed", "canceled"].includes(run.status)) return [];
      run.status = next;
      if (next === "running" && !run.started_at) run.started_at = now.toISOString();
      if (isTerminal) run.finished_at = now.toISOString();
      run.updated_at = now.toISOString();
      return [{ ...run }];
    }

    // ── Reconcile tally (COUNT … FILTER …) ──
    if (t.includes("COUNT(*) AS total") && t.includes("FROM state.run_jobs")) {
      const [orgId, projectId, runId] = params as string[];
      const jobs = this.jobs.filter((j) => j.org_id === orgId && j.project_id === projectId && j.run_id === runId);
      const terminalSet = ["succeeded", "failed", "timed_out", "canceled"];
      return [
        {
          total: jobs.length,
          terminal: jobs.filter((j) => terminalSet.includes(j.status)).length,
          active: jobs.filter((j) => ["claimed", "running"].includes(j.status)).length,
          failed: jobs.filter((j) => ["failed", "timed_out"].includes(j.status)).length,
        },
      ];
    }

    // ── Job counts ──
    if (t.includes("COUNT(*) FILTER (WHERE status = 'queued')")) {
      const [orgId, projectId, runId] = params as string[];
      const jobs = this.jobs.filter((j) => j.org_id === orgId && j.project_id === projectId && j.run_id === runId);
      return [
        {
          queued: jobs.filter((j) => j.status === "queued").length,
          running: jobs.filter((j) => ["claimed", "running"].includes(j.status)).length,
          succeeded: jobs.filter((j) => j.status === "succeeded").length,
          failed: jobs.filter((j) => ["failed", "timed_out"].includes(j.status)).length,
        },
      ];
    }

    // ── Runnable frontier ──
    if (t.startsWith("SELECT j.* FROM state.run_jobs j") && t.includes("j.status = 'queued'")) {
      const [orgId, projectId, runId] = params as string[];
      const out = this.jobs
        .filter(
          (j) =>
            j.org_id === orgId &&
            j.project_id === projectId &&
            j.run_id === runId &&
            j.status === "queued" &&
            this.depsSucceeded(j),
        )
        .sort((a, b) => (a.job_id < b.job_id ? -1 : 1))
        .map((j) => ({ ...j, deps: JSON.stringify(j.deps) }));
      return out;
    }

    // ── List jobs ──
    if (t.startsWith("SELECT * FROM state.run_jobs WHERE org_id = $1 AND project_id = $2 AND run_id = $3 ORDER BY job_id")) {
      const [orgId, projectId, runId] = params as string[];
      return this.jobs
        .filter((j) => j.org_id === orgId && j.project_id === projectId && j.run_id === runId)
        .sort((a, b) => (a.job_id < b.job_id ? -1 : 1))
        .map((j) => ({ ...j, deps: JSON.stringify(j.deps) }));
    }

    // ── Get single job ──
    if (t.startsWith("SELECT * FROM state.run_jobs WHERE org_id = $1 AND project_id = $2 AND run_id = $3 AND job_id = $4")) {
      const [orgId, projectId, runId, jobId] = params as string[];
      const job = this.jobs.find(
        (j) => j.org_id === orgId && j.project_id === projectId && j.run_id === runId && j.job_id === jobId,
      );
      return job ? [{ ...job, deps: JSON.stringify(job.deps) }] : [];
    }

    // ── Get run by id ──
    if (t.startsWith("SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND id = $3")) {
      const [orgId, projectId, id] = params as string[];
      const run = this.runs.find((r) => r.org_id === orgId && r.project_id === projectId && r.id === id);
      return run ? [{ ...run }] : [];
    }

    // ── Get run by ulid ──
    if (t.startsWith("SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid = $3")) {
      const [orgId, projectId, ulid] = params as string[];
      const run = this.runs.find((r) => r.org_id === orgId && r.project_id === projectId && r.run_ulid === ulid);
      return run ? [{ ...run }] : [];
    }

    throw new Error(`FakeRunStore: unhandled SQL: ${t.slice(0, 120)}`);
  }
}
