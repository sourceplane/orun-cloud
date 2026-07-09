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
  Cycle,
  DocRevision,
  Initiative,
  Observation,
  Priority,
  RelationKind,
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

export interface CreateInitiativeInput {
  slug: string;
  title: string;
  description?: string | undefined;
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
  /** Reply threading (PM1): the parent comment's eventId. */
  parentEvent?: string | undefined;
  /** Doc range anchor (PM1): pins the comment to a revision's text range. */
  anchor?: { revision: string; start: number; end: number } | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface ReactionInput {
  /** The comment event being reacted to. */
  targetEvent: string;
  emoji: string;
  actor: Actor;
  at?: string | undefined;
}

export interface LabelInput {
  key: string;
  label: string;
  actor: Actor;
  at?: string | undefined;
}

export interface PriorityInput {
  key: string;
  priority: Priority; // "none" clears
  actor: Actor;
  at?: string | undefined;
}

export interface EstimateInput {
  key: string;
  points: number | null; // null clears
  actor: Actor;
  at?: string | undefined;
}

export interface RelateInput {
  key: string;
  rel: RelationKind;
  target: string;
  actor: Actor;
  at?: string | undefined;
}

/** An authored time-box (v3 PM3). Creating one is intent — a name and two
 *  dates; the key allocates CYC-<seq>. Progress inside stays derived. */
export interface CreateCycleInput {
  name: string;
  startsAt: string; // ISO date
  endsAt: string; // ISO date
  actor: Actor;
  at?: string | undefined;
}

export interface SetCycleInput {
  key: string;
  cycle: string | null; // null clears
  actor: Actor;
  at?: string | undefined;
}

/** A saved view (v3 PM2): pure UI intent, shareable by default. Views are
 *  workspace configuration, not item coordination — they live beside the
 *  logs (work.views) and append NO event; the closed event vocabulary has
 *  no view kind. */
export interface WorkView {
  key: string;
  name: string;
  config: Record<string, unknown>; // {layout: board|list, filters, groupBy, order}
  createdBy: Actor;
  createdAt: string;
}

export interface SaveViewInput {
  key: string; // lowercase kebab; upsert key
  name: string;
  config: Record<string, unknown>;
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

export interface PutDocInput {
  specKey: string;
  body: string; // markdown; CRLF is normalized to LF before hashing
  /** The revision this edit was made on. Defaults to the spec's current
   *  doc_ref. A stale parent still applies — the fork stays visible in the
   *  history (orun-work-v3 §1.4: fork-visible last-writer-wins). */
  parent?: string | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface PutDocOutcome {
  revision: string;
  parent?: string | undefined;
  /** false when the body hashes to the spec's current doc_ref — an
   *  identical save is a no-op and appends NO event. */
  created: boolean;
  event: CoordinationEvent | null;
}

export type IngestObservationInput = Omit<Observation, "seq" | "obsId">;

export interface IngestOutcome {
  observation: Observation | null; // null when deduped (already ingested)
  deduped: boolean;
}

export interface WorkRepository {
  createSpec(scope: WorkspaceScope, input: CreateSpecInput): Promise<CommitOutcome & { spec: Spec }>;
  createTask(scope: WorkspaceScope, input: CreateTaskInput): Promise<CommitOutcome & { task: Task }>;
  createInitiative(scope: WorkspaceScope, input: CreateInitiativeInput): Promise<CommitOutcome & { initiative: Initiative }>;
  editItem(scope: WorkspaceScope, input: EditItemInput): Promise<CommitOutcome>;
  editContract(scope: WorkspaceScope, input: EditContractInput): Promise<CommitOutcome>;
  assign(scope: WorkspaceScope, input: AssignInput): Promise<CommitOutcome>;
  unassign(scope: WorkspaceScope, input: AssignInput): Promise<CommitOutcome>;
  comment(scope: WorkspaceScope, input: CommentInput): Promise<CommitOutcome>;
  /** PM1: reactions target a comment event; one coordination event each. */
  addReaction(scope: WorkspaceScope, input: ReactionInput): Promise<CommitOutcome>;
  removeReaction(scope: WorkspaceScope, input: ReactionInput): Promise<CommitOutcome>;
  /** PM2 board intent — task verbs, one coordination event each; the folded
   *  envelope fields (tags/priority/estimate/relations) rebuild from the
   *  log alone (invariant 1). Priority/estimate/labels were never the lie —
   *  they are pure intent; nothing here can move a rung. */
  label(scope: WorkspaceScope, input: LabelInput): Promise<CommitOutcome>;
  unlabel(scope: WorkspaceScope, input: LabelInput): Promise<CommitOutcome>;
  prioritize(scope: WorkspaceScope, input: PriorityInput): Promise<CommitOutcome>;
  estimate(scope: WorkspaceScope, input: EstimateInput): Promise<CommitOutcome>;
  relate(scope: WorkspaceScope, input: RelateInput): Promise<CommitOutcome>;
  unrelate(scope: WorkspaceScope, input: RelateInput): Promise<CommitOutcome>;
  /** PM3: plan a task into (or out of, null) an authored time-box — one
   *  cycle_set event; the folded cycle_key column rebuilds from the log. */
  setCycle(scope: WorkspaceScope, input: SetCycleInput): Promise<CommitOutcome>;
  order(scope: WorkspaceScope, input: OrderInput): Promise<CommitOutcome>;
  pin(scope: WorkspaceScope, input: PinInput): Promise<CommitOutcome>;
  cancel(scope: WorkspaceScope, input: CancelInput): Promise<CommitOutcome>;

  /** The only fact writer — named ingesters call this; mutators cannot. */
  ingestObservation(scope: WorkspaceScope, input: IngestObservationInput): Promise<IngestOutcome>;

  /** Cloud document revisions (orun-work-v3 PM0). Content-addressed; the
   *  digest form matches the imported doc_ref, so `orun spec pull` seals a
   *  cloud doc unchanged (V3-2). Bodies are content, not envelope — they
   *  live beside the logs, keyed by digest. */
  putDocRevision(scope: WorkspaceScope, input: PutDocInput): Promise<PutDocOutcome>;
  getDocRevision(scope: WorkspaceScope, specKey: string, revision?: string): Promise<DocRevision>;
  listDocHistory(scope: WorkspaceScope, specKey: string): Promise<Omit<DocRevision, "body">[]>;

  /** Saved views (v3 PM2): workspace UI configuration beside the logs —
   *  upsert by key, no coordination event (there is no view event kind). */
  saveView(scope: WorkspaceScope, input: SaveViewInput): Promise<WorkView>;
  listViews(scope: WorkspaceScope): Promise<WorkView[]>;

  /** Authored time-boxes (v3 PM3): a cycle row is intent (name + dates,
   *  key CYC-<seq>); everything inside it is derived from the fold. Like
   *  views, cycles are workspace nouns beside the logs — creating one
   *  appends no coordination event; PLANNING a task into one (setCycle)
   *  does. */
  createCycle(scope: WorkspaceScope, input: CreateCycleInput): Promise<Cycle>;
  listCycles(scope: WorkspaceScope): Promise<Cycle[]>;

  /** Everything the fold needs: envelopes + both logs, seq-ordered. */
  getWorkSet(scope: WorkspaceScope): Promise<WorkSet>;
  listEvents(scope: WorkspaceScope, fromSeq?: number): Promise<CoordinationEvent[]>;
  listObservations(scope: WorkspaceScope, fromSeq?: number): Promise<Observation[]>;
}
