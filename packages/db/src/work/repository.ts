import type { SqlExecutor, TransactionalSqlExecutor } from "../hyperdrive/executor.js";
import {
  API_VERSION,
  WorkError,
  WorkProjection,
  formatTaskKey,
  isLinkType,
  isStatus,
  validateActor,
  type Actor,
  type Contract,
  type Item,
  type Status,
  type StatusRow,
  type WorkEvent,
} from "./model.js";
import type {
  AssignInput,
  CommentInput,
  CommitOutcome,
  CreateItemInput,
  EditContractInput,
  EditItemInput,
  EnsureProjectInput,
  LinkInput,
  ProjectScope,
  RemoveLinkInput,
  SetStatusInput,
  WorkRepository,
  WorkRepositoryError,
  WorkResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// JSON / row helpers
// ---------------------------------------------------------------------------

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function logicalProject(scope: ProjectScope): string {
  return `${scope.orgId}/${scope.projectId}`;
}

function nowIso(at?: string): string {
  return at ?? new Date().toISOString();
}

function mapItem(row: Record<string, unknown>): Item {
  return {
    apiVersion: API_VERSION,
    kind: row.kind as Item["kind"],
    id: row.id as string,
    key: row.key as string,
    project: logicalProject({ orgId: row.org_id as string, projectId: row.project_id as string }),
    title: row.title as string,
    doc: (row.doc as string | null) ?? undefined,
    parent: (row.parent as string | null) ?? undefined,
    cycle: (row.cycle as string | null) ?? undefined,
    labels: emptyToUndefined(parseJson<Record<string, string>>(row.labels, {})),
    contract: (parseJson<Contract | null>(row.contract, null)) ?? undefined,
    createdBy: parseJson<Actor>(row.created_by, { type: "automation", id: "unknown" }),
    createdAt: toIso(row.created_at),
  };
}

function mapStatus(row: Record<string, unknown>): StatusRow {
  return {
    project: logicalProject({ orgId: row.org_id as string, projectId: row.project_id as string }),
    key: row.key as string,
    status: row.status as StatusRow["status"],
    assignees: parseJson<string[]>(row.assignees, []),
    boardOrder: Number(row.board_order),
    updatedSeq: Number(row.updated_seq),
  };
}

function emptyToUndefined(m: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(m).length === 0 ? undefined : m;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function ok<T>(value: T): WorkResult<T> {
  return { ok: true, value };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function toError(err: unknown): WorkRepositoryError {
  if (err instanceof WorkError) {
    switch (err.kind) {
      case "not_found":
        return { kind: "not_found", entity: err.message };
      case "conflict":
        return { kind: "conflict", entity: err.message };
      case "invalid_argument":
      case "invalid_link":
      case "missing_actor":
      case "unknown_event_kind":
      case "invalid_event":
        return { kind: "invalid_argument", message: err.message };
      default:
        return { kind: "internal", message: err.message };
    }
  }
  if (isUniqueViolation(err)) return { kind: "conflict", entity: "work entity" };
  return { kind: "internal", message: err instanceof Error ? err.message : String(err) };
}

// ---------------------------------------------------------------------------
// Sequence allocation (the Durable-Object-equivalent total order)
// ---------------------------------------------------------------------------

interface Allocation {
  seq: number;
  taskSeq: number;
  prefix: string;
}

async function allocate(tx: SqlExecutor, scope: ProjectScope, alsoTask: boolean): Promise<Allocation> {
  const setClause = alsoTask
    ? "next_seq = next_seq + 1, next_task_seq = next_task_seq + 1"
    : "next_seq = next_seq + 1";
  const res = await tx.execute<{ seq: string; task_seq: string; prefix: string }>(
    `UPDATE work.sequences SET ${setClause}
       WHERE org_id = $1 AND project_id = $2
       RETURNING next_seq - 1 AS seq, next_task_seq - 1 AS task_seq, prefix`,
    [scope.orgId, scope.projectId],
  );
  const r = res.rows[0];
  if (!r) {
    throw new WorkError("not_found", "project not registered; call ensureProject first");
  }
  return { seq: Number(r.seq), taskSeq: Number(r.task_seq), prefix: r.prefix };
}

async function insertEvent(
  tx: SqlExecutor,
  scope: ProjectScope,
  ev: { subject: string; kind: WorkEvent["kind"]; actor: Actor; at: string; payload: Record<string, unknown>; seq: number },
): Promise<WorkEvent> {
  const res = await tx.execute<{ event_id: string }>(
    `INSERT INTO work.events (org_id, project_id, subject, kind, actor, at, payload, seq)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
       RETURNING event_id`,
    [scope.orgId, scope.projectId, ev.subject, ev.kind, JSON.stringify(ev.actor), ev.at, JSON.stringify(ev.payload), ev.seq],
  );
  const inserted = res.rows[0];
  if (!inserted) throw new Error("work event insert returned no row");
  return {
    eventId: inserted.event_id,
    project: logicalProject(scope),
    subject: ev.subject,
    kind: ev.kind,
    actor: ev.actor,
    at: ev.at,
    payload: ev.payload,
    seq: ev.seq,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export function createWorkRepository(sql: TransactionalSqlExecutor): WorkRepository {
  async function requireStatusRow(tx: SqlExecutor, scope: ProjectScope, key: string): Promise<StatusRow> {
    const res = await tx.execute(
      `SELECT * FROM work.status WHERE org_id = $1 AND project_id = $2 AND key = $3`,
      [scope.orgId, scope.projectId, key],
    );
    const row = res.rows[0];
    if (!row) throw new WorkError("not_found", `${key} not found`);
    return mapStatus(row);
  }

  async function requireItemRow(tx: SqlExecutor, scope: ProjectScope, key: string): Promise<Item> {
    const res = await tx.execute(
      `SELECT * FROM work.items WHERE org_id = $1 AND project_id = $2 AND key = $3`,
      [scope.orgId, scope.projectId, key],
    );
    const row = res.rows[0];
    if (!row) throw new WorkError("not_found", `${key} not found`);
    return mapItem(row);
  }

  async function listEventsImpl(scope: ProjectScope, fromSeq: number): Promise<WorkResult<WorkEvent[]>> {
    try {
      const res = await sql.execute(
        `SELECT * FROM work.events WHERE org_id=$1 AND project_id=$2 AND seq > $3 ORDER BY seq ASC`,
        [scope.orgId, scope.projectId, fromSeq],
      );
      const events: WorkEvent[] = res.rows.map((row) => ({
        eventId: row.event_id as string,
        project: logicalProject(scope),
        subject: row.subject as string,
        kind: row.kind as WorkEvent["kind"],
        actor: parseJson<Actor>(row.actor, { type: "automation", id: "unknown" }),
        at: toIso(row.at),
        payload: parseJson<Record<string, unknown>>(row.payload, {}),
        seq: Number(row.seq),
      }));
      return ok(events);
    } catch (err) {
      return { ok: false, error: toError(err) };
    }
  }

  async function applyAssign(input: AssignInput, add: boolean): Promise<WorkResult<CommitOutcome>> {
    try {
      validateActor(input.actor);
      if (!input.principal) throw new WorkError("invalid_argument", "principal is required");
      const at = nowIso(input.at);
      const outcome = await sql.transaction(async (tx) => {
        const row = await requireStatusRow(tx, input, input.key);
        const next = add
          ? [...new Set([...row.assignees, input.principal])].sort()
          : row.assignees.filter((a) => a !== input.principal);
        const alloc = await allocate(tx, input, false);
        await tx.execute(
          `UPDATE work.status SET assignees = $4::jsonb, updated_seq = $5 WHERE org_id=$1 AND project_id=$2 AND key=$3`,
          [input.orgId, input.projectId, input.key, JSON.stringify(next), alloc.seq],
        );
        const event = await insertEvent(tx, input, {
          subject: input.key,
          kind: add ? "assigned" : "unassigned",
          actor: input.actor,
          at,
          payload: { principal: input.principal },
          seq: alloc.seq,
        });
        return { event, key: input.key };
      });
      return ok(outcome);
    } catch (err) {
      return { ok: false, error: toError(err) };
    }
  }

  return {
    async ensureProject(input: EnsureProjectInput): Promise<WorkResult<void>> {
      try {
        if (!/^[A-Z]{2,5}$/.test(input.prefix)) {
          throw new WorkError("invalid_argument", "prefix must be 2-5 uppercase letters");
        }
        await sql.execute(
          `INSERT INTO work.sequences (org_id, project_id, prefix)
             VALUES ($1, $2, $3)
             ON CONFLICT (org_id, project_id) DO NOTHING`,
          [input.orgId, input.projectId, input.prefix],
        );
        return ok(undefined);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },

    async createItem(input: CreateItemInput): Promise<WorkResult<CommitOutcome>> {
      try {
        validateActor(input.actor);
        if (!input.title) throw new WorkError("invalid_argument", "title is required");
        if (input.contract && input.kind !== "Task") {
          throw new WorkError("invalid_argument", "only Tasks carry a contract");
        }
        const at = nowIso(input.at);
        const outcome = await sql.transaction(async (tx) => {
          const alloc = await allocate(tx, input, input.kind === "Task");
          const key = input.kind === "Task" ? formatTaskKey(alloc.prefix, alloc.taskSeq) : input.slug;
          if (!key) throw new WorkError("invalid_argument", "Epic/Initiative requires a slug");
          const createdBy: Actor = { type: input.actor.type, id: input.actor.id };
          const itemRes = await tx.execute<{ id: string }>(
            `INSERT INTO work.items
               (org_id, project_id, kind, key, title, doc, parent, cycle, labels, contract, created_by, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)
               RETURNING id`,
            [
              input.orgId,
              input.projectId,
              input.kind,
              key,
              input.title,
              input.doc ?? null,
              input.parent ?? null,
              input.cycle ?? null,
              JSON.stringify(input.labels ?? {}),
              input.contract ? JSON.stringify(input.contract) : null,
              JSON.stringify(createdBy),
              at,
            ],
          );
          const itemRow = itemRes.rows[0];
          if (!itemRow) throw new Error("work item insert returned no row");
          const item: Item = {
            apiVersion: API_VERSION,
            kind: input.kind,
            id: itemRow.id,
            key,
            project: logicalProject(input),
            title: input.title,
            doc: input.doc,
            parent: input.parent,
            cycle: input.cycle,
            labels: input.labels,
            contract: input.contract,
            createdBy,
            createdAt: at,
          };
          await tx.execute(
            `INSERT INTO work.status (org_id, project_id, key, status, assignees, board_order, updated_seq)
               VALUES ($1,$2,$3,'backlog','[]'::jsonb,$4,$4)`,
            [input.orgId, input.projectId, key, alloc.seq],
          );
          const event = await insertEvent(tx, input, {
            subject: key,
            kind: "item_created",
            actor: input.actor,
            at,
            payload: { item },
            seq: alloc.seq,
          });
          return { event, key };
        });
        return ok(outcome);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },

    async editItem(input: EditItemInput): Promise<WorkResult<CommitOutcome>> {
      try {
        validateActor(input.actor);
        if (input.title === undefined && input.doc === undefined) {
          throw new WorkError("invalid_argument", "nothing to edit");
        }
        const at = nowIso(input.at);
        const outcome = await sql.transaction(async (tx) => {
          await requireItemRow(tx, input, input.key);
          const alloc = await allocate(tx, input, false);
          if (input.title !== undefined) {
            await tx.execute(`UPDATE work.items SET title = $4 WHERE org_id=$1 AND project_id=$2 AND key=$3`, [
              input.orgId,
              input.projectId,
              input.key,
              input.title,
            ]);
          }
          if (input.doc !== undefined) {
            await tx.execute(`UPDATE work.items SET doc = $4 WHERE org_id=$1 AND project_id=$2 AND key=$3`, [
              input.orgId,
              input.projectId,
              input.key,
              input.doc,
            ]);
          }
          const event = await insertEvent(tx, input, {
            subject: input.key,
            kind: "item_edited",
            actor: input.actor,
            at,
            payload: { title: input.title, doc: input.doc },
            seq: alloc.seq,
          });
          return { event, key: input.key };
        });
        return ok(outcome);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },

    async setStatus(input: SetStatusInput): Promise<WorkResult<CommitOutcome>> {
      try {
        validateActor(input.actor);
        if (!isStatus(input.status)) throw new WorkError("invalid_argument", "status not in the closed set");
        const at = nowIso(input.at);
        const outcome = await sql.transaction(async (tx) => {
          const row = await requireStatusRow(tx, input, input.key);
          const alloc = await allocate(tx, input, false);
          await tx.execute(
            `UPDATE work.status SET status = $4, updated_seq = $5 WHERE org_id=$1 AND project_id=$2 AND key=$3`,
            [input.orgId, input.projectId, input.key, input.status, alloc.seq],
          );
          const event = await insertEvent(tx, input, {
            subject: input.key,
            kind: "status_changed",
            actor: input.actor,
            at,
            payload: { from: row.status, to: input.status, cause: input.cause },
            seq: alloc.seq,
          });
          return { event, key: input.key };
        });
        return ok(outcome);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },

    async assign(input: AssignInput): Promise<WorkResult<CommitOutcome>> {
      return applyAssign(input, true);
    },

    async unassign(input: AssignInput): Promise<WorkResult<CommitOutcome>> {
      return applyAssign(input, false);
    },

    async addComment(input: CommentInput): Promise<WorkResult<CommitOutcome>> {
      try {
        validateActor(input.actor);
        if (!input.body) throw new WorkError("invalid_argument", "comment body is required");
        const at = nowIso(input.at);
        const outcome = await sql.transaction(async (tx) => {
          await requireItemRow(tx, input, input.key);
          const alloc = await allocate(tx, input, false);
          const event = await insertEvent(tx, input, {
            subject: input.key,
            kind: "comment_added",
            actor: input.actor,
            at,
            payload: { body: input.body },
            seq: alloc.seq,
          });
          return { event, key: input.key };
        });
        return ok(outcome);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },

    async addLink(input: LinkInput): Promise<WorkResult<CommitOutcome>> {
      try {
        validateActor(input.actor);
        if (!isLinkType(input.type)) throw new WorkError("invalid_link", "link type not in the vocabulary");
        if (!input.from || !input.to) throw new WorkError("invalid_link", "from and to are required");
        const at = nowIso(input.at);
        const createdBy: Actor = { type: input.actor.type, id: input.actor.id };
        const outcome = await sql.transaction(async (tx) => {
          const alloc = await allocate(tx, input, false);
          await tx.execute(
            `INSERT INTO work.links (org_id, project_id, from_key, from_kind, type, to_key, to_kind, created_by, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
               ON CONFLICT (org_id, project_id, from_key, type, to_key)
               DO UPDATE SET from_kind = EXCLUDED.from_kind, to_kind = EXCLUDED.to_kind`,
            [input.orgId, input.projectId, input.from, input.fromKind, input.type, input.to, input.toKind, JSON.stringify(createdBy), at],
          );
          const link = {
            project: logicalProject(input),
            from: input.from,
            fromKind: input.fromKind,
            type: input.type,
            to: input.to,
            toKind: input.toKind,
            createdBy,
            createdAt: at,
          };
          const event = await insertEvent(tx, input, {
            subject: input.from,
            kind: "link_added",
            actor: input.actor,
            at,
            payload: { link },
            seq: alloc.seq,
          });
          return { event, key: input.from };
        });
        return ok(outcome);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },

    async removeLink(input: RemoveLinkInput): Promise<WorkResult<CommitOutcome>> {
      try {
        validateActor(input.actor);
        if (!isLinkType(input.type)) throw new WorkError("invalid_link", "link type not in the vocabulary");
        const at = nowIso(input.at);
        const outcome = await sql.transaction(async (tx) => {
          const alloc = await allocate(tx, input, false);
          await tx.execute(
            `DELETE FROM work.links WHERE org_id=$1 AND project_id=$2 AND from_key=$3 AND type=$4 AND to_key=$5`,
            [input.orgId, input.projectId, input.from, input.type, input.to],
          );
          const event = await insertEvent(tx, input, {
            subject: input.from,
            kind: "link_removed",
            actor: input.actor,
            at,
            payload: { link: { from: input.from, type: input.type, to: input.to } },
            seq: alloc.seq,
          });
          return { event, key: input.from };
        });
        return ok(outcome);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },

    async editContract(input: EditContractInput): Promise<WorkResult<CommitOutcome>> {
      try {
        validateActor(input.actor);
        const at = nowIso(input.at);
        const outcome = await sql.transaction(async (tx) => {
          const item = await requireItemRow(tx, input, input.key);
          if (item.kind !== "Task") throw new WorkError("invalid_argument", "only Tasks carry a contract");
          const alloc = await allocate(tx, input, false);
          await tx.execute(`UPDATE work.items SET contract = $4 WHERE org_id=$1 AND project_id=$2 AND key=$3`, [
            input.orgId,
            input.projectId,
            input.key,
            input.contract ? JSON.stringify(input.contract) : null,
          ]);
          const event = await insertEvent(tx, input, {
            subject: input.key,
            kind: "contract_edited",
            actor: input.actor,
            at,
            payload: { contract: input.contract ?? null },
            seq: alloc.seq,
          });
          return { event, key: input.key };
        });
        return ok(outcome);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },

    async getItem(scope: ProjectScope, key: string): Promise<WorkResult<Item | null>> {
      try {
        const res = await sql.execute(`SELECT * FROM work.items WHERE org_id=$1 AND project_id=$2 AND key=$3`, [
          scope.orgId,
          scope.projectId,
          key,
        ]);
        const row = res.rows[0];
        return ok(row ? mapItem(row) : null);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },

    async getStatus(scope: ProjectScope, key: string): Promise<WorkResult<StatusRow | null>> {
      try {
        const res = await sql.execute(`SELECT * FROM work.status WHERE org_id=$1 AND project_id=$2 AND key=$3`, [
          scope.orgId,
          scope.projectId,
          key,
        ]);
        const row = res.rows[0];
        return ok(row ? mapStatus(row) : null);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },

    async listEvents(scope: ProjectScope, fromSeq = 0): Promise<WorkResult<WorkEvent[]>> {
      return listEventsImpl(scope, fromSeq);
    },

    async listOpenTasks(scope: ProjectScope) {
      try {
        const res = await sql.execute(
          `SELECT i.key AS key, s.status AS status, i.contract AS contract
             FROM work.items i
             JOIN work.status s
               ON s.org_id = i.org_id AND s.project_id = i.project_id AND s.key = i.key
            WHERE i.org_id = $1 AND i.project_id = $2 AND i.kind = 'Task'
              AND s.status IN ('backlog', 'todo', 'in_progress', 'in_review')`,
          [scope.orgId, scope.projectId],
        );
        const tasks = res.rows.map((row) => {
          const contract = parseJson<Contract | null>(row.contract, null);
          return {
            key: row.key as string,
            status: row.status as Status,
            affects: contract?.affects ?? [],
          };
        });
        return ok(tasks);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },

    async rebuildProjection(scope: ProjectScope): Promise<WorkResult<number>> {
      try {
        const prefixRes = await sql.execute<{ prefix: string }>(
          `SELECT prefix FROM work.sequences WHERE org_id=$1 AND project_id=$2`,
          [scope.orgId, scope.projectId],
        );
        const prefixRow = prefixRes.rows[0];
        if (!prefixRow) throw new WorkError("not_found", "project not registered");
        const prefix = prefixRow.prefix;

        const eventsRes = await listEventsImpl(scope, 0);
        if (!eventsRes.ok) return eventsRes;

        // Reuse the tested reducer to compute the authoritative projection.
        const projection = WorkProjection.reduce(logicalProject(scope), prefix, eventsRes.value);
        const rows = [...projection.status.values()];

        const count = await sql.transaction(async (tx) => {
          await tx.execute(`DELETE FROM work.status WHERE org_id=$1 AND project_id=$2`, [scope.orgId, scope.projectId]);
          for (const row of rows) {
            await tx.execute(
              `INSERT INTO work.status (org_id, project_id, key, status, assignees, board_order, updated_seq)
                 VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
              [scope.orgId, scope.projectId, row.key, row.status, JSON.stringify(row.assignees), row.boardOrder, row.updatedSeq],
            );
          }
          return rows.length;
        });
        return ok(count);
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    },
  };
}
