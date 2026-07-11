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
  Design,
  DocRevision,
  Initiative,
  Milestone,
  Observation,
  Priority,
  Proposal,
  RelationKind,
  ReviewVerdict,
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
  owner?: string | undefined;
  targetDate?: string | undefined;
  successCriteria?: string[] | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface CreateTaskInput {
  prefix: string; // 2–5 uppercase; key allocates PREFIX-<seq>
  specKey?: string | undefined;
  /** v4: the milestone (within specKey) this task lands in. Requires
   *  specKey; the milestone must exist in the epic's ladder. */
  milestone?: string | undefined;
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
  // v4 properties (design §1.7) — pure intent, edited via item_edited.
  initiative?: string | null | undefined; // null unfiles an epic
  targetDate?: string | null | undefined;
  owner?: string | null | undefined;
  successCriteria?: string[] | undefined;
  actor: Actor;
  at?: string | undefined;
}

// ── v4 hierarchy inputs (orun-work-v4 WH1) ──────────────────────────────────

export interface EditMilestoneInput {
  epicKey: string;
  op: "create" | "edit" | "reorder" | "remove";
  key: string;
  title?: string | undefined;
  goal?: string | undefined;
  doneWhen?: string[] | undefined;
  targetDate?: string | undefined;
  ordinal?: number | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface SetMilestoneInput {
  key: string; // task key
  milestone: string | null; // null clears (back to the unscheduled bucket)
  actor: Actor;
  at?: string | undefined;
}

export interface RequestReviewInput {
  key: string; // epic or design key
  revision?: string | undefined;
  reviewers?: string[] | undefined;
  note?: string | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface SubmitVerdictInput {
  key: string; // epic or design key
  revision?: string | undefined;
  verdict: ReviewVerdict;
  note?: string | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface ApproveInput {
  key: string; // epic key
  /** The doc revision being approved. When set it MUST equal the epic's
   *  current doc_ref (a stale approval is a conflict verdict — you approve
   *  bytes, not vibes). Defaults to the current doc_ref. */
  revision?: string | undefined;
  /** Workspace policy knob (default 1). Counting includes the approver. */
  minApprovals?: number | undefined;
  /** Catalog snapshot id sealed into the brief, when the caller has one. */
  catalog?: string | undefined;
  actor: Actor;
  at?: string | undefined;
}

/** The sealed brief: canonical bytes + their content id. `orun epic pull`
 *  verifies sha256(canonical) == id — the approval IS the dispatch artifact. */
export interface SealedBrief {
  id: string;
  subject: string; // the epic key
  canonical: string;
  createdAt?: string | undefined;
}

export interface RevokeApprovalInput {
  key: string;
  note?: string | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface CreateDesignInput {
  initiativeKey: string;
  title: string;
  docRef?: string | undefined;
  proposal?: Proposal | undefined;
  /** Sealed context; the handler stamps catalog + current log cursors. */
  context?: { catalog?: string | undefined } | undefined;
  labels?: Record<string, string> | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface AdoptDesignInput {
  key: string; // design key
  /** Subset of proposal epic slugs to mint; defaults to all. */
  epics?: string[] | undefined;
  /** Task-key prefix for minted task skeletons (default "WK"). */
  taskPrefix?: string | undefined;
  actor: Actor;
  at?: string | undefined;
}

export interface AdoptOutcome {
  event: CoordinationEvent; // the design_adopted decision
  minted: string[]; // epic keys created
  tasks: string[]; // task keys created from skeletons
}

export interface SupersedeDesignInput {
  key: string;
  by?: string | undefined;
  note?: string | undefined;
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
  /** Contract review (PM5): marks this comment as the human review of an
   *  agent-proposed contract_edited event — Accept in the Triage lane. */
  reviewsEvent?: string | undefined;
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

  /** v4 hierarchy mutators (WH1). One coordination event each, except
   *  adoptDesign — the documented transactional mint batch (design §2).
   *  approved / approval_revoked / design_adopted / superseded are
   *  human-only (V4-2): the model rejects agents AND automation at write
   *  time; the routes return the verdict as a 422. */
  editMilestone(scope: WorkspaceScope, input: EditMilestoneInput): Promise<CommitOutcome>;
  setMilestone(scope: WorkspaceScope, input: SetMilestoneInput): Promise<CommitOutcome>;
  listMilestones(scope: WorkspaceScope, epicKey: string): Promise<Milestone[]>;
  requestReview(scope: WorkspaceScope, input: RequestReviewInput): Promise<CommitOutcome>;
  submitVerdict(scope: WorkspaceScope, input: SubmitVerdictInput): Promise<CommitOutcome>;
  /** Seals the EpicSnapshot in the same transaction as the approved event
   *  (WH4, design §3) and stamps the snapshot id into the payload. */
  approve(scope: WorkspaceScope, input: ApproveInput): Promise<CommitOutcome & { snapshot: string }>;
  /** The sealed brief — latest for the epic, or an exact id. */
  getEpicBrief(scope: WorkspaceScope, epicKey: string, id?: string): Promise<SealedBrief>;
  revokeApproval(scope: WorkspaceScope, input: RevokeApprovalInput): Promise<CommitOutcome>;
  createDesign(scope: WorkspaceScope, input: CreateDesignInput): Promise<CommitOutcome & { design: Design }>;
  getDesign(scope: WorkspaceScope, key: string): Promise<Design>;
  listDesigns(scope: WorkspaceScope, initiativeKey?: string): Promise<Design[]>;
  adoptDesign(scope: WorkspaceScope, input: AdoptDesignInput): Promise<AdoptOutcome>;
  supersedeDesign(scope: WorkspaceScope, input: SupersedeDesignInput): Promise<CommitOutcome>;

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
