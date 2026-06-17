import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";
import type {
  ActorStamp,
  AdvanceCatalogHeadInput,
  AppendLogChunkInput,
  CatalogEntity,
  CatalogEntityRelation,
  CatalogHead,
  ClaimRunJobInput,
  ClaimRunJobOutcome,
  CreateRunInput,
  CreateRunJobInput,
  CreateRunOutcome,
  CreateWorkspaceLinkInput,
  CursorPosition,
  HeartbeatOutcome,
  HeartbeatRunJobInput,
  ListCatalogEntitiesQuery,
  ListRunsQuery,
  LogChunk,
  PagedResult,
  PageQueryParams,
  Run,
  RunJob,
  RunJobCounts,
  RunStatus,
  StateObject,
  StateObjectKind,
  StateRef,
  StateRepository,
  StateResult,
  SweptJob,
  UpdateRefInput,
  UpdateRefOutcome,
  UpdateRunJobInput,
  UpdateRunJobOutcome,
  UpsertCatalogEntityInput,
  UpsertObjectInput,
  UpsertObjectOutcome,
  WorkspaceLink,
} from "./types.js";

// ── Helpers ─────────────────────────────────────────────────

function safeError(message: string): StateResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23503"
  );
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}

function dateOrNull(v: unknown): Date | null {
  return v == null ? null : toDate(v);
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function actorOf(row: Record<string, unknown>, idCol: string, kindCol: string): ActorStamp {
  return {
    id: (row[idCol] as string) ?? null,
    kind: (row[kindCol] as ActorStamp["kind"]) ?? null,
  };
}

// ── Row mappers ─────────────────────────────────────────────

function mapRun(row: Record<string, unknown>): Run {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: row.project_id as string,
    environment: (row.environment as string) ?? null,
    runUlid: row.run_ulid as string,
    planDigest: row.plan_digest as string,
    source: row.source as Run["source"],
    status: row.status as Run["status"],
    gitCommit: (row.git_commit as string) ?? null,
    gitRef: (row.git_ref as string) ?? null,
    gitDirty: row.git_dirty as boolean,
    labels: parseJson<Record<string, string>>(row.labels) ?? {},
    createdBy: actorOf(row, "created_by", "created_by_kind"),
    startedAt: dateOrNull(row.started_at),
    finishedAt: dateOrNull(row.finished_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapRunJob(row: Record<string, unknown>): RunJob {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: row.project_id as string,
    runId: row.run_id as string,
    jobId: row.job_id as string,
    component: (row.component as string) ?? null,
    deps: parseJson<string[]>(row.deps) ?? [],
    status: row.status as RunJob["status"],
    runnerId: (row.runner_id as string) ?? null,
    leaseExpiresAt: dateOrNull(row.lease_expires_at),
    attempt: Number(row.attempt),
    errorText: (row.error_text as string) ?? null,
    startedAt: dateOrNull(row.started_at),
    finishedAt: dateOrNull(row.finished_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapObject(row: Record<string, unknown>): StateObject {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: row.project_id as string,
    digest: row.digest as string,
    kind: row.kind as StateObjectKind,
    sizeBytes: Number(row.size_bytes),
    createdBy: actorOf(row, "created_by", "created_by_kind"),
    createdAt: toDate(row.created_at),
  };
}

function mapLogChunk(row: Record<string, unknown>): LogChunk {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: row.project_id as string,
    runId: row.run_id as string,
    jobId: row.job_id as string,
    seq: Number(row.seq),
    byteLength: Number(row.byte_length),
    createdAt: toDate(row.created_at),
  };
}

function mapRef(row: Record<string, unknown>): StateRef {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    target: row.target as string,
    writer: (row.writer as string) ?? null,
    updatedAt: toDate(row.updated_at),
  };
}

function mapCatalogHead(row: Record<string, unknown>): CatalogHead {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: row.project_id as string,
    environment: (row.environment as string) ?? null,
    digest: row.digest as string,
    commit: (row.commit as string) ?? null,
    advancedBy: actorOf(row, "advanced_by", "advanced_by_kind"),
    advancedAt: toDate(row.advanced_at),
  };
}

function mapCatalogEntity(row: Record<string, unknown>): CatalogEntity {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: row.project_id as string,
    headDigest: row.head_digest as string,
    entityRef: row.entity_ref as string,
    kind: row.kind as string,
    name: row.name as string,
    owner: (row.owner as string) ?? null,
    lifecycle: (row.lifecycle as string) ?? null,
    relations: parseJson<CatalogEntityRelation[]>(row.relations) ?? [],
    createdAt: toDate(row.created_at),
  };
}

