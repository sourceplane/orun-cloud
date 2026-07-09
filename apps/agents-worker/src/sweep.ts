// The lease sweep (saas-agents AG6, design §4.3) — what makes "sessions are
// cattle" true under partial failure. On each cron tick: active sessions
// whose lease lapsed and provisioning sessions that never booted are
// reclaimed — their sandbox destroyed on the workspace's own Daytona account
// (over-destroy on ambiguity: a destroy failure or a missing connection never
// blocks the reclaim), and the session lands `failed(lease_lost)`. Durable
// truth is the sealed session in orun's object graph, never the box.

import type { AgentsDeps } from "./deps.js";
import type { ActorContext } from "./router.js";
import type { AgentSession, ProviderConnection } from "@saas/db/agents";

/** Lease horizon: a session is reclaimed this long after its lease lapses
 * (one grace beat past the 15-min heartbeat chain). */
const LEASE_GRACE_MS = 5 * 60 * 1000;
/** A provisioning session that has not heartbeat within this never booted. */
const PROVISIONING_STALL_MS = 30 * 60 * 1000;
const SWEEP_BATCH = 50;

/** The sweep's synthetic actor — custody resolve is audit-stamped with it. */
const SWEEP_ACTOR: ActorContext = { subjectId: "agents-worker-sweep", subjectType: "service" };

export interface SweepSummary {
  examined: number;
  reclaimed: number;
  destroyed: number;
  destroyErrors: number;
}

function pickDaytona(rows: ProviderConnection[]): ProviderConnection | null {
  if (rows.length === 0) return null;
  // Sole-or-default like the spawn gate — but ANY status will do: destroying
  // with a later-invalidated key is still worth attempting.
  return rows.length === 1 ? rows[0]! : (rows.find((c) => c.name === "default") ?? null);
}

async function destroySandbox(deps: AgentsDeps, session: AgentSession, requestId: string): Promise<boolean> {
  const sandboxId = typeof session.sandbox.id === "string" ? session.sandbox.id : null;
  if (!sandboxId || !deps.providerKeys || !deps.sandboxes) return false;
  const connection = pickDaytona(await deps.repo.listConnections({ orgId: session.orgId }, "daytona"));
  if (!connection) return false;
  const apiKey = await deps.providerKeys.resolve(session.orgId, connection.secretRef, SWEEP_ACTOR, requestId);
  if (!apiKey) return false;
  const provider = deps.sandboxes("daytona", apiKey, connection.config);
  if (!provider) return false;
  await provider.destroy({ id: sandboxId, provider: "daytona" });
  return true;
}

export async function sweepLapsedSessions(
  deps: AgentsDeps,
  requestId: string,
  now: () => Date = () => new Date(),
): Promise<SweepSummary> {
  const t = now().getTime();
  const lapsed = await deps.repo.listLapsedSessions({
    leaseCutoff: new Date(t - LEASE_GRACE_MS).toISOString(),
    provisioningCutoff: new Date(t - PROVISIONING_STALL_MS).toISOString(),
    limit: SWEEP_BATCH,
  });

  const summary: SweepSummary = { examined: lapsed.length, reclaimed: 0, destroyed: 0, destroyErrors: 0 };
  for (const session of lapsed) {
    try {
      if (await destroySandbox(deps, session, requestId)) summary.destroyed++;
    } catch {
      // Over-destroy posture: the box may already be gone (provider TTL
      // reclaim), the account disconnected, or the key rotated. Reclaim anyway.
      summary.destroyErrors++;
    }
    try {
      await deps.repo.advanceSession(
        { orgId: session.orgId },
        {
          publicId: session.publicId,
          to: "failed",
          sandbox: { ...session.sandbox, error: "lease_lost" },
        },
      );
      summary.reclaimed++;
    } catch {
      // A racing transition (the runtime completed in the same tick) is fine —
      // the session reached a terminal state either way.
    }
  }
  return summary;
}
