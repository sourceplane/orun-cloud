// @saas/db/bridge — cross-plane integration (saas-resources-runtime ⨯ orun-work).
//
// The seamless-SaaS seams that connect the runtime plane to the work plane.
// Today: runtime deployment goes live → work tasks Released.

export { releaseDecisions, releaseDeliveredTasks } from "./release.js";
export type { DeliveredTask, ReleaseOutcome } from "./release.js";
