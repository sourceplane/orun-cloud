// Work contracts — the work lens (orun-work v2).
// Owner: state-worker work handlers (apps/state-worker/src/handlers/work.ts).
//
// The work plane is two append-only logs (coordination + observation) and
// LIFECYCLE IS A DERIVED QUERY — no wire shape here carries a stored status;
// `WorkTaskView.lifecycle` is the fold's output with its evidence attached,
// recomputed on every read (spec: orun repo specs/orun-work/; cloud epic:
// specs/epics/orun-work/). There is deliberately no "set status" request
// type: the category is unrepresentable (WP-3).
//
// Routes are workspace-scoped: /v1/organizations/{orgId}/work/... (WP-7 —
// no project partition; `affects` carries delivery topology).

// ── Vocabulary (mirrors @saas/db/work model.ts / orun internal/worklens) ────

export type WorkRung =
  | "draft"
  | "ready"
  | "in_progress"
  | "in_review"
  | "done"
  | "released"
  | "canceled";

export type WorkActorType = "user" | "agent" | "automation";

/** Authored priority (v3 PM2) — pure intent; "none" clears. Never consulted
 *  by the fold. */
export type WorkPriority = "none" | "low" | "medium" | "high" | "urgent";

/** Typed relations (v3 PM2, closed). Only `blocks` has fold semantics: the
 *  target derives blocked from it exactly as from contract deps. */
export type WorkRelationKind = "blocks" | "parent" | "relates";

export interface WorkRelation {
  rel: WorkRelationKind;
  target: string;
}

export interface WorkActor {
  type: WorkActorType;
  id: string;
  via?: string | undefined;
}

export interface WorkContract {
  goal?: string | undefined;
  affects?: string[] | undefined;
  doneWhen?: string[] | undefined;
  gates?: string[] | undefined;
  designRefs?: string[] | undefined;
  deps?: string[] | undefined;
  gatesDefined?: boolean | undefined;
}

// ── Read shapes (fold output with evidence — never stored) ──────────────────

export interface WorkPinView {
  rung: WorkRung;
  by: WorkActor;
  note?: string | undefined;
  at?: string | undefined;
}

export interface WorkLifecycleView {
  rung: WorkRung;
  ready: boolean;
  blocked: boolean;
  evidence?: string[] | undefined;
  pinned?: WorkPinView | undefined;
}

export interface WorkTaskView {
  key: string;
  spec?: string | undefined;
  title: string;
  labels?: Record<string, string> | undefined;
  contract?: WorkContract | undefined;
  createdBy: WorkActor;
  createdAt?: string | undefined;
  lifecycle: WorkLifecycleView;
  // Folded board intent (v3 PM2) — additive; v2 clients ignore them. Pure
  // intent replayed from the coordination log; none of it moves a rung.
  tags?: string[] | undefined;
  priority?: WorkPriority | undefined;
  estimate?: number | undefined;
  relations?: WorkRelation[] | undefined;
  /** v3 PM3: the authored time-box this task is planned into. */
  cycleKey?: string | undefined;
  /** v4: the milestone (within `spec`) this task belongs to. */
  milestone?: string | undefined;
  /** v3 PM5: current assignees (membership subjects — usr_/sp_/team_),
   *  folded from assigned/unassigned events. An sp_ subject IS an agent
   *  seat; assigning to one is the ordinary assign mutator. */
  assignees?: string[] | undefined;
}

export interface WorkSpecView {
  key: string;
  title: string;
  docRef?: string | undefined;
  createdBy: WorkActor;
  createdAt?: string | undefined;
  /** Per-rung counts over the spec's tasks — the projection that replaces
   *  hand-edited status tables. */
  progress: Partial<Record<WorkRung, number>>;
  /** v4: the initiative this epic serves (partOf); empty = unfiled. */
  initiative?: string | undefined;
  /** v4: intent target date (YYYY-MM-DD) — health folds read it. */
  targetDate?: string | undefined;
  /** v4: the authored intent ladder, folded from coordination events only.
   *  Approved never renders without its revision (V4-2); drift renders both
   *  digests (V4-3). Additive — v2/v3 clients ignore it. */
  intent?: WorkEpicIntentView | undefined;
  /** v4: the milestone ladder with derived per-milestone progress. */
  milestones?: WorkMilestoneView[] | undefined;
}

// ── v4: the planning hierarchy (orun-work-v4 WH1) ───────────────────────────

