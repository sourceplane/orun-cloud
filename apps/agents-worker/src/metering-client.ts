// Usage emission (saas-agents AG10, design §8): fire-and-forget metering
// events over the METERING_WORKER binding. Emission NEVER blocks or fails a
// spawn — a lost sample is a billing reconciliation problem, not an outage;
// the reconcile-against-lease-truth replay rides a later slice.

import type { ActorContext } from "./router.js";

export interface UsageRecorder {
  record(
    orgId: string,
    metric: string,
    quantity: number,
    dimensions: Record<string, string>,
    actor: ActorContext,
    requestId: string,
  ): Promise<void>;
}

export function createUsageRecorder(meteringWorker: Fetcher): UsageRecorder {
  return {
    async record(orgId, metric, quantity, dimensions, actor, requestId) {
      try {
        await meteringWorker.fetch(
          `http://metering-worker/v1/organizations/${encodeURIComponent(orgId)}/usage`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-request-id": requestId,
              "x-actor-subject-id": actor.subjectId,
              "x-actor-subject-type": actor.subjectType,
            },
            body: JSON.stringify({ metric, quantity, dimensions }),
          },
        );
      } catch {
        // Fire-and-forget: never surface.
      }
    },
  };
}
