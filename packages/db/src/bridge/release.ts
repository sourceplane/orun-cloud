// The runtime → work Released bridge (saas-resources-runtime ⨯ orun-work).
//
// The "seamless SaaS" seam: when the runtime reconciles a create/update
// deployment to live (resources `liveObservation`), the work plane releases the
// tasks that deployment delivered (orun-work W3 `decideReleased`). Released is
// thus derived from real infrastructure state — the Deployment overlay — never
// from a deploy attempt (work invariant 5). All moves are `actor: automation`.
//
// This module is the integration layer: it imports both planes' pure cores and
// drives the result through the W0 one write path (a `delivers` edge + a
// Released transition per delivered task).

import type { Deployment } from "../resources/model.js";
import { liveObservation } from "../resources/model.js";
import { RELEASE_ACTOR, decideReleased, type ReleaseDecision } from "../work/delivery.js";
import type { AutoLinkRepo } from "../work/autolink.js";
import type { ProjectScope, WorkRepositoryError } from "../work/types.js";
import type { Status } from "../work/model.js";

/** A task a deployment delivered (resolved by the caller from the link graph:
 *  revision → PR → implementedBy → task). */
export interface DeliveredTask {
  key: string;
  status: Status;
}

/**
 * The Released decisions a deployment implies: none unless it is a live
 * create/update overlay observation, then one per delivered task that is not
 * already released/canceled. Pure — the testable core of the seam.
 */
export function releaseDecisions(deployment: Deployment, delivered: DeliveredTask[]): ReleaseDecision[] {
  const obs = liveObservation(deployment);
  if (!obs) return [];
  return decideReleased(obs, delivered);
}

export interface ReleaseOutcome {
  released: number;
  rejected: Array<{ key: string; reason: string }>;
}

function describe(e: WorkRepositoryError): string {
  return "message" in e ? e.message : `${e.kind}: ${e.entity}`;
}

/**
 * Apply the Released decisions for a deployment through the work repository: a
 * `delivers` edge (Deployment → Task) plus a Released transition per delivered
 * task, attributed to the deployment-sourced automation principal. A non-live
 * deployment releases nothing.
 */
export async function releaseDeliveredTasks(
  repo: AutoLinkRepo,
  scope: ProjectScope,
  deployment: Deployment,
  delivered: DeliveredTask[],
): Promise<ReleaseOutcome> {
  const decisions = releaseDecisions(deployment, delivered);
  let released = 0;
  const rejected: ReleaseOutcome["rejected"] = [];

  for (const d of decisions) {
    const link = await repo.addLink({
      ...scope,
      from: d.deploymentRef,
      fromKind: "Deployment",
      type: "delivers",
      to: d.taskKey,
      toKind: "Task",
      actor: RELEASE_ACTOR,
    });
    if (!link.ok) {
      rejected.push({ key: d.taskKey, reason: describe(link.error) });
      continue;
    }
    const status = await repo.setStatus({
      ...scope,
      key: d.taskKey,
      status: "released",
      cause: { deployment: d.deploymentRef },
      actor: RELEASE_ACTOR,
    });
    if (status.ok) released += 1;
    else rejected.push({ key: d.taskKey, reason: describe(status.error) });
  }

  return { released, rejected };
}