export type WorkIntentState =
  | "draft"
  | "in_review"
  | "approved"
  | "approved_drifted"
  | "adopted"
  | "superseded"
  | "canceled";

export type WorkReviewVerdict = "approve" | "request_changes";

export type WorkHealth = "on_track" | "at_risk" | "off_track";

export interface WorkApprovalView {
  revision?: string | undefined;
  snapshot?: string | undefined;
  by: WorkActor;
  at?: string | undefined;
  ladderHash?: string | undefined;
}

export interface WorkEpicIntentView {
  state: WorkIntentState;
  approval?: WorkApprovalView | undefined;
  currentRevision?: string | undefined;
  docDrifted?: boolean | undefined;
  ladderDrifted?: boolean | undefined;
}

export interface WorkMilestoneView {
  key: string;
  title: string;
  goal?: string | undefined;
  doneWhen?: string[] | undefined;
  targetDate?: string | undefined;
  ordinal: number;
  /** Derived per-rung counts over member tasks — never entered (V4-4). */
  progress?: Partial<Record<WorkRung, number>> | undefined;
  total?: number | undefined;
  complete?: number | undefined;
}

export interface WorkDesignContextView {
  catalog?: string | undefined;
  coordSeq: number;
  obsSeq: number;
}

export interface WorkProposalTaskSkeleton {
  milestone?: string | undefined;
  title: string;
  contract?: WorkContract | undefined;
}

export interface WorkProposalEpic {
  slug: string;
  title: string;
  docSeed?: string | undefined;
  milestones?: Omit<WorkMilestoneView, "progress" | "total" | "complete">[] | undefined;
  taskSkeletons?: WorkProposalTaskSkeleton[] | undefined;
}

export interface WorkProposal {
  epics: WorkProposalEpic[];
}

export interface WorkDesignView {
  key: string;
  initiative: string;
  title: string;
  docRef?: string | undefined;
  context: WorkDesignContextView;
  proposal?: WorkProposal | undefined;
  labels?: Record<string, string> | undefined;
  createdBy: WorkActor;
  createdAt?: string | undefined;
  /** Draft → In Review → Adopted | Superseded — folded, never stored. */
  intent: {
    state: WorkIntentState;
    adoptedRevision?: string | undefined;
    minted?: string[] | undefined;
    adoptedBy?: WorkActor | undefined;
    supersededBy?: string | undefined;
  };
}

export interface CreateWorkDesignRequest {
  title: string;
  docRef?: string | undefined;
  proposal?: WorkProposal | undefined;
  catalog?: string | undefined; // sealed into the context server-side
  labels?: Record<string, string> | undefined;
}

export interface CreateWorkDesignResponse extends WorkMutationResponse {
  design: WorkDesignView;
}

export interface WorkDesignsResponse {
  designs: WorkDesignView[];
}

export interface AdoptWorkDesignRequest {
  /** Subset of proposal epic slugs to mint; defaults to all. */
  epics?: string[] | undefined;
  /** Task-key prefix for minted skeletons (default "WK"). */
  taskPrefix?: string | undefined;
}

export interface AdoptWorkDesignResponse extends WorkMutationResponse {
  minted: string[];
  tasks: string[];
}

export interface SupersedeWorkDesignRequest {
  by?: string | undefined;
  note?: string | undefined;
}

export interface WorkMilestoneRequest {
  op: "create" | "edit" | "reorder" | "remove";
  key: string;
  title?: string | undefined;
  goal?: string | undefined;
  doneWhen?: string[] | undefined;
  targetDate?: string | undefined;
  ordinal?: number | undefined;
}

export interface WorkMilestonesResponse {
  epic: string;
  milestones: WorkMilestoneView[];
  unscheduled?: { total: number; complete: number } | undefined;
}

/** Move a task into (or out of, null) a milestone — the milestone_set event. */
export interface WorkTaskMilestoneRequest {
  milestone: string | null;
}

export interface WorkReviewRequest {
  revision?: string | undefined;
  reviewers?: string[] | undefined;
  note?: string | undefined;
}

export interface WorkVerdictRequest {
  revision?: string | undefined;
  verdict: WorkReviewVerdict;
  note?: string | undefined;
}

/** Approve an epic (human-only — agents/automation get the 422 verdict).
 *  revision defaults to the epic's current doc_ref; a stale revision is a
 *  409 conflict (you approve bytes, not vibes — V4-2). */
export interface ApproveWorkEpicRequest {
  revision?: string | undefined;
  minApprovals?: number | undefined;
}

