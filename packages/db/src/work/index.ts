// @saas/db/work — the work-plane persistence module (orun-work W0).
//
// `model` is the pure, unit-tested decision core (the TS mirror of orun's
// `internal/work` oracle); `repository` is the Postgres persistence that
// reproduces it transactionally. See specs/orun-work/data-model.md.

export {
  API_VERSION,
  ACTOR_TYPES,
  EVENT_KINDS,
  KINDS,
  LINK_TYPES,
  STATUSES,
  WorkError,
  WorkProjection,
  agentReady,
  contractComplete,
  formatTaskKey,
  isEventKind,
  isKind,
  isLinkType,
  isStatus,
  taskKeySeq,
  validateActor,
  validateEvent,
} from "./model.js";

export type {
  Actor,
  ActorType,
  Cause,
  Contract,
  EventKind,
  Item,
  ItemOptions,
  Kind,
  Link,
  LinkType,
  Status,
  StatusRow,
  WorkEvent,
  WorkErrorKind,
} from "./model.js";

export { dispatch } from "./sync.js";
export { WorkSyncServer } from "./sync-server.js";
export { WorkSyncClient } from "./sync-client.js";

export type {
  ClientMessage,
  EventMessage,
  Mutation,
  MutationOp,
  MutateMessage,
  ReplayMessage,
  ServerMessage,
  SubscribeMessage,
  Verdict,
  VerdictMessage,
} from "./sync.js";
export type { Subscriber } from "./sync-server.js";

export {
  AUTOLINK_ACTOR,
  applyAutoLinkPlan,
  computeAutoLinkPlan,
  materializeAffects,
  parseTaskKeys,
} from "./autolink.js";

export type {
  AffectsLink,
  AffectsResolution,
  AppliedAutoLink,
  AutoLink,
  AutoLinkPlan,
  AutoLinkRepo,
  AutoTransition,
  LinkReason,
  PullRequestContext,
  PullRequestPhase,
  TaskView,
} from "./autolink.js";

export { ingestPullRequest } from "./ingest.js";
export { parsePullRequestEvent } from "./webhook.js";
export type { AffectedSet, IngestOutcome, IngestRepo } from "./ingest.js";
export type { GithubPullRequestEvent } from "./webhook.js";

export { createWorkRepository } from "./repository.js";

export type {
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
