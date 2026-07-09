// Postgres WorkRepository over the 560_work_foundation_v2 schema.
//
// Discipline (mirrors MemoryWorkRepository, which mirrors the Go oracle):
// every mutator appends EXACTLY ONE coordination event and updates the
// intent-envelope cache rows in the SAME transaction; observations enter
// only through ingestObservation (dedupe-idempotent); no code path writes a
// lifecycle anywhere because no such column exists (WP-3).

import type { SqlExecutor, TransactionalSqlExecutor } from "../hyperdrive/executor.js";
import { canonicalDocBody, docDigest } from "./doc.js";
import { buildEnvelopes, type ItemCreatedPayload } from "./envelopes.js";
import {
  API_VERSION,
  WorkError,
  validateActor,
  validateEvent,
  validateObservation,
  type Actor,
  type Contract,
  type CoordinationEvent,
  type DocRevision,
  type EventKind,
  type Initiative,
  type Observation,
  type Spec,
  type Task,
  type WorkSet,
} from "./model.js";
import type {
  AssignInput,
  CancelInput,
  CommentInput,
  CommitOutcome,
  CreateInitiativeInput,
  CreateSpecInput,
  CreateTaskInput,
  EditContractInput,
  EditItemInput,
  IngestObservationInput,
  IngestOutcome,
  OrderInput,
  PinInput,
  PutDocInput,
  PutDocOutcome,
  WorkRepository,
  WorkspaceScope,
} from "./types.js";

const PREFIX_RE = /^[A-Z]{2,5}$/;
const SLUG_RE = /^[a-z0-9-]+$/;

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function emptyToUndefined(m: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(m).length === 0 ? undefined : m;
}

function mapEvent(orgId: string, row: Record<string, unknown>): CoordinationEvent {
  return {
    eventId: String(row.event_id),
    workspace: orgId,
    subject: String(row.subject),
    kind: row.kind as EventKind,
    actor: parseJson<Actor>(row.actor, { type: "automation", id: "unknown" }),
    at: toIso(row.at),
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    seq: Number(row.seq),
  };
}

function mapObservation(orgId: string, row: Record<string, unknown>): Observation {
  return {
    obsId: String(row.obs_id),
    workspace: orgId,
    source: String(row.source),
    sourceVersion: Number(row.source_version),
    kind: row.kind as Observation["kind"],
    at: toIso(row.at),
    dedupeKey: String(row.dedupe_key),
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    seq: Number(row.seq),
  };
}

function mapTask(orgId: string, row: Record<string, unknown>): Task {
  return {
    apiVersion: API_VERSION,
    kind: "Task",
    id: String(row.id),
    key: String(row.key),
    workspace: orgId,
    spec: (row.spec_key as string | null) ?? undefined,
    title: String(row.title),
    labels: emptyToUndefined(parseJson<Record<string, string>>(row.labels, {})),
    contract: parseJson<Contract | null>(row.contract, null) ?? undefined,
    createdBy: parseJson<Actor>(row.created_by, { type: "automation", id: "unknown" }),
    createdAt: toIso(row.created_at),
  };
}

function mapSpec(orgId: string, row: Record<string, unknown>): Spec {
  return {
    apiVersion: API_VERSION,
    kind: "Spec",
    id: String(row.id),
    key: String(row.key),
    workspace: orgId,
    title: String(row.title),
    docRef: (row.doc_ref as string | null) ?? undefined,
    labels: emptyToUndefined(parseJson<Record<string, string>>(row.labels, {})),
    createdBy: parseJson<Actor>(row.created_by, { type: "automation", id: "unknown" }),
    createdAt: toIso(row.created_at),
  };
}

async function nextSeq(tx: SqlExecutor, orgId: string, name: string): Promise<number> {
  const res = await tx.execute(
    `INSERT INTO work.sequences (org_id, name, next_value)
     VALUES ($1, $2, 2)
     ON CONFLICT (org_id, name)
     DO UPDATE SET next_value = work.sequences.next_value + 1
     RETURNING next_value - 1 AS value`,
    [orgId, name],
  );
  return Number(res.rows[0]?.value);
}

