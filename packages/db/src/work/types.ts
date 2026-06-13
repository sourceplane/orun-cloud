export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../hyperdrive/executor.js";

import type { Actor, Contract, Item, Link, Status, StatusRow, WorkEvent } from "./model.js";

// ---------------------------------------------------------------------------
// Result / error types (mirrors the other db contexts)
// ---------------------------------------------------------------------------

export type WorkRepositoryError =
  | { kind: "not_found"; entity: string }
  | { kind: "conflict"; entity: string }
  | { kind: "invalid_argument"; message: string }
  | { kind: "internal"; message: string };

export type WorkResult<T> = { ok: true; value: T } | { ok: false; error: WorkRepositoryError };

// ---------------------------------------------------------------------------
// Tenancy scope — the spec's abstract `project` maps onto (orgId, projectId)
// ---------------------------------------------------------------------------

export interface ProjectScope {
  orgId: string;
  projectId: string;
}

export interface EnsureProjectInput extends ProjectScope {
  /** Task-key prefix, 2–5 uppercase letters (e.g. "ORN"). */
  prefix: string;
}

// ---------------------------------------------------------------------------
// Mutator inputs (the W0 write surface: create/edit/status/assign/comment/
// link/contract). Each call appends exactly one event and updates the
// projection in one transaction.
// ---------------------------------------------------------------------------

export interface CreateItemInput extends ProjectScope {
  kind: Item["kind"];
  /** Slug for Epic/Initiative; omit for Task (the key is allocated). */
  slug?: string;
  title: string;
  doc?: string;
  parent?: string;
  cycle?: string;
  labels?: Record<string, string>;
  contract?: Contract;
  actor: Actor;
  at?: string;
}

export interface EditItemInput extends ProjectScope {
  key: string;
  title?: string;
  doc?: string;
  actor: Actor;
  at?: string;
}

export interface SetStatusInput extends ProjectScope {
  key: string;
  status: Status;
  cause?: { pr?: string; run?: string; deployment?: string };
  actor: Actor;
  at?: string;
}

export interface AssignInput extends ProjectScope {
  key: string;
  principal: string;
  actor: Actor;
  at?: string;
}

export interface CommentInput extends ProjectScope {
  key: string;
  body: string;
  actor: Actor;
  at?: string;
}

export interface LinkInput extends ProjectScope {
  from: string;
  fromKind: string;
  type: Link["type"];
  to: string;
  toKind: string;
  actor: Actor;
  at?: string;
}

export interface RemoveLinkInput extends ProjectScope {
  from: string;
  type: Link["type"];
  to: string;
  actor: Actor;
  at?: string;
}

export interface EditContractInput extends ProjectScope {
  key: string;
  contract?: Contract;
  actor: Actor;
  at?: string;
}

export interface CommitOutcome {
  event: WorkEvent;
  key: string;
}

// ---------------------------------------------------------------------------
// Repository surface
// ---------------------------------------------------------------------------

export interface WorkRepository {
  /** Idempotently register a project's task-key prefix + sequence allocator. */
  ensureProject(input: EnsureProjectInput): Promise<WorkResult<void>>;

  createItem(input: CreateItemInput): Promise<WorkResult<CommitOutcome>>;
  editItem(input: EditItemInput): Promise<WorkResult<CommitOutcome>>;
  setStatus(input: SetStatusInput): Promise<WorkResult<CommitOutcome>>;
  assign(input: AssignInput): Promise<WorkResult<CommitOutcome>>;
  unassign(input: AssignInput): Promise<WorkResult<CommitOutcome>>;
  addComment(input: CommentInput): Promise<WorkResult<CommitOutcome>>;
  addLink(input: LinkInput): Promise<WorkResult<CommitOutcome>>;
  removeLink(input: RemoveLinkInput): Promise<WorkResult<CommitOutcome>>;
  editContract(input: EditContractInput): Promise<WorkResult<CommitOutcome>>;

  getItem(scope: ProjectScope, key: string): Promise<WorkResult<Item | null>>;
  getStatus(scope: ProjectScope, key: string): Promise<WorkResult<StatusRow | null>>;
  listEvents(scope: ProjectScope, fromSeq?: number): Promise<WorkResult<WorkEvent[]>>;

  /** Open Tasks (status not done/released/canceled) with their contract.affects
   *  — the candidate set the PR auto-linker matches against. */
  listOpenTasks(scope: ProjectScope): Promise<WorkResult<Array<{ key: string; status: Status; affects: string[] }>>>;

  /**
   * Drop and rebuild the work_status projection from the event log — the
   * operational form of invariant 2. Returns the row count rebuilt.
   */
  rebuildProjection(scope: ProjectScope): Promise<WorkResult<number>>;
}
