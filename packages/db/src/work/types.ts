// Repository contract for the work lens (orun-work v2 WP0).
//
// One mutator surface (WP-6): every mutator appends EXACTLY ONE coordination
// event; intent-envelope caches update in the same transaction and stay
// droppable (invariant 1). Observations enter ONLY via ingestObservation —
// no mutator can author a fact. There is deliberately no setStatus /
// setLifecycle anywhere in this interface (WP-3).

import type {
  Actor,
  Contract,
  CoordinationEvent,
  Observation,
  Rung,
  Spec,
  Task,
  WorkSet,
} from "./model.js";

export interface WorkspaceScope {
  orgId: string;
}

export interface CreateSpecInput {
  slug: string;
  title: string;
  docRef?: string | undefined;
  labels?: Record<string, string> | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface CreateTaskInput {
  prefix: string; // 2–5 uppercase; key allocates PREFIX-<seq>
  specKey?: string | undefined;
  title: string;
  contract?: Contract | undefined;
  labels?: Record<string, string> | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface EditItemInput {
  key: string;
  title?: string | undefined;
  labels?: Record<string, string> | undefined;
  docRef?: string | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface EditContractInput {
  key: string;
  contract: Contract;
  actor: Actor;
  at?: string | undefined;
}

export interface AssignInput {
  key: string;
  subject: string; // membership subject id (usr_/sp_/team_)
  actor: Actor;
  at?: string | undefined;
}

export interface CommentInput {
  key: string;
  body: string;
  actor: Actor;
  at?: string | undefined;
}

export interface OrderInput {
  key: string;
  view: string; // per-view ordering (priority is coordination, not a rung)
  order: number;
  actor: Actor;
  at?: string | undefined;
}

export interface PinInput {
  key: string;
  rung: Rung | null; // null unpins
  note?: string | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface CancelInput {
  key: string;
  actor: Actor;
  at?: string | undefined;
}

export interface CommitOutcome {
  event: CoordinationEvent;
  key: string;
}

export type IngestObservationInput = Omit<Observation, "seq" | "obsId">;

export interface IngestOutcome {
  observation: Observation | null; // null when deduped (already ingested)
  deduped: boolean;
}

export interface WorkRepository {
  createSpec(scope: WorkspaceScope, input: CreateSpecInput): Promise<CommitOutcome & { spec: Spec }>;
  createTask(scope: WorkspaceScope, input: CreateTaskInput): Promise<CommitOutcome & { task: Task }>;
  editItem(scope: WorkspaceScope, input: EditItemInput): Promise<CommitOutcome>;
  editContract(scope: WorkspaceScope, input: EditContractInput): Promise<CommitOutcome>;
  assign(scope: WorkspaceScope, input: AssignInput): Promise<CommitOutcome>;
  unassign(scope: WorkspaceScope, input: AssignInput): Promise<CommitOutcome>;
  comment(scope: WorkspaceScope, input: CommentInput): Promise<CommitOutcome>;
  order(scope: WorkspaceScope, input: OrderInput): Promise<CommitOutcome>;
  pin(scope: WorkspaceScope, input: PinInput): Promise<CommitOutcome>;
  cancel(scope: WorkspaceScope, input: CancelInput): Promise<CommitOutcome>;

  /** The only fact writer — named ingesters call this; mutators cannot. */
  ingestObservation(scope: WorkspaceScope, input: IngestObservationInput): Promise<IngestOutcome>;

  /** Everything the fold needs: envelopes + both logs, seq-ordered. */
  getWorkSet(scope: WorkspaceScope): Promise<WorkSet>;
  listEvents(scope: WorkspaceScope, fromSeq?: number): Promise<CoordinationEvent[]>;
  listObservations(scope: WorkspaceScope, fromSeq?: number): Promise<Observation[]>;
}