export interface RevokeWorkApprovalRequest {
  note?: string | undefined;
}

export interface ApproveWorkEpicResponse extends WorkMutationResponse {
  /** The sealed EpicSnapshot's content id — the frozen brief the agent
   *  implements against. The approval IS the dispatch artifact. */
  snapshot: string;
}

/** The sealed brief: canonical bytes + content id. Verify by hashing —
 *  sha256(canonical) MUST equal id; there is no second canonicalizer. */
export interface WorkEpicBriefResponse {
  id: string;
  subject: string;
  canonical: string;
  createdAt?: string | undefined;
}

export interface WorkRollupsResponse {
  initiative: string;
  health: WorkHealth;
  evidence?: string[] | undefined;
  pinnedHealth?: { health: WorkHealth; by: WorkActor; note?: string | undefined; at?: string | undefined } | undefined;
  progress: Partial<Record<WorkRung, number>>;
  total: number;
  complete: number;
  epics: {
    key: string;
    title: string;
    targetDate?: string | undefined;
    intent: WorkEpicIntentView;
    total: number;
    complete: number;
    blocked: number;
  }[];
}

export interface WorkDriftView {
  pr: string;
  affected: string[];
}

export interface WorkSuggestionView {
  pr: string;
  taskKeys: string[];
}

export interface WorkInitiativeView {
  key: string;
  title: string;
  description?: string | undefined;
  /** v4 properties — pure intent (design §1.7). */
  owner?: string | undefined;
  targetDate?: string | undefined;
  successCriteria?: string[] | undefined;
  /** v4: derived health with named evidence — never a dropdown (V4-4). */
  health?: WorkHealth | undefined;
  healthEvidence?: string[] | undefined;
  createdBy: WorkActor;
  createdAt?: string | undefined;
  /** v3 PM3: member specs (related {rel: parent} edges from the log). */
  specs?: string[] | undefined;
  /** v3 PM3: derived rollup over member specs' tasks — a projection of the
   *  fold, never a number anyone types (V3-3). */
  progress?: Partial<Record<WorkRung, number>> | undefined;
}

export interface WorkSummaryResponse {
  specs: WorkSpecView[];
  tasks: WorkTaskView[];
  /** v3 (PM0): strategic groupings — envelope-only, no contract, no rung. */
  initiatives: WorkInitiativeView[];
  drift: WorkDriftView[];
  suggestions: WorkSuggestionView[];
  /** Cursors of the two logs at fold time (the sync/bootstrap positions). */
  coordSeq: number;
  obsSeq: number;
}

export interface WorkEventView {
  eventId: string;
  subject: string;
  kind: string;
  actor: WorkActor;
  at: string;
  payload?: Record<string, unknown> | undefined;
  seq: number;
}

export interface ListWorkEventsResponse {
  events: WorkEventView[];
  /** Highest seq in this page; poll/replay from here. */
  seq: number;
}

// ── Mutations (coordination only; verdicts ride the error envelope) ─────────

export interface CreateWorkSpecRequest {
  slug: string;
  title: string;
  docRef?: string | undefined;
  labels?: Record<string, string> | undefined;
}

export interface CreateWorkTaskRequest {
  prefix: string;
  title: string;
  specKey?: string | undefined;
  /** v4: the milestone (within specKey) this task lands in. */
  milestone?: string | undefined;
  contract?: WorkContract | undefined;
  labels?: Record<string, string> | undefined;
}

export interface WorkCommentRequest {
  body: string;
  /** Reply threading (PM1): the parent comment's eventId. */
  parentEvent?: string | undefined;
  /** Doc range anchor (PM1): pins the comment to a revision's text range. */
  anchor?: { revision: string; start: number; end: number } | undefined;
  /** Contract review (PM5): marks this comment as the human review of an
   *  agent-proposed contract_edited event — the Triage lane's Accept. */
  reviewsEvent?: string | undefined;
}

export interface WorkReactionRequest {
  emoji: string;
}

// ── Board intent (v3 PM2): task verbs — pure intent, one event each ─────────

export interface WorkLabelRequest {
  label: string;
  remove?: boolean | undefined;
}

export interface WorkPriorityRequest {
  priority: WorkPriority; // "none" clears
}

export interface WorkEstimateRequest {
  points: number | null; // null clears
}

export interface WorkRelateRequest {
  rel: WorkRelationKind;
  target: string;
  remove?: boolean | undefined;
}

/** Backlog ordering within a view (v3 PM2 drag-within-column) — the v2
 *  `ordered` coordination event over HTTP. Pure intent, no ceremony. */
