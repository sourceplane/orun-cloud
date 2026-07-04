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
}

export interface WorkDriftView {
  pr: string;
  affected: string[];
}

export interface WorkSuggestionView {
  pr: string;
  taskKeys: string[];
}

export interface WorkSummaryResponse {
  specs: WorkSpecView[];
  tasks: WorkTaskView[];
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
  contract?: WorkContract | undefined;
  labels?: Record<string, string> | undefined;
}

export interface WorkCommentRequest {
  body: string;
}

export interface WorkAssignRequest {
  subject: string; // membership subject id (usr_/sp_/team_)
  unassign?: boolean | undefined;
}

export interface WorkPinRequest {
  rung: WorkRung | null; // null unpins; agents are rejected in the mutator
  note?: string | undefined;
}

export interface WorkContractRequest {
  contract: WorkContract;
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

// ── Policy actions ──────────────────────────────────────────────────────────

export const WORK_POLICY_ACTIONS = {
  WORK_READ: "work.read",
  WORK_WRITE: "work.write",
} as const;

export type WorkPolicyAction = (typeof WORK_POLICY_ACTIONS)[keyof typeof WORK_POLICY_ACTIONS];
