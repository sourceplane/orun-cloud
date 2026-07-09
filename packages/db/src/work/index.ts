// The work lens (orun-work v2) — barrel.
//
// Authoritative spec: orun repo specs/orun-work/ (v2); cloud half:
// specs/epics/orun-work/. The Go package internal/worklens is the
// conformance oracle; fixtures/conformance.json is shared byte-identical.

export * from "./model.js";
export * from "./types.js";
export { buildEnvelopes } from "./envelopes.js";
export type { Envelopes, ItemCreatedPayload, ItemEditedPayload, ContractEditedPayload, DocEditedPayload } from "./envelopes.js";
export { canonicalDocBody, docDigest } from "./doc.js";
export { MemoryWorkRepository } from "./memory.js";
export { createWorkRepository, insertWorkObservation } from "./repository.js";
export { workObservationsFromScm, WORK_SCM_SOURCE, WORK_SCM_SOURCE_VERSION } from "./scm.js";
export type { WorkObservationDraft, ScmWorkPayload } from "./scm.js";
export {
  gateObservationsFromRunFold,
  workObservationFromLiveDeployment,
  WORK_RUN_SOURCE,
  WORK_RUN_SOURCE_VERSION,
  WORK_OVERLAY_SOURCE,
  WORK_OVERLAY_SOURCE_VERSION,
} from "./delivery.js";
export type { RunFoldJobs, LiveDeploymentObservation } from "./delivery.js";