export interface WorkOrderRequest {
  view: string;
  order: number;
}

// ── Cycles (v3 PM3): authored time-boxes; progress inside is derived ────────

/** Plan a task into (or out of, null) a cycle — the cycle_set event. */
export interface WorkCycleRequest {
  cycle: string | null;
}

export interface CreateWorkCycleRequest {
  name: string;
  startsAt: string; // ISO date, inclusive
  endsAt: string; // ISO date, inclusive
}

export interface WorkCycleView {
  key: string;
  name: string;
  startsAt: string;
  endsAt: string;
  createdBy: WorkActor;
  createdAt: string;
  /** Derived at read time from the fold — never stored (V3-3). */
  scope: number;
  done: number;
}

export interface WorkCyclesResponse {
  cycles: WorkCycleView[];
}

/** One derived burn-up point: the workspace replayed as of `date`. There is
 *  deliberately no request type that writes one of these (V3-3). */
export interface WorkBurnupPoint {
  date: string;
  scope: number;
  done: number;
}

export interface WorkBurnupResponse {
  key: string;
  name: string;
  startsAt: string;
  endsAt: string;
  points: WorkBurnupPoint[];
}

// ── Saved views (v3 PM2): shareable UI intent — no event, no lifecycle ──────

export interface WorkViewConfig {
  layout: "board" | "list";
  filters?:
    | {
        tags?: string[] | undefined;
        priority?: WorkPriority[] | undefined;
        rung?: WorkRung[] | undefined;
        spec?: string[] | undefined;
      }
    | undefined;
  groupBy?: string | undefined;
  order?: string[] | undefined;
}

export interface WorkViewView {
  key: string;
  name: string;
  config: WorkViewConfig;
  createdBy: WorkActor;
  createdAt: string;
}

export interface SaveWorkViewRequest {
  key: string; // lowercase kebab; upsert key
  name: string;
  config: WorkViewConfig;
}

export interface WorkViewsResponse {
  views: WorkViewView[];
}

// ── The timeline (PM1): both logs interleaved for one item ──────────────────

export interface WorkObservationView {
  obsId: string;
  source: string;
  kind: string;
  at: string;
  payload?: Record<string, unknown> | undefined;
  seq: number;
}

export interface WorkTimelineEntry {
  at: string;
  type: "event" | "observation";
  event?: WorkEventView | undefined;
  observation?: WorkObservationView | undefined;
}

export interface WorkTimelineResponse {
  key: string;
  entries: WorkTimelineEntry[];
}

export interface WorkAssignRequest {
  subject: string; // membership subject id (usr_/sp_/team_)
  unassign?: boolean | undefined;
  /** v4 WH5: a human's attributed reason for dispatching an agent into an
   *  epic that is not Approved. Without it, that assign is a 422 verdict;
   *  agents can never override (design §3). */
  override?: string | undefined;
}

/** v4 WH5: governed re-planning of one milestone. Planned (draft/ready)
 *  tasks cancel; in-flight tasks survive (Q-6); contract-bearing creations
 *  by agents flag into the triage review lane. */
export interface RegenerateWorkTasksRequest {
  tasks: { title: string; contract?: WorkContract | undefined }[];
  prefix?: string | undefined;
}

export interface RegenerateWorkTasksResponse {
  canceled: string[];
  kept: string[];
  created: string[];
}

export interface WorkPinRequest {
  rung: WorkRung | null; // null unpins; agents are rejected in the mutator
  note?: string | undefined;
}

export interface WorkContractRequest {
  contract: WorkContract;
}

export interface CreateWorkInitiativeRequest {
  slug: string;
  title: string;
  description?: string | undefined;
  owner?: string | undefined;
  targetDate?: string | undefined;
  successCriteria?: string[] | undefined;
}

export interface EditWorkItemRequest {
  title?: string | undefined;
  description?: string | undefined; // initiatives only
  labels?: Record<string, string> | undefined;
  /** v4 properties — pure intent. null unfiles/clears. */
  initiative?: string | null | undefined;
  targetDate?: string | null | undefined;
  owner?: string | null | undefined;
  successCriteria?: string[] | undefined;
}

// ── Cloud documents (orun-work-v3 PM0; content-addressed, fork-visible) ─────

export interface PutWorkDocRequest {
  body: string;
  /** The revision this edit was made on; a stale parent still applies and
   *  the fork stays visible in the history (fork-visible LWW, design §1.4). */
  parent?: string | undefined;
}

