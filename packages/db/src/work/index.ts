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