function mapWorkspaceLink(row: Record<string, unknown>): WorkspaceLink {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: row.project_id as string,
    remoteUrl: row.remote_url as string,
    status: row.status as WorkspaceLink["status"],
    provider: (row.provider as string) ?? null,
    providerRepoId: (row.provider_repo_id as string) ?? null,
    providerOwnerId: (row.provider_owner_id as string) ?? null,
    providerOwnerLogin: (row.provider_owner_login as string) ?? null,
    createdBy: actorOf(row, "created_by", "created_by_kind"),
    lastSeenAt: dateOrNull(row.last_seen_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

// ── Cursor pagination helper ────────────────────────────────

async function pagedList<T>(
  executor: SqlExecutor,
  sql: string,
  values: unknown[],
  limit: number,
  cursor: CursorPosition | null,
  mapper: (row: Record<string, unknown>) => T,
  cursorDateField = "created_at",
): Promise<StateResult<PagedResult<T>>> {
  try {
    const fetchLimit = limit + 1;
    let fullSql: string;
    let fullValues: unknown[];
    const baseIdx = values.length;

    if (cursor) {
      fullSql = `${sql} AND (${cursorDateField}, id) < ($${baseIdx + 2}, $${baseIdx + 3}) ORDER BY ${cursorDateField} DESC, id DESC LIMIT $${baseIdx + 1}`;
      fullValues = [...values, fetchLimit, cursor.createdAt, cursor.id];
    } else {
      fullSql = `${sql} ORDER BY ${cursorDateField} DESC, id DESC LIMIT $${baseIdx + 1}`;
      fullValues = [...values, fetchLimit];
    }

    const result = await executor.execute<Record<string, unknown>>(fullSql, fullValues);
    const rows = result.rows.map(mapper);
    let nextCursor: CursorPosition | null = null;
    if (rows.length > limit) {
      rows.pop();
      const last = rows[rows.length - 1]!;
      nextCursor = {
        createdAt: (last as unknown as { createdAt: Date }).createdAt.toISOString(),
        id: (last as unknown as { id: string }).id,
      };
    }
    return { ok: true, value: { items: rows, nextCursor } };
  } catch {
    return safeError("Failed to list records");
  }
}

// ── Repository factory ──────────────────────────────────────

export function createStateRepository(executor: SqlExecutor): StateRepository {
  return {
    // ── Runs ─────────────────────────────────────────────────

    async createRun(input: CreateRunInput): Promise<StateResult<CreateRunOutcome>> {
      try {
        // Idempotent create: a replayed ULID (same org/project/run_ulid) is a
        // no-op that returns the existing run with created=false.
        const inserted = await executor.execute<Record<string, unknown>>(
          `INSERT INTO state.runs
             (id, org_id, project_id, environment, run_ulid, plan_digest, source,
              status, git_commit, git_ref, git_dirty, labels, created_by,
              created_by_kind, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11::text::jsonb, $12, $13, now(), now())
           ON CONFLICT (org_id, project_id, run_ulid) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId,
            input.environment ?? null,
            input.runUlid,
            input.planDigest,
            input.source,
            input.gitCommit ?? null,
            input.gitRef ?? null,
            input.gitDirty ?? false,
            JSON.stringify(input.labels ?? {}),
            input.createdBy?.id ?? null,
            input.createdBy?.kind ?? null,
          ],
        );
        if (inserted.rowCount > 0) {
          return { ok: true, value: { run: mapRun(inserted.rows[0]!), created: true } };
        }
        const existing = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid = $3`,
          [input.orgId, input.projectId, input.runUlid],
        );
        if (existing.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: { run: mapRun(existing.rows[0]!), created: false } };
      } catch {
        return safeError("Failed to create run");
      }
    },

    async getRun(orgId: Uuid, projectId: Uuid, id: Uuid): Promise<StateResult<Run>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND id = $3`,
          [orgId, projectId, id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRun(result.rows[0]!) };
      } catch {
        return safeError("Failed to get run");
      }
    },

    async getRunByUlid(
      orgId: Uuid,
      projectId: Uuid,
      runUlid: string,
    ): Promise<StateResult<Run>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid = $3`,
          [orgId, projectId, runUlid],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRun(result.rows[0]!) };
      } catch {
        return safeError("Failed to get run");
      }
    },

    async listRuns(
      orgId: Uuid,
      projectId: Uuid,
      params: PageQueryParams,
      query?: ListRunsQuery,
    ): Promise<StateResult<PagedResult<Run>>> {
      const values: unknown[] = [orgId, projectId];
      let sql = `SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2`;
      if (query?.environment) {
        values.push(query.environment);
        sql += ` AND environment = $${values.length}`;
      }
      if (query?.status) {
        values.push(query.status);
        sql += ` AND status = $${values.length}`;
      }
      return pagedList(executor, sql, values, params.limit, params.cursor, mapRun);
    },

    // ── Run jobs ─────────────────────────────────────────────

    async createRunJob(input: CreateRunJobInput): Promise<StateResult<RunJob>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          // deps is jsonb: cast the JSON text through ::text::jsonb so Postgres
          // PARSES it into a real array. A bare $7 (jsonb param) makes the pg
          // driver send the JSON string as a jsonb *string value*, storing the
          // scalar "[]" — which then throws "cannot get array length of a
          // scalar" in the runnable/claim deps guard. ::text forces the text
          // wire type so ::jsonb parses the contents.
          `INSERT INTO state.run_jobs
             (id, org_id, project_id, run_id, job_id, component, deps, status,
              attempt, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, 'queued', 1, now(), now())
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId,
            input.runId,
            input.jobId,
            input.component ?? null,
            JSON.stringify(input.deps ?? []),
          ],
        );
        return { ok: true, value: mapRunJob(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "run_job" } };
        }
        return safeError("Failed to create run job");
      }
    },

    async getRunJob(
      orgId: Uuid,
      projectId: Uuid,
      runId: Uuid,
      jobId: string,
    ): Promise<StateResult<RunJob>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.run_jobs
            WHERE org_id = $1 AND project_id = $2 AND run_id = $3 AND job_id = $4`,
          [orgId, projectId, runId, jobId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRunJob(result.rows[0]!) };
      } catch {
        return safeError("Failed to get run job");
      }
    },

    async listRunJobs(
      orgId: Uuid,
      projectId: Uuid,
      runId: Uuid,
    ): Promise<StateResult<RunJob[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.run_jobs
            WHERE org_id = $1 AND project_id = $2 AND run_id = $3
            ORDER BY job_id ASC`,
          [orgId, projectId, runId],
        );
        return { ok: true, value: result.rows.map(mapRunJob) };
      } catch {
        return safeError("Failed to list run jobs");
      }
    },

    async listRunnableJobs(
      orgId: Uuid,
      projectId: Uuid,
      runId: Uuid,
    ): Promise<StateResult<RunJob[]>> {
      try {
        // The frontier: queued jobs whose every dependency is a succeeded job in
        // the same run. A job with no deps is trivially runnable. Computed in a
        // single statement so the CLI scheduler and the claim guard agree on
        // the same readiness predicate.
        //
        // Readiness is "count of this job's deps that are succeeded == number of
        // deps". We express it with the jsonb element-existence function
        // (jsonb_exists) + jsonb_array_length rather than a correlated
        // jsonb_array_elements_text(j.deps) set-returning function in a subquery
        // FROM: the latter threw at execution time against real Postgres and 503'd
        // /runnable and /claim (it was only ever exercised by the fake-executor
        // handler tests). jsonb_exists avoids the `?` operator so no driver
        // mistakes it for a bind placeholder.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT j.* FROM state.run_jobs j
            WHERE j.org_id = $1 AND j.project_id = $2 AND j.run_id = $3
              AND j.status = 'queued'
              AND (
                SELECT count(*) FROM state.run_jobs d
                WHERE d.run_id = j.run_id
                  AND d.status = 'succeeded'
                  AND jsonb_exists(j.deps, d.job_id)
              ) = jsonb_array_length(j.deps)
            ORDER BY j.job_id ASC`,
          [orgId, projectId, runId],
        );
        return { ok: true, value: result.rows.map(mapRunJob) };
      } catch (e) {
        console.error(JSON.stringify({ scope: "db.listRunnableJobs", err: String(e), msg: (e as Error)?.message }));
        return safeError("Failed to list runnable jobs");
      }
    },

    async claimRunJob(input: ClaimRunJobInput): Promise<StateResult<ClaimRunJobOutcome>> {
      try {
        // ── The atomic conditional claim. ──
        // A SINGLE UPDATE is the entire concurrency-safety mechanism: it
        // transitions the row only if it is still `queued` AND every dependency
        // is a succeeded job. Postgres takes a row lock for the duration of the
        // UPDATE, so of N racing claims for one job exactly one observes
        // rowCount = 1 (the winner); the rest observe rowCount = 0 and never
        // mutate the row. No read-then-write window exists.
        const claimed = await executor.execute<Record<string, unknown>>(
          `UPDATE state.run_jobs j
              SET status = 'claimed',
                  runner_id = $5,
                  lease_expires_at = now() + ($6::int * interval '1 second'),
                  started_at = COALESCE(j.started_at, now()),
                  updated_at = now()
            WHERE j.org_id = $1 AND j.project_id = $2 AND j.run_id = $3
              AND j.job_id = $4
              AND j.status = 'queued'
              AND (
                SELECT count(*) FROM state.run_jobs d
                WHERE d.run_id = j.run_id
                  AND d.status = 'succeeded'
                  AND jsonb_exists(j.deps, d.job_id)
              ) = jsonb_array_length(j.deps)
            RETURNING *`,
          [input.orgId, input.projectId, input.runId, input.jobId, input.runnerId, String(input.leaseSeconds)],
        );
        if (claimed.rowCount > 0) {
          return { ok: true, value: { claimed: true, job: mapRunJob(claimed.rows[0]!) } };
        }

        // Lost the claim (or could not claim). Read the row once to report WHY
        // — this read does not race the win: the winner already committed.
        const current = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.run_jobs
            WHERE org_id = $1 AND project_id = $2 AND run_id = $3 AND job_id = $4`,
          [input.orgId, input.projectId, input.runId, input.jobId],
        );
        if (current.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        const job = mapRunJob(current.rows[0]!);
        if (job.status === "queued") {
          // Still queued but the guard refused → deps are not all succeeded.
          return { ok: true, value: { claimed: false, reason: "deps_not_ready" } };
        }
        if (
          job.status === "succeeded" ||
          job.status === "failed" ||
          job.status === "timed_out" ||
          job.status === "canceled"
        ) {
          return { ok: true, value: { claimed: false, reason: "terminal" } };
        }
        // claimed / running → someone holds it.
        return { ok: true, value: { claimed: false, reason: "already_claimed" } };
      } catch (e) {
        console.error(JSON.stringify({ scope: "db.claimRunJob", err: String(e), msg: (e as Error)?.message }));
        return safeError("Failed to claim run job");
      }
    },

    async heartbeatRunJob(input: HeartbeatRunJobInput): Promise<StateResult<HeartbeatOutcome>> {
      try {
        // Extend the lease only if THIS runner still holds a live, non-terminal
        // lease. A lapsed or reassigned lease yields rowCount = 0 → lease_lost.
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE state.run_jobs
              SET lease_expires_at = now() + ($6::int * interval '1 second'),
                  status = CASE WHEN status = 'claimed' THEN 'running' ELSE status END,
                  updated_at = now()
            WHERE org_id = $1 AND project_id = $2 AND run_id = $3 AND job_id = $4
              AND runner_id = $5
              AND status IN ('claimed', 'running')
              AND lease_expires_at > now()
            RETURNING *`,
          [input.orgId, input.projectId, input.runId, input.jobId, input.runnerId, String(input.leaseSeconds)],
        );
        if (result.rowCount === 0) return { ok: true, value: { ok: false, reason: "lease_lost" } };
        return { ok: true, value: { ok: true, job: mapRunJob(result.rows[0]!) } };
      } catch (e) {
        console.error(JSON.stringify({ scope: "db.heartbeatRunJob", err: String(e), msg: (e as Error)?.message }));
        return safeError("Failed to heartbeat run job");
      }
    },

    async updateRunJob(input: UpdateRunJobInput): Promise<StateResult<UpdateRunJobOutcome>> {
      try {
        // Idempotent terminal transition guarded on the runner's live lease.
        // The transition only fires from a non-terminal status held by THIS
        // runner with an unexpired lease.
        const updated = await executor.execute<Record<string, unknown>>(
          `UPDATE state.run_jobs
              SET status = $6,
                  error_text = $7,
                  finished_at = now(),
                  lease_expires_at = NULL,
                  updated_at = now()
            WHERE org_id = $1 AND project_id = $2 AND run_id = $3 AND job_id = $4
              AND runner_id = $5
              AND status IN ('claimed', 'running')
              AND lease_expires_at > now()
            RETURNING *`,
          [
            input.orgId,
            input.projectId,
            input.runId,
            input.jobId,
            input.runnerId,
            input.status,
            input.errorText ?? null,
          ],
        );
        if (updated.rowCount > 0) {
          return { ok: true, value: { ok: true, job: mapRunJob(updated.rows[0]!), replayed: false } };
        }

        // No transition fired. Either it is an exact replay (same runner already
        // landed this terminal status) — idempotent no-op — or the lease lapsed.
        const current = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.run_jobs
            WHERE org_id = $1 AND project_id = $2 AND run_id = $3 AND job_id = $4`,
          [input.orgId, input.projectId, input.runId, input.jobId],
        );
        if (current.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        const job = mapRunJob(current.rows[0]!);
        if (job.runnerId === input.runnerId && job.status === input.status) {
          // Replay of a transition this exact runner already applied.
          return { ok: true, value: { ok: true, job, replayed: true } };
        }
        // The runner no longer owns a live lease (lapsed, reassigned, or the job
        // moved to a different terminal/owner) → lease_lost (terminal sticky).
        return { ok: true, value: { ok: false, reason: "lease_lost" } };
      } catch {
        return safeError("Failed to update run job");
      }
    },

    async sweepLapsedLeases(
      now: Date,
      maxAttempts: number,
      limit: number,
    ): Promise<StateResult<SweptJob[]>> {
      try {
        // Re-queue lapsed claims (attempt+1) up to maxAttempts; past that, mark
        // them timed_out. One guarded UPDATE per outcome; both scoped to the
        // partial lease index (status in claimed/running AND lease lapsed).
        const requeued = await executor.execute<Record<string, unknown>>(
          `UPDATE state.run_jobs
              SET status = 'queued',
                  runner_id = NULL,
                  lease_expires_at = NULL,
                  attempt = attempt + 1,
                  updated_at = now()
            WHERE id IN (
              SELECT id FROM state.run_jobs
                WHERE status IN ('claimed', 'running')
                  AND lease_expires_at IS NOT NULL
                  AND lease_expires_at <= $1
                  AND attempt < $2
                ORDER BY lease_expires_at ASC
                LIMIT $3
            )
            RETURNING *`,
          [now.toISOString(), maxAttempts, limit],
        );
        const timedOut = await executor.execute<Record<string, unknown>>(
          `UPDATE state.run_jobs
              SET status = 'timed_out',
                  lease_expires_at = NULL,
                  finished_at = now(),
                  error_text = COALESCE(error_text, 'Lease lapsed after maximum attempts'),
                  updated_at = now()
            WHERE id IN (
              SELECT id FROM state.run_jobs
                WHERE status IN ('claimed', 'running')
                  AND lease_expires_at IS NOT NULL
                  AND lease_expires_at <= $1
                  AND attempt >= $2
                ORDER BY lease_expires_at ASC
                LIMIT $3
            )
            RETURNING *`,
          [now.toISOString(), maxAttempts, limit],
        );
        const swept: SweptJob[] = [
          ...requeued.rows.map((r) => ({ job: mapRunJob(r), outcome: "requeued" as const })),
          ...timedOut.rows.map((r) => ({ job: mapRunJob(r), outcome: "timed_out" as const })),
        ];
        return { ok: true, value: swept };
      } catch {
        return safeError("Failed to sweep lapsed leases");
      }
    },

    async cancelRun(orgId: Uuid, projectId: Uuid, runId: Uuid): Promise<StateResult<Run>> {
      try {
        // Cancel non-terminal jobs, then set the run terminal. Idempotent: a run
        // already canceled/terminal just returns its current row.
        await executor.execute<Record<string, unknown>>(
          `UPDATE state.run_jobs
              SET status = 'canceled',
                  lease_expires_at = NULL,
                  finished_at = COALESCE(finished_at, now()),
                  updated_at = now()
            WHERE org_id = $1 AND project_id = $2 AND run_id = $3
              AND status NOT IN ('succeeded', 'failed', 'timed_out', 'canceled')`,
          [orgId, projectId, runId],
        );
        const run = await executor.execute<Record<string, unknown>>(
          `UPDATE state.runs
              SET status = 'canceled',
                  finished_at = COALESCE(finished_at, now()),
                  updated_at = now()
            WHERE org_id = $1 AND project_id = $2 AND id = $3
              AND status NOT IN ('succeeded', 'failed', 'canceled')
            RETURNING *`,
          [orgId, projectId, runId],
        );
        if (run.rowCount > 0) return { ok: true, value: mapRun(run.rows[0]!) };
        // Already terminal — return the existing row (idempotent).
        const existing = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND id = $3`,
          [orgId, projectId, runId],
        );
        if (existing.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRun(existing.rows[0]!) };
      } catch {
        return safeError("Failed to cancel run");
      }
    },

    async getRunJobCounts(
      orgId: Uuid,
      projectId: Uuid,
      runId: Uuid,
    ): Promise<StateResult<RunJobCounts>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'queued')                    AS queued,
             COUNT(*) FILTER (WHERE status IN ('claimed', 'running'))     AS running,
             COUNT(*) FILTER (WHERE status = 'succeeded')                 AS succeeded,
             COUNT(*) FILTER (WHERE status IN ('failed', 'timed_out'))    AS failed
           FROM state.run_jobs
           WHERE org_id = $1 AND project_id = $2 AND run_id = $3`,
          [orgId, projectId, runId],
        );
        const row = result.rows[0] ?? {};
        return {
          ok: true,
          value: {
            queued: Number(row.queued ?? 0),
            running: Number(row.running ?? 0),
            succeeded: Number(row.succeeded ?? 0),
            failed: Number(row.failed ?? 0),
          },
        };
      } catch {
        return safeError("Failed to count run jobs");
      }
    },

    async reconcileRunStatus(
      orgId: Uuid,
      projectId: Uuid,
      runId: Uuid,
    ): Promise<StateResult<{ run: Run; transitioned: RunStatus | null }>> {
      try {
        const runResult = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND id = $3`,
          [orgId, projectId, runId],
        );
        if (runResult.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        const run = mapRun(runResult.rows[0]!);

        // Canceled is sticky and asserted directly by cancelRun; never override.
        if (run.status === "canceled") return { ok: true, value: { run, transitioned: null } };

        const tally = await executor.execute<Record<string, unknown>>(
          `SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status IN ('succeeded','failed','timed_out','canceled')) AS terminal,
             COUNT(*) FILTER (WHERE status IN ('claimed','running')) AS active,
             COUNT(*) FILTER (WHERE status IN ('failed','timed_out')) AS failed
           FROM state.run_jobs
           WHERE org_id = $1 AND project_id = $2 AND run_id = $3`,
          [orgId, projectId, runId],
        );
        const t = tally.rows[0] ?? {};
        const total = Number(t.total ?? 0);
        const terminal = Number(t.terminal ?? 0);
        const active = Number(t.active ?? 0);
        const failed = Number(t.failed ?? 0);

        let next: RunStatus = run.status;
        if (total > 0 && terminal === total) {
          next = failed > 0 ? "failed" : "succeeded";
        } else if (active > 0 && run.status === "pending") {
          next = "running";
        }

        if (next === run.status) return { ok: true, value: { run, transitioned: null } };

        const isTerminal = next === "succeeded" || next === "failed";
        const updated = await executor.execute<Record<string, unknown>>(
          `UPDATE state.runs
              SET status = $4,
                  started_at = COALESCE(started_at, CASE WHEN $4 = 'running' THEN now() ELSE started_at END),
                  finished_at = CASE WHEN $5 THEN now() ELSE finished_at END,
                  updated_at = now()
            WHERE org_id = $1 AND project_id = $2 AND id = $3
              AND status NOT IN ('succeeded', 'failed', 'canceled')
            RETURNING *`,
          [orgId, projectId, runId, next, isTerminal],
        );
        if (updated.rowCount === 0) {
          // Lost a race to another reconcile — re-read and report no transition.
          return { ok: true, value: { run, transitioned: null } };
        }
        return {
          ok: true,
          value: {
            run: mapRun(updated.rows[0]!),
            transitioned: isTerminal ? next : null,
          },
        };
      } catch {
        return safeError("Failed to reconcile run status");
      }
    },

    // ── Objects (CAS index) ──────────────────────────────────

    async upsertObject(input: UpsertObjectInput): Promise<StateResult<UpsertObjectOutcome>> {
      try {
        // Idempotent PUT: same digest within the scope is a no-op returning the
        // existing index row with created=false.
        const inserted = await executor.execute<Record<string, unknown>>(
          `INSERT INTO state.objects
             (id, org_id, project_id, digest, kind, size_bytes, created_by,
              created_by_kind, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (org_id, project_id, digest) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId,
            input.digest,
            input.kind,
            input.sizeBytes,
            input.createdBy?.id ?? null,
            input.createdBy?.kind ?? null,
          ],
        );
        if (inserted.rowCount > 0) {
          return { ok: true, value: { object: mapObject(inserted.rows[0]!), created: true } };
        }
        const existing = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.objects WHERE org_id = $1 AND project_id = $2 AND digest = $3`,
          [input.orgId, input.projectId, input.digest],
        );
        if (existing.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: { object: mapObject(existing.rows[0]!), created: false } };
      } catch {
        return safeError("Failed to upsert object");
      }
    },

    async getObject(
      orgId: Uuid,
      projectId: Uuid,
      digest: string,
    ): Promise<StateResult<StateObject>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.objects WHERE org_id = $1 AND project_id = $2 AND digest = $3`,
          [orgId, projectId, digest],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapObject(result.rows[0]!) };
      } catch {
        return safeError("Failed to get object");
      }
    },

    async listMissingObjects(
      orgId: Uuid,
      projectId: Uuid,
      digests: string[],
    ): Promise<StateResult<string[]>> {
      if (digests.length === 0) return { ok: true, value: [] };
      try {
        // NOTE: use a parameterized IN (...) list of scalar text params rather
        // than `= ANY($3::text[])` with a JS array. The pg driver runs with
        // `fetch_types: false` (hyperdrive.ts), which leaves array parameters
        // without a resolvable element-type OID and makes `ANY($array)` throw at
        // bind time — that surfaced as a hard 503 on objects/missing (digest
        // negotiation). A scalar IN list avoids array serialization entirely.
        // (Same root cause as membership.listRoleAssignmentsForSubjects.)
        const placeholders = digests.map((_, i) => `$${i + 3}`).join(", ");
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT digest FROM state.objects
            WHERE org_id = $1 AND project_id = $2 AND digest IN (${placeholders})`,
          [orgId, projectId, ...digests],
        );
        const present = new Set(result.rows.map((r) => r.digest as string));
        return { ok: true, value: digests.filter((d) => !present.has(d)) };
      } catch {
        return safeError("Failed to list missing objects");
      }
    },

    async listObjects(
      orgId: Uuid,
      projectId: Uuid,
      params: PageQueryParams,
      query?: { kind?: StateObjectKind },
    ): Promise<StateResult<PagedResult<StateObject>>> {
      const values: unknown[] = [orgId, projectId];
      let sql = `SELECT * FROM state.objects WHERE org_id = $1 AND project_id = $2`;
      if (query?.kind) {
        values.push(query.kind);
        sql += ` AND kind = $${values.length}`;
      }
      return pagedList(executor, sql, values, params.limit, params.cursor, mapObject);
    },

    // ── Log chunks ───────────────────────────────────────────

    async appendLogChunk(input: AppendLogChunkInput): Promise<StateResult<LogChunk>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO state.log_chunks
             (id, org_id, project_id, run_id, job_id, seq, byte_length, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId,
            input.runId,
            input.jobId,
            input.seq,
            input.byteLength,
          ],
        );
        return { ok: true, value: mapLogChunk(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "log_chunk" } };
        }
        return safeError("Failed to append log chunk");
      }
    },

    async listLogChunks(
      orgId: Uuid,
      projectId: Uuid,
      runId: Uuid,
      jobId: string,
      fromSeq: number,
    ): Promise<StateResult<LogChunk[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.log_chunks
            WHERE org_id = $1 AND project_id = $2 AND run_id = $3 AND job_id = $4
              AND seq >= $5
            ORDER BY seq ASC`,
          [orgId, projectId, runId, jobId, fromSeq],
        );
        return { ok: true, value: result.rows.map(mapLogChunk) };
      } catch {
        return safeError("Failed to list log chunks");
      }
    },

    // ── Catalog heads ────────────────────────────────────────

    async advanceCatalogHead(
      input: AdvanceCatalogHeadInput,
    ): Promise<StateResult<CatalogHead>> {
      try {
        // History is retained: advancing inserts a new row. The pointed-at
        // digest must exist in state.objects (composite FK enforces it).
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO state.catalog_heads
             (id, org_id, project_id, environment, digest, commit, advanced_by,
              advanced_by_kind, advanced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId,
            input.environment ?? null,
            input.digest,
            input.commit ?? null,
            input.advancedBy?.id ?? null,
            input.advancedBy?.kind ?? null,
          ],
        );
        return { ok: true, value: mapCatalogHead(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "catalog_head" } };
        }
        return safeError("Failed to advance catalog head");
      }
    },

    async getCatalogHead(
      orgId: Uuid,
      projectId: Uuid,
      environment: string | null,
    ): Promise<StateResult<CatalogHead>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.catalog_heads
            WHERE org_id = $1 AND project_id = $2
              AND COALESCE(environment, '') = COALESCE($3, '')
            ORDER BY advanced_at DESC, id DESC
            LIMIT 1`,
          [orgId, projectId, environment],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapCatalogHead(result.rows[0]!) };
      } catch {
        return safeError("Failed to get catalog head");
      }
    },

    async listCatalogHeadHistory(
      orgId: Uuid,
      projectId: Uuid,
      params: PageQueryParams,
    ): Promise<StateResult<PagedResult<CatalogHead>>> {
      const values: unknown[] = [orgId, projectId];
      const sql = `SELECT * FROM state.catalog_heads WHERE org_id = $1 AND project_id = $2`;
      return pagedList(
        executor,
        sql,
        values,
        params.limit,
        params.cursor,
        mapCatalogHead,
        "advanced_at",
      );
    },

    // ── Catalog entities (read-model) ────────────────────────

    async upsertCatalogEntity(
      input: UpsertCatalogEntityInput,
    ): Promise<StateResult<CatalogEntity>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO state.catalog_entities
             (id, org_id, project_id, head_digest, entity_ref, kind, name, owner,
              lifecycle, relations, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
           ON CONFLICT (org_id, project_id, head_digest, entity_ref) DO UPDATE SET
             kind = EXCLUDED.kind,
             name = EXCLUDED.name,
             owner = EXCLUDED.owner,
             lifecycle = EXCLUDED.lifecycle,
             relations = EXCLUDED.relations
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId,
            input.headDigest,
            input.entityRef,
            input.kind,
            input.name,
            input.owner ?? null,
            input.lifecycle ?? null,
            JSON.stringify(input.relations ?? []),
          ],
        );
        return { ok: true, value: mapCatalogEntity(result.rows[0]!) };
      } catch {
        return safeError("Failed to upsert catalog entity");
      }
    },

    async listCatalogEntities(
      orgId: Uuid,
      projectId: Uuid,
      headDigest: string,
      params: PageQueryParams,
      query?: ListCatalogEntitiesQuery,
    ): Promise<StateResult<PagedResult<CatalogEntity>>> {
      const values: unknown[] = [orgId, projectId, headDigest];
      let sql = `SELECT * FROM state.catalog_entities
                  WHERE org_id = $1 AND project_id = $2 AND head_digest = $3`;
      if (query?.kind) {
        values.push(query.kind);
        sql += ` AND kind = $${values.length}`;
      }
      if (query?.owner) {
        values.push(query.owner);
        sql += ` AND owner = $${values.length}`;
      }
      if (query?.q) {
        values.push(`%${query.q}%`);
        sql += ` AND name ILIKE $${values.length}`;
      }
      return pagedList(executor, sql, values, params.limit, params.cursor, mapCatalogEntity);
    },

    // ── Refs (hosted RefStore — L2 mutable CAS pointers; OV1) ─

    async getRef(orgId: Uuid, projectId: Uuid, name: string): Promise<StateResult<StateRef>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.refs WHERE org_id = $1 AND project_id = $2 AND name = $3`,
          [orgId, projectId, name],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRef(result.rows[0]!) };
      } catch {
        return safeError("Failed to get ref");
      }
    },

    async updateRef(input: UpdateRefInput): Promise<StateResult<UpdateRefOutcome>> {
      try {
        // CAS. expectedTarget "" ⇒ create-if-absent (INSERT … ON CONFLICT DO
        // NOTHING); a non-empty expectedTarget ⇒ conditional advance (UPDATE …
        // WHERE target = expected). Either path is one atomic statement.
        if (input.expectedTarget === "") {
          const inserted = await executor.execute<Record<string, unknown>>(
            `INSERT INTO state.refs (id, org_id, project_id, name, target, writer, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, now(), now())
             ON CONFLICT (org_id, project_id, name) DO NOTHING
             RETURNING *`,
            [input.id, input.orgId, input.projectId, input.name, input.newTarget, input.writer ?? null],
          );
          if (inserted.rowCount > 0) {
            return { ok: true, value: { kind: "updated", ref: mapRef(inserted.rows[0]!) } };
          }
          // The ref already exists — CAS expecting absence lost.
          const current = await executor.execute<Record<string, unknown>>(
            `SELECT * FROM state.refs WHERE org_id = $1 AND project_id = $2 AND name = $3`,
            [input.orgId, input.projectId, input.name],
          );
          return {
            ok: true,
            value: { kind: "conflict", current: current.rowCount > 0 ? mapRef(current.rows[0]!) : null },
          };
        }

        const updated = await executor.execute<Record<string, unknown>>(
          `UPDATE state.refs
             SET target = $5, writer = $6, updated_at = now()
           WHERE org_id = $1 AND project_id = $2 AND name = $3 AND target = $4
           RETURNING *`,
          [input.orgId, input.projectId, input.name, input.expectedTarget, input.newTarget, input.writer ?? null],
        );
        if (updated.rowCount > 0) {
          return { ok: true, value: { kind: "updated", ref: mapRef(updated.rows[0]!) } };
        }
        // No row matched (target stale or ref absent) — report the current value.
        const current = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.refs WHERE org_id = $1 AND project_id = $2 AND name = $3`,
          [input.orgId, input.projectId, input.name],
        );
        return {
          ok: true,
          value: { kind: "conflict", current: current.rowCount > 0 ? mapRef(current.rows[0]!) : null },
        };
      } catch (err) {
        // Composite FK to state.objects failed → the new target's object (and
        // therefore its closure) was never uploaded.
        if (isForeignKeyViolation(err)) {
          return { ok: true, value: { kind: "target_missing" } };
        }
        return safeError("Failed to update ref");
      }
    },

    async listRefs(orgId: Uuid, projectId: Uuid, prefix: string): Promise<StateResult<StateRef[]>> {
      try {
        // Prefix match with the literal LIKE wildcards escaped, so a name like
        // 'a_b' matches only itself, not 'axb'.
        const escaped = prefix.replace(/([\\%_])/g, "\\$1");
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.refs
            WHERE org_id = $1 AND project_id = $2 AND name LIKE $3 ESCAPE '\\'
            ORDER BY name ASC`,
          [orgId, projectId, `${escaped}%`],
        );
        return { ok: true, value: result.rows.map(mapRef) };
      } catch {
        return safeError("Failed to list refs");
      }
    },

    async deleteRef(orgId: Uuid, projectId: Uuid, name: string): Promise<StateResult<void>> {
      try {
        await executor.execute(
          `DELETE FROM state.refs WHERE org_id = $1 AND project_id = $2 AND name = $3`,
          [orgId, projectId, name],
        );
        return { ok: true, value: undefined };
      } catch {
        return safeError("Failed to delete ref");
      }
    },

    // ── Workspace links ──────────────────────────────────────

    async createWorkspaceLink(
      input: CreateWorkspaceLinkInput,
    ): Promise<StateResult<WorkspaceLink>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO state.workspace_links
             (id, org_id, project_id, remote_url, status, created_by,
              created_by_kind, provider, provider_repo_id, provider_owner_id,
              provider_owner_login, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, now(), now())
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId,
            input.remoteUrl,
            input.createdBy?.id ?? null,
            input.createdBy?.kind ?? null,
            input.provider?.provider ?? null,
            input.provider?.providerRepoId ?? null,
            input.provider?.providerOwnerId ?? null,
            input.provider?.providerOwnerLogin ?? null,
          ],
        );
        return { ok: true, value: mapWorkspaceLink(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "workspace_link" } };
        }
        return safeError("Failed to create workspace link");
      }
    },

    async getWorkspaceLink(orgId: Uuid, id: Uuid): Promise<StateResult<WorkspaceLink>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.workspace_links WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapWorkspaceLink(result.rows[0]!) };
      } catch {
        return safeError("Failed to get workspace link");
      }
    },

    async listWorkspaceLinks(
      orgId: Uuid,
      projectId: Uuid,
      params: PageQueryParams,
    ): Promise<StateResult<PagedResult<WorkspaceLink>>> {
      const values: unknown[] = [orgId, projectId];
      const sql = `SELECT * FROM state.workspace_links WHERE org_id = $1 AND project_id = $2`;
      return pagedList(executor, sql, values, params.limit, params.cursor, mapWorkspaceLink);
    },

    async listActiveWorkspaceLinksForRemote(
      remoteUrl: string,
    ): Promise<StateResult<WorkspaceLink[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.workspace_links
            WHERE remote_url = $1 AND status = 'active'
            ORDER BY created_at ASC, id ASC`,
          [remoteUrl],
        );
        return { ok: true, value: result.rows.map(mapWorkspaceLink) };
      } catch {
        return safeError("Failed to resolve workspace links for remote");
      }
    },

    async listActiveWorkspaceLinksForProviderRepo(
      provider: string,
      providerRepoId: string,
    ): Promise<StateResult<WorkspaceLink[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.workspace_links
            WHERE provider = $1 AND provider_repo_id = $2 AND status = 'active'
            ORDER BY created_at ASC, id ASC`,
          [provider, providerRepoId],
        );
        return { ok: true, value: result.rows.map(mapWorkspaceLink) };
      } catch {
        return safeError("Failed to resolve workspace links for provider repo");
      }
    },

    async unlinkWorkspaceLink(orgId: Uuid, id: Uuid): Promise<StateResult<WorkspaceLink>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE state.workspace_links
              SET status = 'unlinked', updated_at = now()
            WHERE org_id = $1 AND id = $2 AND status = 'active'
            RETURNING *`,
          [orgId, id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapWorkspaceLink(result.rows[0]!) };
      } catch {
        return safeError("Failed to unlink workspace link");
      }
    },
  };
}
