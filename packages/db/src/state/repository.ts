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
  ListCatalogEntitiesQuery,
  ListRunsQuery,
  LogChunk,
  PagedResult,
  PageQueryParams,
  Run,
  RunJob,
  StateObject,
  StateObjectKind,
  StateRepository,
  StateResult,
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
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12, $13, now(), now())
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
          `INSERT INTO state.run_jobs
             (id, org_id, project_id, run_id, job_id, component, deps, status,
              attempt, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 1, now(), now())
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
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT digest FROM state.objects
            WHERE org_id = $1 AND project_id = $2 AND digest = ANY($3::text[])`,
          [orgId, projectId, digests],
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

    // ── Workspace links ──────────────────────────────────────

    async createWorkspaceLink(
      input: CreateWorkspaceLinkInput,
    ): Promise<StateResult<WorkspaceLink>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO state.workspace_links
             (id, org_id, project_id, remote_url, status, created_by,
              created_by_kind, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'active', $5, $6, now(), now())
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId,
            input.remoteUrl,
            input.createdBy?.id ?? null,
            input.createdBy?.kind ?? null,
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
