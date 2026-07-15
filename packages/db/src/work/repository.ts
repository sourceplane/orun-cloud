// Postgres WorkRepository over the 560_work_foundation_v2 schema.
//
// Discipline (mirrors MemoryWorkRepository, which mirrors the Go oracle):
// every mutator appends EXACTLY ONE coordination event and updates the
// intent-envelope cache rows in the SAME transaction; observations enter
// only through ingestObservation (dedupe-idempotent); no code path writes a
// lifecycle anywhere because no such column exists (WP-3).

import type { SqlExecutor, TransactionalSqlExecutor } from "../hyperdrive/executor.js";
import { canonicalDocBody, docDigest } from "./doc.js";
import { foldEpicIntent, sealEpicSnapshot } from "./hierarchy.js";
import { buildEnvelopes, type ItemCreatedPayload } from "./envelopes.js";
import {
  API_VERSION,
  PRIORITIES,
  fold,
  RELATION_KINDS,
  REVIEW_VERDICTS,
  WorkError,
  isMilestoneKey,
  validateActor,
  validateEvent,
  validateObservation,
  validateProposal,
  type Actor,
  type Contract,
  type CoordinationEvent,
  type Cycle,
  type Design,
  type DesignContext,
  type DocRevision,
  type EventKind,
  type Initiative,
  type Milestone,
  type Observation,
  type Priority,
  type Proposal,
  type Relation,
  type Spec,
  type Task,
  type WorkSet,
} from "./model.js";
import type {
  AdoptDesignInput,
  AdoptOutcome,
  ApproveInput,
  RegenerateOutcome,
  RegenerateTasksInput,
  SealedBrief,
  AssignInput,
  CancelInput,
  CommentInput,
  ReactionInput,
  CommitOutcome,
  CreateCycleInput,
  CreateDesignInput,
  CreateInitiativeInput,
  CreateSpecInput,
  CreateTaskInput,
  EditContractInput,
  EditItemInput,
  EditMilestoneInput,
  EstimateInput,
  IngestObservationInput,
  IngestOutcome,
  LabelInput,
  OrderInput,
  PinInput,
  PriorityInput,
  PutDocInput,
  PutDocOutcome,
  RelateInput,
  RequestReviewInput,
  RevokeApprovalInput,
  SaveViewInput,
  SetCycleInput,
  SetMilestoneInput,
  SubmitVerdictInput,
  SupersedeDesignInput,
  WorkRepository,
  WorkspaceScope,
  WorkView,
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
  const tags = parseJson<string[]>(row.tags, []);
  const relations = parseJson<Relation[]>(row.relations, []);
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
    tags: tags.length > 0 ? tags : undefined,
    priority: ((row.priority as string | null) ?? undefined) as Priority | undefined,
    estimate: row.estimate == null ? undefined : Number(row.estimate),
    relations: relations.length > 0 ? relations : undefined,
    cycleKey: (row.cycle_key as string | null) ?? undefined,
    milestone: (row.milestone_key as string | null) ?? undefined,
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
    initiative: (row.initiative_key as string | null) ?? undefined,
    targetDate: row.target_date == null ? undefined : toIso(row.target_date).slice(0, 10),
    labels: emptyToUndefined(parseJson<Record<string, string>>(row.labels, {})),
    createdBy: parseJson<Actor>(row.created_by, { type: "automation", id: "unknown" }),
    createdAt: toIso(row.created_at),
  };
}

function mapDesign(orgId: string, row: Record<string, unknown>): Design {
  const labels = parseJson<Record<string, string>>(row.labels, {});
  return {
    apiVersion: API_VERSION,
    kind: "Design",
    id: String(row.id),
    key: String(row.key),
    workspace: orgId,
    initiative: String(row.initiative),
    title: String(row.title),
    docRef: (row.doc_ref as string | null) ?? undefined,
    context: parseJson<DesignContext>(row.context, { coordSeq: 0, obsSeq: 0 }),
    proposal: parseJson<Proposal | null>(row.proposal, null) ?? undefined,
    labels: emptyToUndefined(labels),
    createdBy: parseJson<Actor>(row.created_by, { type: "automation", id: "unknown" }),
    createdAt: toIso(row.created_at),
  };
}