async function appendEvent(
  tx: SqlExecutor,
  orgId: string,
  partial: Omit<CoordinationEvent, "eventId" | "workspace" | "seq">,
): Promise<CoordinationEvent> {
  const seq = await nextSeq(tx, orgId, "#events");
  const event: CoordinationEvent = { ...partial, workspace: orgId, seq };
  validateEvent(event);
  const res = await tx.execute(
    `INSERT INTO work.events (org_id, subject, kind, actor, at, payload, seq)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
     RETURNING event_id`,
    [orgId, event.subject, event.kind, JSON.stringify(event.actor), event.at, JSON.stringify(event.payload ?? {}), seq],
  );
  event.eventId = String(res.rows[0]?.event_id);
  return event;
}

async function keyExists(tx: SqlExecutor, orgId: string, key: string): Promise<boolean> {
  const res = await tx.execute(
    `SELECT 1 FROM work.tasks WHERE org_id = $1 AND key = $2
     UNION ALL
     SELECT 1 FROM work.specs WHERE org_id = $1 AND key = $2
     UNION ALL
     SELECT 1 FROM work.initiatives WHERE org_id = $1 AND key = $2
     LIMIT 1`,
    [orgId, key],
  );
  return res.rowCount > 0;
}

function mapInitiative(orgId: string, row: Record<string, unknown>): Initiative {
  return {
    apiVersion: API_VERSION,
    kind: "Initiative",
    id: String(row.id),
    key: String(row.key),
    workspace: orgId,
    title: String(row.title),
    description: (row.description as string | null) ?? undefined,
    createdBy: parseJson<Actor>(row.created_by, { type: "automation", id: "unknown" }),
    createdAt: toIso(row.created_at),
  };
}

function mapDocRevision(row: Record<string, unknown>): DocRevision {
  return {
    revision: String(row.revision),
    parent: (row.parent as string | null) ?? undefined,
    specKey: String(row.spec_key),
    body: String(row.body),
    createdBy: parseJson<Actor>(row.created_by, { type: "automation", id: "unknown" }),
    createdAt: toIso(row.created_at),
  };
}

/**
 * Executor-level observation insert — the only fact writer, usable inside an
 * existing transaction (the webhook drain projects scm.* events through this
 * in the same tx that emits the platform event). Idempotent by
 * (org_id, dedupe_key): the same world fact twice folds identically
 * (invariant 4).
 */
export async function insertWorkObservation(
  tx: SqlExecutor,
  orgId: string,
  input: IngestObservationInput,
): Promise<IngestOutcome> {
  validateObservation({ ...input, workspace: orgId, seq: 0 });
  const seq = await nextSeq(tx, orgId, "#observations");
  const res = await tx.execute(
    `INSERT INTO work.observations (org_id, source, source_version, kind, at, dedupe_key, payload, seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (org_id, dedupe_key) DO NOTHING
     RETURNING *`,
    [orgId, input.source, input.sourceVersion, input.kind, input.at, input.dedupeKey, JSON.stringify(input.payload ?? {}), seq],
  );
  if (res.rowCount === 0) {
    return { observation: null, deduped: true };
  }
  return { observation: mapObservation(orgId, res.rows[0]!), deduped: false };
}