export interface PutWorkDocResponse {
  revision: string;
  parent?: string | undefined;
  /** false = the body hashed to the current doc_ref; nothing was written. */
  created: boolean;
  seq: number | null; // the doc_edited event's seq (null on no-op)
}

export interface WorkDocRevisionView {
  revision: string;
  parent?: string | undefined;
  specKey: string;
  createdBy: WorkActor;
  createdAt: string;
}

export interface GetWorkDocResponse extends WorkDocRevisionView {
  body: string;
}

export interface WorkDocHistoryResponse {
  revisions: WorkDocRevisionView[];
}

export interface WorkMutationResponse {
  key: string;
  seq: number; // the appended coordination event's seq
}

export interface CreateWorkTaskResponse extends WorkMutationResponse {
  task: WorkTaskView;
}

export interface CreateWorkSpecResponse extends WorkMutationResponse {
  spec: WorkSpecView;
}

export interface CreateWorkInitiativeResponse extends WorkMutationResponse {
  initiative: WorkInitiativeView;
}

// ── Import (the dogfood path: `orun work import` applies its dry-run plan) ──

export interface WorkImportSpec {
  slug: string;
  title: string;
  docPath: string;
  docSha256: string;
  planPath?: string | undefined;
}

export interface WorkImportTask {
  specSlug: string;
  milestoneId: string;
  title: string;
  contract?: WorkContract | undefined;
}

/** The deterministic plan produced by `orun work import --dry-run`
 *  (orun internal/worklens ImportPlan). NOTE: no lifecycle field exists —
 *  rungs derive from real observations after apply. */
export interface WorkImportRequest {
  workspace: string;
  root: string;
  prefix?: string | undefined; // task-key prefix; defaults to "WRK"
  specs: WorkImportSpec[];
  tasks: WorkImportTask[];
}

export interface WorkImportResponse {
  specsCreated: number;
  specsSkipped: number; // already-existing slugs (re-import is idempotent)
  tasksCreated: number;
  tasksSkipped: number;
}

// ── CI observation producer (the affected-set feed) ─────────────────────────

/** A world-authored fact posted by a named external producer (orun/CI).
 *  The only source admitted over the public API is "ci" — the webhook drain
 *  and the WP3 run/overlay feeds are internal ingesters. */
export interface IngestWorkObservationRequest {
  source: "ci";
  sourceVersion: number;
  kind: "branch_seen" | "pr_opened" | "pr_merged" | "pr_closed";
  at?: string | undefined;
  dedupeKey: string;
  payload?: Record<string, unknown> | undefined;
}

export interface IngestWorkObservationResponse {
  deduped: boolean;
  seq: number | null;
}

// ── Triage (v3 PM5): everything needing a human decision, one surface ───────
//
// Pure aggregation over the two logs — nothing here is a new stored state.
// The contract-review lane's lifecycle is itself log-derived: a proposal is
// an agent/automation-actored contract_edited event, OPEN until a later
// human contract_edited on the same task (revert/supersede) or a human
// comment whose payload.reviewsEvent names it (accept).

export interface WorkMentionView {
  key: string; // task/spec the comment sits on
  eventId: string;
  at: string;
  by: WorkActor;
  handles: string[];
  body: string;
}

export interface WorkContractProposalView {
  key: string;
  eventId: string;
  seq: number;
  at: string;
  proposedBy: WorkActor;
  /** The contract as proposed (now in effect — proposals apply AND flag). */
  contract: WorkContract;
  /** The contract before the proposal — what Revert restores. */
  previousContract?: WorkContract | undefined;
}

export interface WorkTriageResponse {
  drift: WorkDriftView[];
  suggestions: WorkSuggestionView[];
  /** Merged but parked In Review by honest degradation (gates unknown/red). */
  reviewParked: WorkTaskView[];
  mentions: WorkMentionView[];
  contractProposals: WorkContractProposalView[];
}

// ── Policy actions ──────────────────────────────────────────────────────────

export const WORK_POLICY_ACTIONS = {
  WORK_READ: "work.read",
  WORK_WRITE: "work.write",
  /** v4: approval is a real privilege boundary (reviewer ≠ approver). Lands
   *  in the role maps AND ALL_KNOWN_ACTIONS in the same commit (V3-4). */
  WORK_APPROVE: "work.approve",
} as const;

export type WorkPolicyAction = (typeof WORK_POLICY_ACTIONS)[keyof typeof WORK_POLICY_ACTIONS];
