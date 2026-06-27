import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";
import type {
  ActorStamp,
  AdvanceCatalogHeadInput,
  AppendLogChunkInput,
  CatalogEntity,
  CatalogEntityRelation,
  CatalogHead,
  CreateRunInput,
  CreateRunJobInput,
  CreateRunOutcome,
  CreateWorkspaceLinkInput,
  CursorPosition,
  ListTriggersQuery,
  RecordTriggerInput,
  RecordTriggerOutcome,
  ScmIngestCursor,
  StateTrigger,
  TriggerKind,
  ListCatalogEntitiesQuery,
  ListOrgCatalogEntitiesQuery,
  OrgCatalogEntity,
  StateStorageUsage,
  UpsertOrgCatalogEntityInput,
  ListRunsQuery,
  ListOrgRunsQuery,
  LogChunk,
  PagedResult,
  PageQueryParams,
  Run,
  RunJob,
  RunJobCounts,
  StateObject,
  StateObjectKind,
  StateRef,
  StateRepository,
  StateResult,
  UpdateRefInput,
  UpdateRefOutcome,
  UpdateWorkspaceLinkCiSettingsInput,
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

function mapTrigger(row: Record<string, unknown>): StateTrigger {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    provider: row.provider as string,
    providerRepoId: row.provider_repo_id as string,
    repoFullName: (row.repo_full_name as string) ?? null,
    kind: row.kind as TriggerKind,
    action: (row.action as string) ?? null,
    ref: (row.ref as string) ?? null,
    commitSha: row.commit_sha as string,
    baseSha: (row.base_sha as string) ?? null,
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    actorLogin: (row.actor_login as string) ?? null,
    eventId: row.event_id as string,
    status: row.status as string,
    occurredAt: toDate(row.occurred_at),
    createdAt: toDate(row.created_at),
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

function mapOrgCatalogEntity(row: Record<string, unknown>): OrgCatalogEntity {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    entityRef: row.entity_ref as string,
    kind: row.kind as string,
    name: row.name as string,
    owner: (row.owner as string) ?? null,
    lifecycle: (row.lifecycle as string) ?? null,
    relations: parseJson<CatalogEntityRelation[]>(row.relations) ?? [],
    sourceProjectId: row.source_project_id as string,
    sourceEnvironment: (row.source_environment as string) ?? null,
    sourceCommit: (row.source_commit as string) ?? null,
    headDigest: row.head_digest as string,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
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
    ciSettings: {
      // Columns are absent on rows from older fakes/inserts; default permissive.
      oidcEnabled: row.oidc_enabled === undefined ? true : Boolean(row.oidc_enabled),
      apiKeyEnabled: row.api_key_enabled === undefined ? true : Boolean(row.api_key_enabled),
      allowedRefPattern: (row.allowed_ref_pattern as string) ?? null,
      allowedEnvironments: parseJson<string[]>(row.allowed_environments),
    },
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

    async listOrgRuns(
      orgId: Uuid,
      params: PageQueryParams,
      query?: ListOrgRunsQuery,
    ): Promise<StateResult<PagedResult<Run>>> {
      const values: unknown[] = [orgId];
      let sql = `SELECT * FROM state.runs WHERE org_id = $1`;
      if (query?.projectId) {
        values.push(query.projectId);
        sql += ` AND project_id = $${values.length}`;
      }
      if (query?.environment) {
        values.push(query.environment);
        sql += ` AND environment = $${values.length}`;
      }
      if (query?.status) {
        values.push(query.status);
        sql += ` AND status = $${values.length}`;
      }
      if (query?.source) {
        values.push(query.source);
        sql += ` AND source = $${values.length}`;
      }
      if (query?.branch) {
        // Branch filter over git_ref, normalizing the refs/heads/ prefix so
        // 'main' matches both a bare 'main' and a fully-qualified
        // 'refs/heads/main' (CLI vs CI provenance differ).
        values.push(query.branch);
        sql += ` AND regexp_replace(COALESCE(git_ref, ''), '^refs/heads/', '') = $${values.length}`;
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

    async listObjectDigestsWithSize(
      orgId: Uuid,
      projectId: Uuid,
      limit: number,
    ): Promise<StateResult<{ digest: string; sizeBytes: number; createdAt: string }[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT digest, size_bytes, created_at FROM state.objects
            WHERE org_id = $1 AND project_id = $2
            ORDER BY created_at ASC
            LIMIT $3`,
          [orgId, projectId, limit],
        );
        return {
          ok: true,
          value: result.rows.map((r) => ({
            digest: r.digest as string,
            sizeBytes: Number(r.size_bytes ?? 0),
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
          })),
        };
      } catch {
        return safeError("Failed to list object digests");
      }
    },

    async deleteObject(orgId: Uuid, projectId: Uuid, digest: string): Promise<StateResult<boolean>> {
      try {
        // Object GC reclamation (OV9): drop one unreachable object's index row.
        // The caller deletes the R2 blob; this removes the existence record.
        const result = await executor.execute(
          `DELETE FROM state.objects WHERE org_id = $1 AND project_id = $2 AND digest = $3`,
          [orgId, projectId, digest],
        );
        return { ok: true, value: (result.rowCount ?? 0) > 0 };
      } catch {
        return safeError("Failed to delete object");
      }
    },

    async listStorageGcRoots(orgId: Uuid, projectId: Uuid): Promise<StateResult<string[]>> {
      try {
        // Three live-pointer sources, unioned: current ref targets, retained
        // catalog-head digests, and run plan digests. Each is the head of a
        // reachable closure; retained history keeps its objects reachable so the
        // report is conservative (never over-claims reclaimable storage).
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT target AS digest FROM state.refs WHERE org_id = $1 AND project_id = $2
           UNION
           SELECT digest FROM state.catalog_heads WHERE org_id = $1 AND project_id = $2
           UNION
           SELECT plan_digest AS digest FROM state.runs WHERE org_id = $1 AND project_id = $2`,
          [orgId, projectId],
        );
        return { ok: true, value: result.rows.map((r) => r.digest as string).filter((d) => typeof d === "string" && d.length > 0) };
      } catch {
        return safeError("Failed to list storage GC roots");
      }
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

    // ── Org-global catalog projection (OV6 read-model) ─────────

    async upsertOrgCatalogEntity(
      input: UpsertOrgCatalogEntityInput,
    ): Promise<StateResult<OrgCatalogEntity>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO state.org_catalog_entities
             (id, org_id, entity_ref, kind, name, owner, lifecycle, relations,
              source_project_id, source_environment, source_commit, head_digest,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
           ON CONFLICT (org_id, source_project_id, COALESCE(source_environment, ''), entity_ref)
             DO UPDATE SET
               kind = EXCLUDED.kind,
               name = EXCLUDED.name,
               owner = EXCLUDED.owner,
               lifecycle = EXCLUDED.lifecycle,
               relations = EXCLUDED.relations,
               source_commit = EXCLUDED.source_commit,
               head_digest = EXCLUDED.head_digest,
               updated_at = now()
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.entityRef,
            input.kind,
            input.name,
            input.owner ?? null,
            input.lifecycle ?? null,
            JSON.stringify(input.relations ?? []),
            input.sourceProjectId,
            input.sourceEnvironment ?? null,
            input.sourceCommit ?? null,
            input.headDigest,
          ],
        );
        return { ok: true, value: mapOrgCatalogEntity(result.rows[0]!) };
      } catch {
        return safeError("Failed to upsert org catalog entity");
      }
    },

    async listOrgCatalogEntities(
      orgId: Uuid,
      params: PageQueryParams,
      query?: ListOrgCatalogEntitiesQuery,
    ): Promise<StateResult<PagedResult<OrgCatalogEntity>>> {
      const values: unknown[] = [orgId];
      let sql = `SELECT * FROM state.org_catalog_entities WHERE org_id = $1`;
      if (query?.sourceProjectId) {
        values.push(query.sourceProjectId);
        sql += ` AND source_project_id = $${values.length}`;
      }
      if (query?.sourceEnvironment !== undefined) {
        // Explicit null narrows to the project-wide head scope.
        if (query.sourceEnvironment === null) {
          sql += ` AND source_environment IS NULL`;
        } else {
          values.push(query.sourceEnvironment);
          sql += ` AND source_environment = $${values.length}`;
        }
      }
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
        sql += ` AND (name ILIKE $${values.length} OR entity_ref ILIKE $${values.length})`;
      }
      return pagedList(executor, sql, values, params.limit, params.cursor, mapOrgCatalogEntity);
    },

    async deleteOrgCatalogEntitiesForScope(
      orgId: Uuid,
      sourceProjectId: Uuid,
      sourceEnvironment: string | null,
    ): Promise<StateResult<number>> {
      try {
        const result = await executor.execute(
          `DELETE FROM state.org_catalog_entities
            WHERE org_id = $1 AND source_project_id = $2
              AND COALESCE(source_environment, '') = COALESCE($3, '')`,
          [orgId, sourceProjectId, sourceEnvironment],
        );
        return { ok: true, value: result.rowCount ?? 0 };
      } catch {
        return safeError("Failed to delete org catalog entities for scope");
      }
    },

    async getOrgStateStorage(orgId: Uuid): Promise<StateResult<StateStorageUsage>> {
      try {
        // Two indexed aggregates over the org's denormalized indexes. bigint
        // sums arrive as strings under pg — coerce defensively.
        const [objects, logs] = await Promise.all([
          executor.execute<Record<string, unknown>>(
            `SELECT count(*)::bigint AS count, COALESCE(sum(size_bytes), 0)::bigint AS bytes
               FROM state.objects WHERE org_id = $1`,
            [orgId],
          ),
          executor.execute<Record<string, unknown>>(
            `SELECT count(*)::bigint AS count, COALESCE(sum(byte_length), 0)::bigint AS bytes
               FROM state.log_chunks WHERE org_id = $1`,
            [orgId],
          ),
        ]);
        const num = (v: unknown): number => {
          const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : v == null ? 0 : Number(v);
          return Number.isFinite(n) && n >= 0 ? n : 0;
        };
        const o = objects.rows[0] ?? {};
        const l = logs.rows[0] ?? {};
        return {
          ok: true,
          value: {
            objects: { count: num(o.count), bytes: num(o.bytes) },
            logs: { count: num(l.count), bytes: num(l.bytes) },
          },
        };
      } catch {
        return safeError("Failed to read org state storage");
      }
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

    // ── scm.* triggers (OV4 — GitHub App bridge inbound projection) ─

    async recordTrigger(input: RecordTriggerInput): Promise<StateResult<RecordTriggerOutcome>> {
      try {
        // Idempotent by the source event id: a redelivered/reprocessed event is
        // a no-op. INSERT … ON CONFLICT (event_id) DO NOTHING returns the row
        // only when freshly inserted.
        const inserted = await executor.execute<Record<string, unknown>>(
          `INSERT INTO state.triggers
             (id, org_id, project_id, provider, provider_repo_id, repo_full_name,
              kind, action, ref, commit_sha, base_sha, pr_number, actor_login,
              event_id, occurred_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
           ON CONFLICT (event_id) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId ?? null,
            input.provider,
            input.providerRepoId,
            input.repoFullName ?? null,
            input.kind,
            input.action ?? null,
            input.ref ?? null,
            input.commitSha,
            input.baseSha ?? null,
            input.prNumber ?? null,
            input.actorLogin ?? null,
            input.eventId,
            input.occurredAt,
          ],
        );
        if (inserted.rowCount > 0) {
          return { ok: true, value: { trigger: mapTrigger(inserted.rows[0]!), created: true } };
        }
        const existing = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM state.triggers WHERE event_id = $1`,
          [input.eventId],
        );
        if (existing.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: { trigger: mapTrigger(existing.rows[0]!), created: false } };
      } catch {
        return safeError("Failed to record trigger");
      }
    },

    async readScmIngestCursor(): Promise<StateResult<ScmIngestCursor>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT last_occurred_at, last_event_id FROM state.scm_ingest_cursor WHERE id = 'default'`,
        );
        if (result.rowCount === 0) {
          return { ok: true, value: { lastOccurredAt: null, lastEventId: null } };
        }
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            lastOccurredAt: row.last_occurred_at ? toDate(row.last_occurred_at).toISOString() : null,
            lastEventId: (row.last_event_id as string) ?? null,
          },
        };
      } catch {
        return safeError("Failed to read scm ingest cursor");
      }
    },

    async advanceScmIngestCursor(lastOccurredAt: string, lastEventId: string): Promise<StateResult<void>> {
      try {
        await executor.execute(
          `INSERT INTO state.scm_ingest_cursor (id, last_occurred_at, last_event_id, updated_at)
           VALUES ('default', $1, $2, now())
           ON CONFLICT (id) DO UPDATE
             SET last_occurred_at = EXCLUDED.last_occurred_at,
                 last_event_id = EXCLUDED.last_event_id,
                 updated_at = now()`,
          [lastOccurredAt, lastEventId],
        );
        return { ok: true, value: undefined };
      } catch {
        return safeError("Failed to advance scm ingest cursor");
      }
    },

    async readRunWritebackCursor(): Promise<StateResult<ScmIngestCursor>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT last_occurred_at, last_event_id FROM state.run_writeback_cursor WHERE id = 'default'`,
        );
        if (result.rowCount === 0) {
          return { ok: true, value: { lastOccurredAt: null, lastEventId: null } };
        }
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            lastOccurredAt: row.last_occurred_at ? toDate(row.last_occurred_at).toISOString() : null,
            lastEventId: (row.last_event_id as string) ?? null,
          },
        };
      } catch {
        return safeError("Failed to read run write-back cursor");
      }
    },

    async advanceRunWritebackCursor(lastOccurredAt: string, lastEventId: string): Promise<StateResult<void>> {
      try {
        await executor.execute(
          `INSERT INTO state.run_writeback_cursor (id, last_occurred_at, last_event_id, updated_at)
           VALUES ('default', $1, $2, now())
           ON CONFLICT (id) DO UPDATE
             SET last_occurred_at = EXCLUDED.last_occurred_at,
                 last_event_id = EXCLUDED.last_event_id,
                 updated_at = now()`,
          [lastOccurredAt, lastEventId],
        );
        return { ok: true, value: undefined };
      } catch {
        return safeError("Failed to advance run write-back cursor");
      }
    },

    async listTriggers(
      orgId: Uuid,
      params: PageQueryParams,
      query?: ListTriggersQuery,
    ): Promise<StateResult<PagedResult<StateTrigger>>> {
      const values: unknown[] = [orgId];
      let sql = `SELECT * FROM state.triggers WHERE org_id = $1`;
      if (query?.projectId) {
        values.push(query.projectId);
        sql += ` AND project_id = $${values.length}`;
      }
      if (query?.providerRepoId) {
        values.push(query.providerRepoId);
        sql += ` AND provider_repo_id = $${values.length}`;
      }
      return pagedList(executor, sql, values, params.limit, params.cursor, mapTrigger, "occurred_at");
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

    async hasActiveWorkspaceLink(orgId: Uuid, projectId: Uuid): Promise<StateResult<boolean>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT 1 FROM state.workspace_links
             WHERE org_id = $1 AND project_id = $2 AND status = 'active'
             LIMIT 1`,
          [orgId, projectId],
        );
        return { ok: true, value: result.rowCount > 0 };
      } catch {
        return safeError("Failed to check workspace link");
      }
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

    async updateWorkspaceLinkCiSettings(
      input: UpdateWorkspaceLinkCiSettingsInput,
    ): Promise<StateResult<WorkspaceLink>> {
      // Build a partial UPDATE: only the provided fields change (COALESCE keeps
      // the rest). allowed_ref_pattern / allowed_environments are nullable, so a
      // sentinel ('__keep__') distinguishes "set to null" from "leave unchanged".
      const sets: string[] = [];
      const values: unknown[] = [input.orgId, input.id];
      const add = (col: string, val: unknown) => {
        values.push(val);
        sets.push(`${col} = $${values.length}`);
      };
      if (input.oidcEnabled !== undefined) add("oidc_enabled", input.oidcEnabled);
      if (input.apiKeyEnabled !== undefined) add("api_key_enabled", input.apiKeyEnabled);
      if (input.allowedRefPattern !== undefined) add("allowed_ref_pattern", input.allowedRefPattern);
      if (input.allowedEnvironments !== undefined) {
        add(
          "allowed_environments",
          input.allowedEnvironments === null ? null : JSON.stringify(input.allowedEnvironments),
        );
      }
      try {
        if (sets.length === 0) {
          // No-op update: return the current active row.
          const cur = await executor.execute<Record<string, unknown>>(
            `SELECT * FROM state.workspace_links WHERE org_id = $1 AND id = $2 AND status = 'active'`,
            [input.orgId, input.id],
          );
          if (cur.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
          return { ok: true, value: mapWorkspaceLink(cur.rows[0]!) };
        }
        sets.push("updated_at = now()");
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE state.workspace_links SET ${sets.join(", ")}
            WHERE org_id = $1 AND id = $2 AND status = 'active'
            RETURNING *`,
          values,
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapWorkspaceLink(result.rows[0]!) };
      } catch {
        return safeError("Failed to update workspace link CI settings");
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