export function createWorkRepository(
  sql: TransactionalSqlExecutor,
  now: () => string = () => new Date().toISOString(),
): WorkRepository & { rebuildCaches(scope: WorkspaceScope): Promise<{ specs: number; tasks: number; initiatives: number }> } {
  const simpleMutation = async (
    scope: WorkspaceScope,
    key: string,
    kind: CoordinationEvent["kind"],
    actor: Actor,
    at: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<CommitOutcome> => {
    validateActor(actor);
    return sql.transaction(async (tx) => {
      if (!(await keyExists(tx, scope.orgId, key))) {
        throw new WorkError("not_found", `unknown item ${key}`);
      }
      const event = await appendEvent(tx, scope.orgId, {
        subject: key,
        kind,
        actor,
        at: at ?? now(),
        payload,
      });
      return { event, key };
    });
  };

  return {
    async createSpec(scope, input: CreateSpecInput) {
      validateActor(input.actor);
      if (!SLUG_RE.test(input.slug)) {
        throw new WorkError("invalid", `spec slug ${input.slug} must be lowercase kebab`);
      }
      return sql.transaction(async (tx) => {
        if (await keyExists(tx, scope.orgId, input.slug)) {
          throw new WorkError("conflict", `spec ${input.slug} already exists`);
        }
        const at = input.at ?? now();
        const payload: ItemCreatedPayload = {
          kind: "Spec",
          key: input.slug,
          title: input.title,
          docRef: input.docRef,
          labels: input.labels,
        };
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.slug,
          kind: "item_created",
          actor: input.actor,
          at,
          payload: payload as unknown as Record<string, unknown>,
        });
        const res = await tx.execute(
          `INSERT INTO work.specs (org_id, key, title, doc_ref, labels, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
           RETURNING *`,
          [scope.orgId, input.slug, input.title, input.docRef ?? null, JSON.stringify(input.labels ?? {}), JSON.stringify(input.actor), at],
        );
        return { event, key: input.slug, spec: mapSpec(scope.orgId, res.rows[0]!) };
      });
    },

    async createInitiative(scope, input: CreateInitiativeInput) {
      validateActor(input.actor);
      if (!SLUG_RE.test(input.slug)) {
        throw new WorkError("invalid", `initiative slug ${input.slug} must be lowercase kebab`);
      }
      return sql.transaction(async (tx) => {
        if (await keyExists(tx, scope.orgId, input.slug)) {
          throw new WorkError("conflict", `item ${input.slug} already exists`);
        }
        const at = input.at ?? now();
        const payload: ItemCreatedPayload = {
          kind: "Initiative",
          key: input.slug,
          title: input.title,
          description: input.description,
        };
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.slug,
          kind: "item_created",
          actor: input.actor,
          at,
          payload: payload as unknown as Record<string, unknown>,
        });
        const res = await tx.execute(
          `INSERT INTO work.initiatives (org_id, key, title, description, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING *`,
          [scope.orgId, input.slug, input.title, input.description ?? null, JSON.stringify(input.actor), at],
        );
        return { event, key: input.slug, initiative: mapInitiative(scope.orgId, res.rows[0]!) };
      });
    },

    async createTask(scope, input: CreateTaskInput) {
      validateActor(input.actor);
      if (!PREFIX_RE.test(input.prefix)) {
        throw new WorkError("invalid", `prefix ${input.prefix} must be 2–5 uppercase letters`);
      }
      return sql.transaction(async (tx) => {
        if (input.specKey && !(await keyExists(tx, scope.orgId, input.specKey))) {
          throw new WorkError("not_found", `spec ${input.specKey} does not exist`);
        }
        const n = await nextSeq(tx, scope.orgId, input.prefix);
        const key = `${input.prefix}-${n}`;
        const at = input.at ?? now();
        const payload: ItemCreatedPayload = {
          kind: "Task",
          key,
          title: input.title,
          specKey: input.specKey,
          labels: input.labels,
          contract: input.contract,
        };
        const event = await appendEvent(tx, scope.orgId, {
          subject: key,
          kind: "item_created",
          actor: input.actor,
          at,
          payload: payload as unknown as Record<string, unknown>,
        });
        const res = await tx.execute(
          `INSERT INTO work.tasks (org_id, key, spec_key, title, contract, labels, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
           RETURNING *`,
          [
            scope.orgId,
            key,
            input.specKey ?? null,
            input.title,
            input.contract ? JSON.stringify(input.contract) : null,
            JSON.stringify(input.labels ?? {}),
            JSON.stringify(input.actor),
            at,
          ],
        );
        return { event, key, task: mapTask(scope.orgId, res.rows[0]!) };
      });
    },

    async editItem(scope, input: EditItemInput) {
      validateActor(input.actor);
      return sql.transaction(async (tx) => {
        if (!(await keyExists(tx, scope.orgId, input.key))) {
          throw new WorkError("not_found", `unknown item ${input.key}`);
        }
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "item_edited",
          actor: input.actor,
          at: input.at ?? now(),
          payload: { title: input.title, labels: input.labels, docRef: input.docRef },
        });
        if (input.title !== undefined || input.labels !== undefined) {
          await tx.execute(
            `UPDATE work.tasks SET
               title = COALESCE($3, title),
               labels = COALESCE($4::jsonb, labels)
             WHERE org_id = $1 AND key = $2`,
            [scope.orgId, input.key, input.title ?? null, input.labels ? JSON.stringify(input.labels) : null],
          );
        }
        await tx.execute(
          `UPDATE work.specs SET
             title = COALESCE($3, title),
             labels = COALESCE($4::jsonb, labels),
             doc_ref = COALESCE($5, doc_ref)
           WHERE org_id = $1 AND key = $2`,
          [scope.orgId, input.key, input.title ?? null, input.labels ? JSON.stringify(input.labels) : null, input.docRef ?? null],
        );
        return { event, key: input.key };
      });
    },

    async editContract(scope, input: EditContractInput) {
      validateActor(input.actor);
      return sql.transaction(async (tx) => {
        const res = await tx.execute(`SELECT 1 FROM work.tasks WHERE org_id = $1 AND key = $2`, [scope.orgId, input.key]);
        if (res.rowCount === 0) {
          throw new WorkError("not_found", `unknown task ${input.key}`);
        }
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "contract_edited",
          actor: input.actor,
          at: input.at ?? now(),
          payload: { contract: input.contract },
        });
        await tx.execute(`UPDATE work.tasks SET contract = $3::jsonb WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.key,
          JSON.stringify(input.contract),
        ]);
        return { event, key: input.key };
      });
    },

    async assign(scope, input: AssignInput) {
      return simpleMutation(scope, input.key, "assigned", input.actor, input.at, { subjectId: input.subject });
    },
    async unassign(scope, input: AssignInput) {
      return simpleMutation(scope, input.key, "unassigned", input.actor, input.at, { subjectId: input.subject });
    },
    async comment(scope, input: CommentInput) {
      return simpleMutation(scope, input.key, "comment_added", input.actor, input.at, { body: input.body });
    },
    async order(scope, input: OrderInput) {
      return simpleMutation(scope, input.key, "ordered", input.actor, input.at, { view: input.view, order: input.order });
    },
    async pin(scope, input: PinInput) {
      return simpleMutation(scope, input.key, "pinned", input.actor, input.at, {
        rung: input.rung ?? undefined,
        note: input.note,
      });
    },
    async cancel(scope, input: CancelInput) {
      return simpleMutation(scope, input.key, "canceled", input.actor, input.at, {});
    },

    async putDocRevision(scope, input: PutDocInput): Promise<PutDocOutcome> {
      validateActor(input.actor);
      const body = canonicalDocBody(input.body);
      const revision = await docDigest(body);
      return sql.transaction(async (tx) => {
        const specRes = await tx.execute(`SELECT doc_ref FROM work.specs WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.specKey,
        ]);
        if (specRes.rowCount === 0) {
          throw new WorkError("not_found", `unknown spec ${input.specKey}`);
        }
        const current = (specRes.rows[0]!.doc_ref as string | null) ?? undefined;
        if (revision === current) {
          // An identical save is a no-op: no revision row, no event.
          return { revision, parent: current, created: false, event: null };
        }
        const parent = input.parent ?? current;
        const at = input.at ?? now();
        await tx.execute(
          `INSERT INTO work.doc_revisions (org_id, revision, parent, spec_key, body, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (org_id, revision) DO NOTHING`,
          [scope.orgId, revision, parent ?? null, input.specKey, body, JSON.stringify(input.actor), at],
        );
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.specKey,
          kind: "doc_edited",
          actor: input.actor,
          at,
          payload: { revision, parent },
        });
        await tx.execute(`UPDATE work.specs SET doc_ref = $3 WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.specKey,
          revision,
        ]);
        return { revision, parent, created: true, event };
      });
    },

    async getDocRevision(scope, specKey, revision) {
      let target = revision;
      if (!target) {
        const specRes = await sql.execute(`SELECT doc_ref FROM work.specs WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          specKey,
        ]);
        if (specRes.rowCount === 0) {
          throw new WorkError("not_found", `unknown spec ${specKey}`);
        }
        target = (specRes.rows[0]!.doc_ref as string | null) ?? undefined;
        if (!target) {
          throw new WorkError("not_found", `spec ${specKey} has no document`);
        }
      }
      const res = await sql.execute(
        `SELECT * FROM work.doc_revisions WHERE org_id = $1 AND spec_key = $2 AND revision = $3`,
        [scope.orgId, specKey, target],
      );
      if (res.rowCount === 0) {
        // An imported doc_ref points at a repo body the cloud never stored —
        // the caller renders "imported from repo @ digest" (design §6).
        throw new WorkError("not_found", `no cloud revision ${target} for spec ${specKey}`);
      }
      return mapDocRevision(res.rows[0]!);
    },

    async listDocHistory(scope, specKey) {
      const exists = await sql.execute(`SELECT 1 FROM work.specs WHERE org_id = $1 AND key = $2`, [
        scope.orgId,
        specKey,
      ]);
      if (exists.rowCount === 0) {
        throw new WorkError("not_found", `unknown spec ${specKey}`);
      }
      const res = await sql.execute(
        `SELECT org_id, revision, parent, spec_key, created_by, created_at
         FROM work.doc_revisions WHERE org_id = $1 AND spec_key = $2
         ORDER BY created_at, revision`,
        [scope.orgId, specKey],
      );
      return res.rows.map((r) => {
        const { body: _b, ...rest } = mapDocRevision({ ...r, body: "" });
        return rest;
      });
    },

    async ingestObservation(scope, input: IngestObservationInput): Promise<IngestOutcome> {
      return sql.transaction(async (tx) => insertWorkObservation(tx, scope.orgId, input));
    },

    async getWorkSet(scope): Promise<WorkSet> {
      const [tasks, events, observations] = await Promise.all([
        sql.execute(`SELECT * FROM work.tasks WHERE org_id = $1 ORDER BY key`, [scope.orgId]),
        sql.execute(`SELECT * FROM work.events WHERE org_id = $1 ORDER BY seq`, [scope.orgId]),
        sql.execute(`SELECT * FROM work.observations WHERE org_id = $1 ORDER BY seq`, [scope.orgId]),
      ]);
      return {
        tasks: tasks.rows.map((r) => mapTask(scope.orgId, r)),
        events: events.rows.map((r) => mapEvent(scope.orgId, r)),
        observations: observations.rows.map((r) => mapObservation(scope.orgId, r)),
      };
    },

    async listEvents(scope, fromSeq = 0) {
      const res = await sql.execute(
        `SELECT * FROM work.events WHERE org_id = $1 AND seq > $2 ORDER BY seq`,
        [scope.orgId, fromSeq],
      );
      return res.rows.map((r) => mapEvent(scope.orgId, r));
    },

    async listObservations(scope, fromSeq = 0) {
      const res = await sql.execute(
        `SELECT * FROM work.observations WHERE org_id = $1 AND seq > $2 ORDER BY seq`,
        [scope.orgId, fromSeq],
      );
      return res.rows.map((r) => mapObservation(scope.orgId, r));
    },

    /** Drops the intent-envelope cache rows and replays the coordination log
     *  through buildEnvelopes — invariant 1 made executable in production. */
    async rebuildCaches(scope) {
      return sql.transaction(async (tx) => {
        const events = await tx.execute(`SELECT * FROM work.events WHERE org_id = $1 ORDER BY seq`, [scope.orgId]);
        const { specs, tasks, initiatives } = buildEnvelopes(scope.orgId, events.rows.map((r) => mapEvent(scope.orgId, r)));
        await tx.execute(`DELETE FROM work.specs WHERE org_id = $1`, [scope.orgId]);
        await tx.execute(`DELETE FROM work.tasks WHERE org_id = $1`, [scope.orgId]);
        await tx.execute(`DELETE FROM work.initiatives WHERE org_id = $1`, [scope.orgId]);
        for (const i of initiatives) {
          await tx.execute(
            `INSERT INTO work.initiatives (org_id, key, title, description, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
            [scope.orgId, i.key, i.title, i.description ?? null, JSON.stringify(i.createdBy), i.createdAt],
          );
        }
        for (const s of specs) {
          await tx.execute(
            `INSERT INTO work.specs (org_id, key, title, doc_ref, labels, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
            [scope.orgId, s.key, s.title, s.docRef ?? null, JSON.stringify(s.labels ?? {}), JSON.stringify(s.createdBy), s.createdAt],
          );
        }
        for (const t of tasks) {
          await tx.execute(
            `INSERT INTO work.tasks (org_id, key, spec_key, title, contract, labels, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
            [scope.orgId, t.key, t.spec ?? null, t.title, t.contract ? JSON.stringify(t.contract) : null, JSON.stringify(t.labels ?? {}), JSON.stringify(t.createdBy), t.createdAt],
          );
        }
        return { specs: specs.length, tasks: tasks.length, initiatives: initiatives.length };
      });
    },
  };
}