function mapMilestone(row: Record<string, unknown>): Milestone {
  const doneWhen = parseJson<string[]>(row.done_when, []);
  return {
    key: String(row.key),
    title: String(row.title),
    goal: (row.goal as string | null) ?? undefined,
    doneWhen: doneWhen.length > 0 ? doneWhen : undefined,
    targetDate: row.target_date == null ? undefined : toIso(row.target_date).slice(0, 10),
    ordinal: Number(row.ordinal),
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
     UNION ALL
     SELECT 1 FROM work.designs WHERE org_id = $1 AND key = $2
     LIMIT 1`,
    [orgId, key],
  );
  return res.rowCount > 0;
}

/** The live milestone ladder from the fold cache (ladder order). */
async function ladderOf(tx: SqlExecutor, orgId: string, epicKey: string): Promise<Milestone[]> {
  const res = await tx.execute(
    `SELECT * FROM work.milestones
     WHERE org_id = $1 AND spec_key = $2 AND removed = false
     ORDER BY ordinal, key`,
    [orgId, epicKey],
  );
  return res.rows.map(mapMilestone);
}

async function mustBeEpic(tx: SqlExecutor, orgId: string, key: string): Promise<Record<string, unknown>> {
  const res = await tx.execute(`SELECT * FROM work.specs WHERE org_id = $1 AND key = $2`, [orgId, key]);
  if (res.rowCount === 0) {
    throw new WorkError("not_found", `unknown epic ${key}`);
  }
  return res.rows[0]!;
}

async function mustBeReviewable(tx: SqlExecutor, orgId: string, key: string): Promise<"epic" | "design"> {
  const spec = await tx.execute(`SELECT 1 FROM work.specs WHERE org_id = $1 AND key = $2`, [orgId, key]);
  if (spec.rowCount > 0) return "epic";
  const design = await tx.execute(`SELECT 1 FROM work.designs WHERE org_id = $1 AND key = $2`, [orgId, key]);
  if (design.rowCount > 0) return "design";
  throw new WorkError("not_found", `unknown epic or design ${key}`);
}

function mapInitiative(orgId: string, row: Record<string, unknown>): Initiative {
  const successCriteria = parseJson<string[]>(row.success_criteria, []);
  return {
    apiVersion: API_VERSION,
    kind: "Initiative",
    id: String(row.id),
    key: String(row.key),
    workspace: orgId,
    title: String(row.title),
    description: (row.description as string | null) ?? undefined,
    owner: (row.owner as string | null) ?? undefined,
    targetDate: row.target_date == null ? undefined : toIso(row.target_date).slice(0, 10),
    successCriteria: successCriteria.length > 0 ? successCriteria : undefined,
    createdBy: parseJson<Actor>(row.created_by, { type: "automation", id: "unknown" }),
    createdAt: toIso(row.created_at),
  };
}

function mapCycle(row: Record<string, unknown>): Cycle {
  return {
    key: String(row.key),
    name: String(row.name),
    startsAt: toIso(row.starts_at).slice(0, 10),
    endsAt: toIso(row.ends_at).slice(0, 10),
    createdBy: parseJson<Actor>(row.created_by, { type: "automation", id: "unknown" }),
    createdAt: toIso(row.created_at),
  };
}

function mapView(row: Record<string, unknown>): WorkView {
  return {
    key: String(row.key),
    name: String(row.name),
    config: parseJson<Record<string, unknown>>(row.config, {}),
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
): WorkRepository & {
  rebuildCaches(scope: WorkspaceScope): Promise<{ specs: number; tasks: number; initiatives: number; designs: number }>;
} {
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

  // Locks the task row for a PM2 board-intent mutation and returns its
  // current folded state; 404s when the key is not a task.
  const mustBeTask = async (
    tx: SqlExecutor,
    orgId: string,
    key: string,
  ): Promise<{ tags: string[]; relations: Relation[] }> => {
    const res = await tx.execute(
      `SELECT tags, relations FROM work.tasks WHERE org_id = $1 AND key = $2 FOR UPDATE`,
      [orgId, key],
    );
    if (res.rowCount === 0) {
      throw new WorkError("not_found", `unknown task ${key}`);
    }
    return {
      tags: parseJson<string[]>(res.rows[0]!.tags, []),
      relations: parseJson<Relation[]>(res.rows[0]!.relations, []),
    };
  };

  const labelMutation = async (
    scope: WorkspaceScope,
    kind: "labeled" | "unlabeled",
    input: LabelInput,
  ): Promise<CommitOutcome> => {
    validateActor(input.actor);
    const label = input.label?.trim();
    if (!label) {
      throw new WorkError("invalid", "a label needs a non-empty name");
    }
    return sql.transaction(async (tx) => {
      const { tags } = await mustBeTask(tx, scope.orgId, input.key);
      const event = await appendEvent(tx, scope.orgId, {
        subject: input.key,
        kind,
        actor: input.actor,
        at: input.at ?? now(),
        payload: { label },
      });
      const next = new Set(tags);
      if (kind === "labeled") next.add(label);
      else next.delete(label);
      await tx.execute(`UPDATE work.tasks SET tags = $3::jsonb WHERE org_id = $1 AND key = $2`, [
        scope.orgId,
        input.key,
        JSON.stringify([...next].sort()),
      ]);
      return { event, key: input.key };
    });
  };

  const relateMutation = async (
    scope: WorkspaceScope,
    kind: "related" | "unrelated",
    input: RelateInput,
  ): Promise<CommitOutcome> => {
    validateActor(input.actor);
    if (!RELATION_KINDS.includes(input.rel)) {
      throw new WorkError("invalid", `rel must be one of ${RELATION_KINDS.join("|")}`);
    }
    if (input.target === input.key) {
      throw new WorkError("invalid", `an item cannot relate to itself (${input.key})`);
    }
    return sql.transaction(async (tx) => {
      // Relations may join any two items (task↔task, initiative→spec, …);
      // only a TASK subject folds them into its cache row.
      if (!(await keyExists(tx, scope.orgId, input.key))) {
        throw new WorkError("not_found", `unknown item ${input.key}`);
      }
      if (!(await keyExists(tx, scope.orgId, input.target))) {
        throw new WorkError("not_found", `unknown item ${input.target}`);
      }
      const event = await appendEvent(tx, scope.orgId, {
        subject: input.key,
        kind,
        actor: input.actor,
        at: input.at ?? now(),
        payload: { rel: input.rel, target: input.target },
      });
      const taskRes = await tx.execute(
        `SELECT relations FROM work.tasks WHERE org_id = $1 AND key = $2 FOR UPDATE`,
        [scope.orgId, input.key],
      );
      if (taskRes.rowCount > 0) {
        const current = parseJson<Relation[]>(taskRes.rows[0]!.relations, []);
        const next = current.filter((r) => !(r.rel === input.rel && r.target === input.target));
        if (kind === "related") next.push({ rel: input.rel, target: input.target });
        await tx.execute(`UPDATE work.tasks SET relations = $3::jsonb WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.key,
          JSON.stringify(next),
        ]);
      }
      return { event, key: input.key };
    });
  };

  const reactionMutation = async (
    scope: WorkspaceScope,
    kind: "reaction_added" | "reaction_removed",
    input: ReactionInput,
  ): Promise<CommitOutcome> => {
    validateActor(input.actor);
    if (!input.emoji) {
      throw new WorkError("invalid", "a reaction needs an emoji");
    }
    return sql.transaction(async (tx) => {
      const res = await tx.execute(
        `SELECT subject, kind FROM work.events WHERE org_id = $1 AND event_id = $2`,
        [scope.orgId, input.targetEvent],
      );
      if (res.rowCount === 0 || String(res.rows[0]!.kind) !== "comment_added") {
        throw new WorkError("not_found", `unknown comment ${input.targetEvent}`);
      }
      const subject = String(res.rows[0]!.subject);
      const event = await appendEvent(tx, scope.orgId, {
        subject,
        kind,
        actor: input.actor,
        at: input.at ?? now(),
        payload: { targetEvent: input.targetEvent, emoji: input.emoji },
      });
      return { event, key: subject };
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
        if (input.initiative) {
          const target = await tx.execute(`SELECT 1 FROM work.initiatives WHERE org_id = $1 AND key = $2`, [
            scope.orgId,
            input.initiative,
          ]);
          if (target.rowCount === 0) {
            throw new WorkError("not_found", `unknown initiative ${input.initiative}`);
          }
        }
        const at = input.at ?? now();
        const payload: ItemCreatedPayload = {
          kind: "Spec",
          key: input.slug,
          title: input.title,
          docRef: input.docRef,
          initiative: input.initiative,
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
          `INSERT INTO work.specs (org_id, key, title, doc_ref, initiative_key, labels, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
           RETURNING *`,
          [scope.orgId, input.slug, input.title, input.docRef ?? null, input.initiative ?? null, JSON.stringify(input.labels ?? {}), JSON.stringify(input.actor), at],
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
          owner: input.owner,
          targetDate: input.targetDate,
          successCriteria: input.successCriteria,
        };
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.slug,
          kind: "item_created",
          actor: input.actor,
          at,
          payload: payload as unknown as Record<string, unknown>,
        });
        const res = await tx.execute(
          `INSERT INTO work.initiatives (org_id, key, title, description, owner, target_date, success_criteria, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
           RETURNING *`,
          [
            scope.orgId,
            input.slug,
            input.title,
            input.description ?? null,
            input.owner ?? null,
            input.targetDate ?? null,
            input.successCriteria ? JSON.stringify(input.successCriteria) : null,
            JSON.stringify(input.actor),
            at,
          ],
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
        if (input.milestone) {
          if (!input.specKey) {
            throw new WorkError("invalid", "a milestone lives inside exactly one epic — the task needs a spec (design §1.2)");
          }
          const ladder = await ladderOf(tx, scope.orgId, input.specKey);
          if (!ladder.some((m) => m.key === input.milestone)) {
            throw new WorkError("not_found", `milestone ${input.milestone} is not in ${input.specKey}'s ladder`);
          }
        }
        const n = await nextSeq(tx, scope.orgId, input.prefix);
        const key = `${input.prefix}-${n}`;
        const at = input.at ?? now();
        const payload: ItemCreatedPayload = {
          kind: "Task",
          key,
          title: input.title,
          specKey: input.specKey,
          milestone: input.milestone,
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
          `INSERT INTO work.tasks (org_id, key, spec_key, milestone_key, title, contract, labels, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)
           RETURNING *`,
          [
            scope.orgId,
            key,
            input.specKey ?? null,
            input.milestone ?? null,
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
        if (input.initiative !== undefined && input.initiative !== null) {
          const target = await tx.execute(`SELECT 1 FROM work.initiatives WHERE org_id = $1 AND key = $2`, [
            scope.orgId,
            input.initiative,
          ]);
          if (target.rowCount === 0) {
            throw new WorkError("not_found", `unknown initiative ${input.initiative}`);
          }
        }
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "item_edited",
          actor: input.actor,
          at: input.at ?? now(),
          payload: {
            title: input.title,
            description: input.description,
            labels: input.labels,
            docRef: input.docRef,
            initiative: input.initiative,
            targetDate: input.targetDate,
            owner: input.owner,
            successCriteria: input.successCriteria,
          },
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
             doc_ref = COALESCE($5, doc_ref),
             initiative_key = CASE WHEN $6 THEN $7 ELSE initiative_key END,
             target_date = CASE WHEN $8 THEN $9::date ELSE target_date END
           WHERE org_id = $1 AND key = $2`,
          [
            scope.orgId,
            input.key,
            input.title ?? null,
            input.labels ? JSON.stringify(input.labels) : null,
            input.docRef ?? null,
            input.initiative !== undefined,
            input.initiative ?? null,
            input.targetDate !== undefined,
            input.targetDate ?? null,
          ],
        );
        await tx.execute(
          `UPDATE work.initiatives SET
             title = COALESCE($3, title),
             description = COALESCE($4, description),
             owner = CASE WHEN $5 THEN $6 ELSE owner END,
             target_date = CASE WHEN $7 THEN $8::date ELSE target_date END,
             success_criteria = COALESCE($9::jsonb, success_criteria)
           WHERE org_id = $1 AND key = $2`,
          [
            scope.orgId,
            input.key,
            input.title ?? null,
            input.description ?? null,
            input.owner !== undefined,
            input.owner ?? null,
            input.targetDate !== undefined,
            input.targetDate ?? null,
            input.successCriteria ? JSON.stringify(input.successCriteria) : null,
          ],
        );
        return { event, key: input.key };
      });
    },

    // ── v4 hierarchy mutators (WH1) — one event each; adopt is the one
    //    documented transactional batch (design §2) ─────────────────────────

    async editMilestone(scope, input: EditMilestoneInput) {
      validateActor(input.actor);
      if (!isMilestoneKey(input.key)) {
        throw new WorkError("invalid", `milestone key ${input.key} must match the ladder convention (WH2, M1)`);
      }
      return sql.transaction(async (tx) => {
        await mustBeEpic(tx, scope.orgId, input.epicKey);
        const existingRes = await tx.execute(
          `SELECT removed FROM work.milestones WHERE org_id = $1 AND spec_key = $2 AND key = $3 FOR UPDATE`,
          [scope.orgId, input.epicKey, input.key],
        );
        const live = existingRes.rowCount > 0 && existingRes.rows[0]!.removed === false;
        switch (input.op) {
          case "create": {
            if (live) throw new WorkError("conflict", `milestone ${input.key} already exists — keys are immutable`);
            if (!input.title?.trim()) throw new WorkError("invalid", "a milestone needs a title");
            break;
          }
          case "edit":
          case "reorder": {
            if (!live) throw new WorkError("not_found", `milestone ${input.key} is not in ${input.epicKey}'s ladder`);
            break;
          }
          case "remove": {
            if (!live) throw new WorkError("not_found", `milestone ${input.key} is not in ${input.epicKey}'s ladder`);
            const open = await tx.execute(
              `SELECT count(*)::int AS n FROM work.tasks t
               WHERE t.org_id = $1 AND t.spec_key = $2 AND t.milestone_key = $3
                 AND NOT EXISTS (
                   SELECT 1 FROM work.events e
                   WHERE e.org_id = $1 AND e.subject = t.key AND e.kind = 'canceled')`,
              [scope.orgId, input.epicKey, input.key],
            );
            const n = Number(open.rows[0]?.n ?? 0);
            if (n > 0) {
              throw new WorkError("conflict", `milestone ${input.key} has ${n} open task(s) — move or cancel them first`);
            }
            break;
          }
          default:
            throw new WorkError("invalid", `unknown milestone op ${String(input.op)}`);
        }
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.epicKey,
          kind: "milestone_edited",
          actor: input.actor,
          at: input.at ?? now(),
          payload: {
            op: input.op,
            key: input.key,
            title: input.title,
            goal: input.goal,
            doneWhen: input.doneWhen,
            targetDate: input.targetDate,
            ordinal: input.ordinal,
          },
        });
        // The fold-cache row, in the same transaction (droppable — rebuilt
        // from milestone_edited events alone; invariant 1).
        if (input.op === "create") {
          const ord =
            input.ordinal ??
            Number(
              (
                await tx.execute(
                  `SELECT COALESCE(MAX(ordinal) + 1, 0)::int AS ord FROM work.milestones WHERE org_id = $1 AND spec_key = $2`,
                  [scope.orgId, input.epicKey],
                )
              ).rows[0]?.ord ?? 0,
            );
          await tx.execute(
            `INSERT INTO work.milestones (org_id, spec_key, key, ordinal, title, goal, done_when, target_date, removed)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, false)
             ON CONFLICT (org_id, spec_key, key) DO UPDATE SET
               ordinal = EXCLUDED.ordinal, title = EXCLUDED.title, goal = EXCLUDED.goal,
               done_when = EXCLUDED.done_when, target_date = EXCLUDED.target_date, removed = false`,
            [
              scope.orgId,
              input.epicKey,
              input.key,
              ord,
              input.title!.trim(),
              input.goal ?? null,
              input.doneWhen ? JSON.stringify(input.doneWhen) : null,
              input.targetDate ?? null,
            ],
          );
        } else if (input.op === "remove") {
          await tx.execute(
            `UPDATE work.milestones SET removed = true WHERE org_id = $1 AND spec_key = $2 AND key = $3`,
            [scope.orgId, input.epicKey, input.key],
          );
        } else {
          await tx.execute(
            `UPDATE work.milestones SET
               title = COALESCE($4, title),
               goal = COALESCE($5, goal),
               done_when = COALESCE($6::jsonb, done_when),
               target_date = COALESCE($7::date, target_date),
               ordinal = COALESCE($8, ordinal)
             WHERE org_id = $1 AND spec_key = $2 AND key = $3`,
            [
              scope.orgId,
              input.epicKey,
              input.key,
              input.title ?? null,
              input.goal ?? null,
              input.doneWhen ? JSON.stringify(input.doneWhen) : null,
              input.targetDate ?? null,
              input.ordinal ?? null,
            ],
          );
        }
        return { event, key: input.epicKey };
      });
    },

    async setMilestone(scope, input: SetMilestoneInput) {
      validateActor(input.actor);
      return sql.transaction(async (tx) => {
        const taskRes = await tx.execute(
          `SELECT spec_key FROM work.tasks WHERE org_id = $1 AND key = $2 FOR UPDATE`,
          [scope.orgId, input.key],
        );
        if (taskRes.rowCount === 0) {
          throw new WorkError("not_found", `unknown task ${input.key}`);
        }
        const specKey = (taskRes.rows[0]!.spec_key as string | null) ?? undefined;
        if (input.milestone !== null) {
          if (!specKey) {
            throw new WorkError("invalid", "a milestone lives inside exactly one epic — the task needs a spec (design §1.2)");
          }
          const ladder = await ladderOf(tx, scope.orgId, specKey);
          if (!ladder.some((m) => m.key === input.milestone)) {
            throw new WorkError("not_found", `milestone ${input.milestone} is not in ${specKey}'s ladder`);
          }
        }
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "milestone_set",
          actor: input.actor,
          at: input.at ?? now(),
          payload: { milestone: input.milestone },
        });
        await tx.execute(`UPDATE work.tasks SET milestone_key = $3 WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.key,
          input.milestone,
        ]);
        return { event, key: input.key };
      });
    },

    async listMilestones(scope, epicKey) {
      const exists = await sql.execute(`SELECT 1 FROM work.specs WHERE org_id = $1 AND key = $2`, [
        scope.orgId,
        epicKey,
      ]);
      if (exists.rowCount === 0) {
        throw new WorkError("not_found", `unknown epic ${epicKey}`);
      }
      return ladderOf(sql, scope.orgId, epicKey);
    },

    async requestReview(scope, input: RequestReviewInput) {
      validateActor(input.actor);
      return sql.transaction(async (tx) => {
        await mustBeReviewable(tx, scope.orgId, input.key);
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "review_requested",
          actor: input.actor,
          at: input.at ?? now(),
          payload: { revision: input.revision, reviewers: input.reviewers, note: input.note },
        });
        return { event, key: input.key };
      });
    },

    async submitVerdict(scope, input: SubmitVerdictInput) {
      validateActor(input.actor);
      if (!REVIEW_VERDICTS.includes(input.verdict)) {
        throw new WorkError("invalid", `verdict must be one of ${REVIEW_VERDICTS.join("|")}`);
      }
      return sql.transaction(async (tx) => {
        await mustBeReviewable(tx, scope.orgId, input.key);
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "review_submitted",
          actor: input.actor,
          at: input.at ?? now(),
          payload: { revision: input.revision, verdict: input.verdict, note: input.note },
        });
        return { event, key: input.key };
      });
    },

    async approve(scope, input: ApproveInput) {
      validateActor(input.actor);
      return sql.transaction(async (tx) => {
        const epicRow = await mustBeEpic(tx, scope.orgId, input.key);
        const ladder = await ladderOf(tx, scope.orgId, input.key);
        if (ladder.length === 0) {
          throw new WorkError(
            "invalid",
            `epic ${input.key} has no milestones — approval covers the doc AND the ladder (V4-2)`,
          );
        }
        const current = (epicRow.doc_ref as string | null) ?? "";
        const revision = input.revision ?? current;
        if (revision !== current) {
          throw new WorkError(
            "conflict",
            `approval of stale revision ${revision || "(none)"} — the epic's document is now ${current || "(none)"}; re-read and re-approve`,
          );
        }
        const min = input.minApprovals ?? 1;
        if (min > 1) {
          const verdicts = await tx.execute(
            `SELECT actor, payload FROM work.events
             WHERE org_id = $1 AND subject = $2 AND kind = 'review_submitted'
             ORDER BY seq`,
            [scope.orgId, input.key],
          );
          const approvers = new Set<string>([input.actor.id]);
          for (const row of verdicts.rows) {
            const actor = parseJson<Actor>(row.actor, { type: "automation", id: "unknown" });
            const p = parseJson<{ verdict?: string; revision?: string }>(row.payload, {});
            if (p.verdict === "approve" && actor.type === "user" && (p.revision ?? current) === current) {
              approvers.add(actor.id);
            }
          }
          if (approvers.size < min) {
            throw new WorkError(
              "invalid",
              `approval needs ${min} distinct human approvals at this revision; have ${approvers.size}`,
            );
          }
        }
        // Seal the frozen brief IN THIS TRANSACTION (design §3): envelope +
        // ladder + ladderHash + informative task envelopes + log cursors.
        // The approval covers doc + ladder; tasks are context (V4-5).
        const at = input.at ?? now();
        const tasksRes = await tx.execute(`SELECT * FROM work.tasks WHERE org_id = $1 AND spec_key = $2 ORDER BY key`, [
          scope.orgId,
          input.key,
        ]);
        const cursors = await tx.execute(
          `SELECT
             COALESCE((SELECT MAX(seq) FROM work.events WHERE org_id = $1), 0)::bigint AS coord,
             COALESCE((SELECT MAX(seq) FROM work.observations WHERE org_id = $1), 0)::bigint AS obs`,
          [scope.orgId],
        );
        const sealed = await sealEpicSnapshot({
          spec: mapSpec(scope.orgId, epicRow),
          milestones: ladder,
          tasks: tasksRes.rows.map((r) => mapTask(scope.orgId, r)),
          approval: { revision: revision || undefined, by: input.actor, at },
          catalog: input.catalog,
          // +1: the approved event this transaction appends is part of the
          // sealed state's position.
          coordSeq: Number(cursors.rows[0]?.coord ?? 0) + 1,
          obsSeq: Number(cursors.rows[0]?.obs ?? 0),
        });
        await tx.execute(
          `INSERT INTO work.snapshots (org_id, id, kind, subject, body, created_at)
           VALUES ($1, $2, 'EpicSnapshot', $3, $4, $5)
           ON CONFLICT (org_id, id) DO NOTHING`,
          [scope.orgId, sealed.id, input.key, sealed.canonical, at],
        );
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "approved",
          actor: input.actor,
          at,
          payload: { revision: revision || undefined, snapshot: sealed.id },
        });
        return { event, key: input.key, snapshot: sealed.id };
      });
    },

    async getEpicBrief(scope, epicKey, id): Promise<SealedBrief> {
      const res = id
        ? await sql.execute(`SELECT * FROM work.snapshots WHERE org_id = $1 AND id = $2 AND subject = $3`, [
            scope.orgId,
            id,
            epicKey,
          ])
        : await sql.execute(
            `SELECT * FROM work.snapshots WHERE org_id = $1 AND subject = $2 ORDER BY created_at DESC, id LIMIT 1`,
            [scope.orgId, epicKey],
          );
      if (res.rowCount === 0) {
        throw new WorkError("not_found", `no sealed brief for ${epicKey} — approval seals one (design §3)`);
      }
      const row = res.rows[0]!;
      return {
        id: String(row.id),
        subject: String(row.subject),
        canonical: String(row.body),
        createdAt: toIso(row.created_at),
      };
    },

    async revokeApproval(scope, input: RevokeApprovalInput) {
      validateActor(input.actor);
      return sql.transaction(async (tx) => {
        await mustBeEpic(tx, scope.orgId, input.key);
        const res = await tx.execute(
          `SELECT kind FROM work.events
           WHERE org_id = $1 AND subject = $2 AND kind IN ('approved', 'approval_revoked')
           ORDER BY seq DESC LIMIT 1`,
          [scope.orgId, input.key],
        );
        if (res.rowCount === 0 || String(res.rows[0]!.kind) !== "approved") {
          throw new WorkError("invalid", `epic ${input.key} has no active approval to revoke`);
        }
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "approval_revoked",
          actor: input.actor,
          at: input.at ?? now(),
          payload: { note: input.note },
        });
        return { event, key: input.key };
      });
    },

    async createDesign(scope, input: CreateDesignInput) {
      validateActor(input.actor);
      if (!input.title?.trim()) {
        throw new WorkError("invalid", "a design needs a title");
      }
      validateProposal(input.proposal);
      return sql.transaction(async (tx) => {
        const initiative = await tx.execute(`SELECT 1 FROM work.initiatives WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.initiativeKey,
        ]);
        if (initiative.rowCount === 0) {
          throw new WorkError("not_found", `unknown initiative ${input.initiativeKey}`);
        }
        const cursors = await tx.execute(
          `SELECT
             COALESCE((SELECT MAX(seq) FROM work.events WHERE org_id = $1), 0)::bigint AS coord,
             COALESCE((SELECT MAX(seq) FROM work.observations WHERE org_id = $1), 0)::bigint AS obs`,
          [scope.orgId],
        );
        const context: DesignContext = {
          catalog: input.context?.catalog,
          coordSeq: Number(cursors.rows[0]?.coord ?? 0),
          obsSeq: Number(cursors.rows[0]?.obs ?? 0),
        };
        const n = await nextSeq(tx, scope.orgId, "DSG");
        const key = `DSG-${n}`;
        const at = input.at ?? now();
        const payload: ItemCreatedPayload = {
          kind: "Design",
          key,
          title: input.title.trim(),
          initiative: input.initiativeKey,
          docRef: input.docRef,
          labels: input.labels,
          context,
          proposal: input.proposal,
        };
        const event = await appendEvent(tx, scope.orgId, {
          subject: key,
          kind: "item_created",
          actor: input.actor,
          at,
          payload: payload as unknown as Record<string, unknown>,
        });
        const res = await tx.execute(
          `INSERT INTO work.designs (org_id, key, initiative, title, doc_ref, context, proposal, labels, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)
           RETURNING *`,
          [
            scope.orgId,
            key,
            input.initiativeKey,
            input.title.trim(),
            input.docRef ?? null,
            JSON.stringify(context),
            input.proposal ? JSON.stringify(input.proposal) : null,
            JSON.stringify(input.labels ?? {}),
            JSON.stringify(input.actor),
            at,
          ],
        );
        return { event, key, design: mapDesign(scope.orgId, res.rows[0]!) };
      });
    },

    async getDesign(scope, key) {
      const res = await sql.execute(`SELECT * FROM work.designs WHERE org_id = $1 AND key = $2`, [
        scope.orgId,
        key,
      ]);
      if (res.rowCount === 0) {
        throw new WorkError("not_found", `unknown design ${key}`);
      }
      return mapDesign(scope.orgId, res.rows[0]!);
    },

    async listDesigns(scope, initiativeKey) {
      const res = initiativeKey
        ? await sql.execute(
            `SELECT * FROM work.designs WHERE org_id = $1 AND initiative = $2 ORDER BY created_at, key`,
            [scope.orgId, initiativeKey],
          )
        : await sql.execute(`SELECT * FROM work.designs WHERE org_id = $1 ORDER BY created_at, key`, [scope.orgId]);
      return res.rows.map((r) => mapDesign(scope.orgId, r));
    },

    async adoptDesign(scope, input: AdoptDesignInput): Promise<AdoptOutcome> {
      validateActor(input.actor);
      return sql.transaction(async (tx) => {
        const designRes = await tx.execute(`SELECT * FROM work.designs WHERE org_id = $1 AND key = $2 FOR UPDATE`, [
          scope.orgId,
          input.key,
        ]);
        if (designRes.rowCount === 0) {
          throw new WorkError("not_found", `unknown design ${input.key}`);
        }
        const design = mapDesign(scope.orgId, designRes.rows[0]!);
        const proposal = design.proposal;
        if (!proposal || proposal.epics.length === 0) {
          throw new WorkError("invalid", `design ${input.key} has no proposal to adopt`);
        }
        const chosen = input.epics ? proposal.epics.filter((pe) => input.epics!.includes(pe.slug)) : proposal.epics;
        if (chosen.length === 0) {
          throw new WorkError("invalid", "adoption selected no proposal epics");
        }
        for (const pe of chosen) {
          if (await keyExists(tx, scope.orgId, pe.slug)) {
            throw new WorkError("conflict", `proposal epic ${pe.slug} collides with an existing item`);
          }
        }
        const at = input.at ?? now();
        const actor: Actor = { ...input.actor, via: "adoption" };
        // The decision first — human-only, enforced by validateEvent (V4-2) —
        // then the mint batch in the same transaction (design §2).
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "design_adopted",
          actor,
          at,
          payload: { revision: design.docRef, minted: chosen.map((pe) => pe.slug) },
        });
        const minted: string[] = [];
        const taskKeys: string[] = [];
        const prefix = input.taskPrefix ?? "WK";
        for (const pe of chosen) {
          const specPayload: ItemCreatedPayload = {
            kind: "Spec",
            key: pe.slug,
            title: pe.title,
            docRef: pe.docSeed,
            initiative: design.initiative,
          };
          await appendEvent(tx, scope.orgId, {
            subject: pe.slug,
            kind: "item_created",
            actor,
            at,
            payload: specPayload as unknown as Record<string, unknown>,
          });
          await tx.execute(
            `INSERT INTO work.specs (org_id, key, title, doc_ref, initiative_key, labels, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6::jsonb, $7)`,
            [scope.orgId, pe.slug, pe.title, pe.docSeed ?? null, design.initiative, JSON.stringify(actor), at],
          );
          minted.push(pe.slug);
          for (const [i, m] of (pe.milestones ?? []).entries()) {
            const ord = m.ordinal ?? i;
            await appendEvent(tx, scope.orgId, {
              subject: pe.slug,
              kind: "milestone_edited",
              actor,
              at,
              payload: {
                op: "create",
                key: m.key,
                title: m.title,
                goal: m.goal,
                doneWhen: m.doneWhen,
                targetDate: m.targetDate,
                ordinal: ord,
              },
            });
            await tx.execute(
              `INSERT INTO work.milestones (org_id, spec_key, key, ordinal, title, goal, done_when, target_date, removed)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, false)`,
              [
                scope.orgId,
                pe.slug,
                m.key,
                ord,
                m.title,
                m.goal ?? null,
                m.doneWhen ? JSON.stringify(m.doneWhen) : null,
                m.targetDate ?? null,
              ],
            );
          }
          for (const ts of pe.taskSkeletons ?? []) {
            const tn = await nextSeq(tx, scope.orgId, prefix);
            const taskKey = `${prefix}-${tn}`;
            const taskPayload: ItemCreatedPayload = {
              kind: "Task",
              key: taskKey,
              title: ts.title,
              specKey: pe.slug,
              milestone: ts.milestone,
              contract: ts.contract,
            };
            await appendEvent(tx, scope.orgId, {
              subject: taskKey,
              kind: "item_created",
              actor,
              at,
              payload: taskPayload as unknown as Record<string, unknown>,
            });
            await tx.execute(
              `INSERT INTO work.tasks (org_id, key, spec_key, milestone_key, title, contract, labels, created_by, created_at)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, $7::jsonb, $8)`,
              [
                scope.orgId,
                taskKey,
                pe.slug,
                ts.milestone ?? null,
                ts.title,
                ts.contract ? JSON.stringify(ts.contract) : null,
                JSON.stringify(actor),
                at,
              ],
            );
            taskKeys.push(taskKey);
          }
        }
        return { event, minted, tasks: taskKeys };
      });
    },

    async regenerateTasks(scope, input: RegenerateTasksInput): Promise<RegenerateOutcome> {
      validateActor(input.actor);
      for (const t of input.tasks) {
        if (!t.title?.trim()) throw new WorkError("invalid", "every regenerated task needs a title");
      }
      return sql.transaction(async (tx) => {
        const ladder = await ladderOf(tx, scope.orgId, input.epicKey);
        if (!ladder.some((m) => m.key === input.milestone)) {
          throw new WorkError("not_found", `milestone ${input.milestone} is not in ${input.epicKey}'s ladder`);
        }
        const at = input.at ?? now();

        // Planned vs in-flight (Q-6): a task claimed by any observation
        // (branch/PR) survives re-planning; only draft/ready plans cancel.
        // The claim join needs the full fold — run it over the workspace.
        const [tasksRes, eventsRes, obsRes] = await Promise.all([
          tx.execute(`SELECT * FROM work.tasks WHERE org_id = $1 ORDER BY key`, [scope.orgId]),
          tx.execute(`SELECT * FROM work.events WHERE org_id = $1 ORDER BY seq`, [scope.orgId]),
          tx.execute(`SELECT * FROM work.observations WHERE org_id = $1 ORDER BY seq`, [scope.orgId]),
        ]);
        const ws = {
          tasks: tasksRes.rows.map((r) => mapTask(scope.orgId, r)),
          events: eventsRes.rows.map((r) => mapEvent(scope.orgId, r)),
          observations: obsRes.rows.map((r) => mapObservation(scope.orgId, r)),
        };
        const fr = fold(ws);

        const canceled: string[] = [];
        const kept: string[] = [];
        for (const t of ws.tasks) {
          if (t.spec !== input.epicKey || t.milestone !== input.milestone) continue;
          const rung = fr.lifecycles[t.key]?.rung ?? "draft";
          if (rung === "canceled") continue;
          if (rung === "draft" || rung === "ready") {
            await appendEvent(tx, scope.orgId, { subject: t.key, kind: "canceled", actor: input.actor, at, payload: {} });
            canceled.push(t.key);
          } else {
            kept.push(t.key);
          }
        }

        const created: string[] = [];
        const prefix = input.prefix ?? "WK";
        for (const t of input.tasks) {
          const n = await nextSeq(tx, scope.orgId, prefix);
          const key = `${prefix}-${n}`;
          const payload: ItemCreatedPayload = {
            kind: "Task",
            key,
            title: t.title.trim(),
            specKey: input.epicKey,
            milestone: input.milestone,
            contract: t.contract,
          };
          await appendEvent(tx, scope.orgId, {
            subject: key,
            kind: "item_created",
            actor: input.actor,
            at,
            payload: payload as unknown as Record<string, unknown>,
          });
          await tx.execute(
            `INSERT INTO work.tasks (org_id, key, spec_key, milestone_key, title, contract, labels, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, $7::jsonb, $8)`,
            [
              scope.orgId,
              key,
              input.epicKey,
              input.milestone,
              t.title.trim(),
              t.contract ? JSON.stringify(t.contract) : null,
              JSON.stringify(input.actor),
              at,
            ],
          );
          if (t.contract && input.actor.type !== "user") {
            // Applied AND flagged — the triage review lane's discipline.
            await appendEvent(tx, scope.orgId, {
              subject: key,
              kind: "contract_edited",
              actor: input.actor,
              at,
              payload: { contract: t.contract },
            });
          }
          created.push(key);
        }
        return { canceled, kept, created };
      });
    },

    async supersedeDesign(scope, input: SupersedeDesignInput) {
      validateActor(input.actor);
      return sql.transaction(async (tx) => {
        const design = await tx.execute(`SELECT 1 FROM work.designs WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.key,
        ]);
        if (design.rowCount === 0) {
          throw new WorkError("not_found", `unknown design ${input.key}`);
        }
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "superseded",
          actor: input.actor,
          at: input.at ?? now(),
          payload: { by: input.by, note: input.note },
        });
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
      // The dispatch precondition (v4 WH5, design §3): an agent seat (sp_)
      // cannot be assigned into an epic whose intent is not Approved. A
      // human may override WITH a note (attributed); agents and automation
      // can never override — server-side, not client trust.
      if (input.subject.startsWith("sp_")) {
        const taskRes = await sql.execute(`SELECT spec_key FROM work.tasks WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.key,
        ]);
        const specKey = (taskRes.rows[0]?.spec_key as string | null) ?? undefined;
        if (specKey) {
          const eventsRes = await sql.execute(
            `SELECT * FROM work.events WHERE org_id = $1 AND subject = $2 ORDER BY seq`,
            [scope.orgId, specKey],
          );
          const intent = await foldEpicIntent(specKey, eventsRes.rows.map((r) => mapEvent(scope.orgId, r)));
          if (intent.state !== "approved" && !(input.actor.type === "user" && input.override?.trim())) {
            throw new WorkError(
              "invalid",
              `dispatch blocked: epic ${specKey} is ${intent.state.replace("_", " ")} — agents implement approved briefs. ` +
                (input.actor.type === "user"
                  ? "Override with a note to dispatch anyway (attributed), or approve the epic first."
                  : "A human can approve the epic or override with a note; agents cannot (V4-2)."),
            );
          }
        }
      }
      return simpleMutation(scope, input.key, "assigned", input.actor, input.at, {
        subjectId: input.subject,
        ...(input.override ? { override: input.override } : {}),
      });
    },
    async unassign(scope, input: AssignInput) {
      return simpleMutation(scope, input.key, "unassigned", input.actor, input.at, { subjectId: input.subject });
    },
    async comment(scope, input: CommentInput) {
      return simpleMutation(scope, input.key, "comment_added", input.actor, input.at, {
        body: input.body,
        parentEvent: input.parentEvent,
        anchor: input.anchor,
        reviewsEvent: input.reviewsEvent,
      });
    },

    async addReaction(scope, input: ReactionInput) {
      return reactionMutation(scope, "reaction_added", input);
    },
    async removeReaction(scope, input: ReactionInput) {
      return reactionMutation(scope, "reaction_removed", input);
    },

    // ── PM2 board intent: one event + the folded cache column, same tx ──────

    async label(scope, input: LabelInput) {
      return labelMutation(scope, "labeled", input);
    },
    async unlabel(scope, input: LabelInput) {
      return labelMutation(scope, "unlabeled", input);
    },

    async prioritize(scope, input: PriorityInput) {
      validateActor(input.actor);
      if (!PRIORITIES.includes(input.priority)) {
        throw new WorkError("invalid", `priority must be one of ${PRIORITIES.join("|")}`);
      }
      return sql.transaction(async (tx) => {
        await mustBeTask(tx, scope.orgId, input.key);
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "prioritized",
          actor: input.actor,
          at: input.at ?? now(),
          payload: { priority: input.priority },
        });
        await tx.execute(`UPDATE work.tasks SET priority = $3 WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.key,
          input.priority === "none" ? null : input.priority,
        ]);
        return { event, key: input.key };
      });
    },

    async estimate(scope, input: EstimateInput) {
      validateActor(input.actor);
      if (input.points !== null && (typeof input.points !== "number" || !Number.isFinite(input.points) || input.points < 0)) {
        throw new WorkError("invalid", "estimate points must be a non-negative number (null clears)");
      }
      return sql.transaction(async (tx) => {
        await mustBeTask(tx, scope.orgId, input.key);
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "estimated",
          actor: input.actor,
          at: input.at ?? now(),
          payload: { points: input.points },
        });
        await tx.execute(`UPDATE work.tasks SET estimate = $3 WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.key,
          input.points,
        ]);
        return { event, key: input.key };
      });
    },

    async relate(scope, input: RelateInput) {
      return relateMutation(scope, "related", input);
    },
    async unrelate(scope, input: RelateInput) {
      return relateMutation(scope, "unrelated", input);
    },

    async setCycle(scope, input: SetCycleInput) {
      validateActor(input.actor);
      return sql.transaction(async (tx) => {
        await mustBeTask(tx, scope.orgId, input.key);
        if (input.cycle !== null) {
          const c = await tx.execute(`SELECT 1 FROM work.cycles WHERE org_id = $1 AND key = $2`, [
            scope.orgId,
            input.cycle,
          ]);
          if (c.rowCount === 0) {
            throw new WorkError("not_found", `unknown cycle ${input.cycle}`);
          }
        }
        const event = await appendEvent(tx, scope.orgId, {
          subject: input.key,
          kind: "cycle_set",
          actor: input.actor,
          at: input.at ?? now(),
          payload: { cycle: input.cycle },
        });
        await tx.execute(`UPDATE work.tasks SET cycle_key = $3 WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.key,
          input.cycle,
        ]);
        return { event, key: input.key };
      });
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
      // Cancel is the model's native "delete": a terminal, attributed,
      // append-only rung/intent — never a row removal. Initiatives are
      // envelope-only (no rung, no intent), so there is nothing to fold a
      // cancel onto; reject rather than log a silent no-op event.
      const isInitiative = await sql.transaction(async (tx) => {
        const res = await tx.execute(
          `SELECT 1 FROM work.initiatives WHERE org_id = $1 AND key = $2 LIMIT 1`,
          [scope.orgId, input.key],
        );
        return res.rowCount > 0;
      });
      if (isInitiative) {
        throw new WorkError(
          "invalid",
          "an initiative has no lifecycle to cancel — edit its envelope, or retire its epics",
        );
      }
      return simpleMutation(scope, input.key, "canceled", input.actor, input.at, {});
    },

    async putDocRevision(scope, input: PutDocInput): Promise<PutDocOutcome> {
      validateActor(input.actor);
      const body = canonicalDocBody(input.body);
      const revision = await docDigest(body);
      return sql.transaction(async (tx) => {
        // Designs carry doc chains exactly like epics (v4, V4-6: one digest
        // form, one canonicalizer, one fork-visible-LWW policy).
        let table: "specs" | "designs" = "specs";
        let docRes = await tx.execute(`SELECT doc_ref FROM work.specs WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          input.specKey,
        ]);
        if (docRes.rowCount === 0) {
          docRes = await tx.execute(`SELECT doc_ref FROM work.designs WHERE org_id = $1 AND key = $2`, [
            scope.orgId,
            input.specKey,
          ]);
          table = "designs";
        }
        if (docRes.rowCount === 0) {
          throw new WorkError("not_found", `unknown spec ${input.specKey}`);
        }
        const current = (docRes.rows[0]!.doc_ref as string | null) ?? undefined;
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
        await tx.execute(`UPDATE work.${table} SET doc_ref = $3 WHERE org_id = $1 AND key = $2`, [
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
        let docRes = await sql.execute(`SELECT doc_ref FROM work.specs WHERE org_id = $1 AND key = $2`, [
          scope.orgId,
          specKey,
        ]);
        if (docRes.rowCount === 0) {
          docRes = await sql.execute(`SELECT doc_ref FROM work.designs WHERE org_id = $1 AND key = $2`, [
            scope.orgId,
            specKey,
          ]);
        }
        if (docRes.rowCount === 0) {
          throw new WorkError("not_found", `unknown spec ${specKey}`);
        }
        target = (docRes.rows[0]!.doc_ref as string | null) ?? undefined;
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
        // Rest-destructure strips body from the listing shape.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { body: _b, ...rest } = mapDocRevision({ ...r, body: "" });
        return rest;
      });
    },

    // ── Saved views (v3 PM2): workspace UI config beside the logs ───────────

    async saveView(scope, input: SaveViewInput): Promise<WorkView> {
      validateActor(input.actor);
      if (!SLUG_RE.test(input.key)) {
        throw new WorkError("invalid", `view key ${input.key} must be lowercase kebab`);
      }
      if (!input.name?.trim()) {
        throw new WorkError("invalid", "a view needs a name");
      }
      const res = await sql.execute(
        `INSERT INTO work.views (org_id, key, name, config, created_by, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
         ON CONFLICT (org_id, key) DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config
         RETURNING *`,
        [scope.orgId, input.key, input.name.trim(), JSON.stringify(input.config), JSON.stringify(input.actor), input.at ?? now()],
      );
      return mapView(res.rows[0]!);
    },

    async listViews(scope): Promise<WorkView[]> {
      const res = await sql.execute(`SELECT * FROM work.views WHERE org_id = $1 ORDER BY key`, [scope.orgId]);
      return res.rows.map(mapView);
    },

    // ── Authored time-boxes (v3 PM3): intent rows; progress derives ─────────

    async createCycle(scope, input: CreateCycleInput): Promise<Cycle> {
      validateActor(input.actor);
      if (!input.name?.trim()) {
        throw new WorkError("invalid", "a cycle needs a name");
      }
      const starts = Date.parse(input.startsAt);
      const ends = Date.parse(input.endsAt);
      if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends < starts) {
        throw new WorkError("invalid", "a cycle needs startsAt <= endsAt (ISO dates)");
      }
      return sql.transaction(async (tx) => {
        const n = await nextSeq(tx, scope.orgId, "CYC");
        const res = await tx.execute(
          `INSERT INTO work.cycles (org_id, key, name, starts_at, ends_at, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           RETURNING *`,
          [
            scope.orgId,
            `CYC-${n}`,
            input.name.trim(),
            input.startsAt.slice(0, 10),
            input.endsAt.slice(0, 10),
            JSON.stringify(input.actor),
            input.at ?? now(),
          ],
        );
        return mapCycle(res.rows[0]!);
      });
    },

    async listCycles(scope): Promise<Cycle[]> {
      const res = await sql.execute(`SELECT * FROM work.cycles WHERE org_id = $1 ORDER BY starts_at, key`, [
        scope.orgId,
      ]);
      return res.rows.map(mapCycle);
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
        const { specs, tasks, initiatives, designs, milestones } = buildEnvelopes(
          scope.orgId,
          events.rows.map((r) => mapEvent(scope.orgId, r)),
        );
        await tx.execute(`DELETE FROM work.specs WHERE org_id = $1`, [scope.orgId]);
        await tx.execute(`DELETE FROM work.tasks WHERE org_id = $1`, [scope.orgId]);
        await tx.execute(`DELETE FROM work.initiatives WHERE org_id = $1`, [scope.orgId]);
        await tx.execute(`DELETE FROM work.designs WHERE org_id = $1`, [scope.orgId]);
        await tx.execute(`DELETE FROM work.milestones WHERE org_id = $1`, [scope.orgId]);
        for (const i of initiatives) {
          await tx.execute(
            `INSERT INTO work.initiatives (org_id, key, title, description, owner, target_date, success_criteria, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
            [
              scope.orgId,
              i.key,
              i.title,
              i.description ?? null,
              i.owner ?? null,
              i.targetDate ?? null,
              i.successCriteria ? JSON.stringify(i.successCriteria) : null,
              JSON.stringify(i.createdBy),
              i.createdAt,
            ],
          );
        }
        for (const d of designs) {
          await tx.execute(
            `INSERT INTO work.designs (org_id, key, initiative, title, doc_ref, context, proposal, labels, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
            [
              scope.orgId,
              d.key,
              d.initiative,
              d.title,
              d.docRef ?? null,
              JSON.stringify(d.context),
              d.proposal ? JSON.stringify(d.proposal) : null,
              JSON.stringify(d.labels ?? {}),
              JSON.stringify(d.createdBy),
              d.createdAt,
            ],
          );
        }
        for (const s of specs) {
          await tx.execute(
            `INSERT INTO work.specs (org_id, key, title, doc_ref, initiative_key, target_date, labels, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
            [
              scope.orgId,
              s.key,
              s.title,
              s.docRef ?? null,
              s.initiative ?? null,
              s.targetDate ?? null,
              JSON.stringify(s.labels ?? {}),
              JSON.stringify(s.createdBy),
              s.createdAt,
            ],
          );
        }
        for (const [specKey, ladder] of milestones) {
          for (const m of ladder) {
            await tx.execute(
              `INSERT INTO work.milestones (org_id, spec_key, key, ordinal, title, goal, done_when, target_date, removed)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, false)`,
              [
                scope.orgId,
                specKey,
                m.key,
                m.ordinal,
                m.title,
                m.goal ?? null,
                m.doneWhen ? JSON.stringify(m.doneWhen) : null,
                m.targetDate ?? null,
              ],
            );
          }
        }
        for (const t of tasks) {
          await tx.execute(
            `INSERT INTO work.tasks (org_id, key, spec_key, milestone_key, title, contract, labels, created_by, created_at, tags, priority, estimate, relations, cycle_key)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11, $12, $13::jsonb, $14)`,
            [
              scope.orgId,
              t.key,
              t.spec ?? null,
              t.milestone ?? null,
              t.title,
              t.contract ? JSON.stringify(t.contract) : null,
              JSON.stringify(t.labels ?? {}),
              JSON.stringify(t.createdBy),
              t.createdAt,
              t.tags && t.tags.length > 0 ? JSON.stringify(t.tags) : null,
              t.priority ?? null,
              t.estimate ?? null,
              t.relations && t.relations.length > 0 ? JSON.stringify(t.relations) : null,
              t.cycleKey ?? null,
            ],
          );
        }
        return { specs: specs.length, tasks: tasks.length, initiatives: initiatives.length, designs: designs.length };
      });
    },
  };
}
