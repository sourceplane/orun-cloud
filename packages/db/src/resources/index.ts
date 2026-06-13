// @saas/db/resources — manifested project resources + runtime reconciliation
// (saas-resources-runtime, the P2 moat). model.ts is the pure decision core; the
// SQL repository and the Cloudflare Workflows runtime are thin shells over it.

export {
  RESOURCE_API_VERSION,
  RESOURCE_PHASES,
  DEPLOYMENT_PHASES,
  RuntimeError,
  applyDeploymentEvent,
  liveObservation,
  reconcile,
  resourcePhaseFor,
} from "./model.js";

export type {
  ConditionStatus,
  Deployment,
  DeploymentEvent,
  DeploymentIntent,
  DeploymentPhase,
  LiveObservation,
  Resource,
  ResourceCondition,
  ResourceFailure,
  ResourceMetadata,
  ResourcePhase,
  ResourceStatus,
} from "./model.js";
