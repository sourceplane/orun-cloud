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
import { uuidToHex } from "@saas/db/ids";

/** Sessions carry the org UUID; logs use the public `org_<hex>` id (matching
 * the provision + runtime trace) so a boot can be followed across workers. */
function orgPublicId(orgUuid: string): string {
  return `org_${uuidToHex(orgUuid)}`;
}

/** Lease horizon: a session is reclaimed this long after its lease lapses
 * (one grace beat past the 15-min heartbeat chain). */
const LEASE_GRACE_MS = 5 * 60 * 1000;
/** A provisioning session that has not heartbeat within this never booted. */
const PROVISIONING_STALL_MS = 30 * 60 * 1000;
/** An orphan (live child of a terminal parent, AF4 §3.2) gets this grace —
 * enough for the runtime's own graceful shutdown to land first. */
const ORPHAN_GRACE_MS = 5 * 60 * 1000;
const SWEEP_BATCH = 50;

/** The sweep's synthetic actor — custody resolve is audit-stamped with it. */
const SWEEP_ACTOR: ActorContext = { subjectId: "agents-worker-sweep", subjectType: "service" };

export interface SweepSummary {
  examined: number;
  reclaimed: number;
  destroyed: number;
  destroyErrors: number;
  /** Orphans converged this tick (AF4). */
  orphaned: number;
}

function pickDaytona(rows: ProviderConnection[]): ProviderConnection | null {
  if (rows.length === 0) return null;
  // Sole-or-default like the spawn gate — but ANY status will do: destroying
  // with a later-invalidated key is still worth attempting.
  return rows.length === 1 ? rows[0]! : (rows.find((c) => c.name === "default") ?? null);
}

/** Best-effort sandbox destroy on the workspace's own provider account —
 * shared by the sweep and the AF4 tree kill (over-destroy on ambiguity). */
export async function destroySandbox(
  deps: AgentsDeps,
  session: AgentSession,
  requestId: string,
  actor: ActorContext = SWEEP_ACTOR,
): Promise<boolean> {
  const sandboxId = typeof session.sandbox.id === "string" ? session.sandbox.id : null;
  if (!sandboxId || !deps.providerKeys || !deps.sandboxes) return false;
  const connection = pickDaytona(await deps.repo.listConnections({ orgId: session.orgId }, "daytona"));
  if (!connection) return false;
  const apiKey = await deps.providerKeys.resolve(session.orgId, connection.secretRef, actor, requestId);
  if (!apiKey) return false;
  const provider = deps.sandboxes("daytona", apiKey, connection.config);
  if (!provider) return false;
  await provider.destroy({ id: sandboxId, provider: "daytona" });
  return true;
}

/**
 * reclaimSession — reclaim ONE lapsed session: best-effort sandbox destroy
 * (over-destroy on ambiguity), then the `failed(lease_lost)` terminal.
 * Shared by the backstop cron sweep and the per-session lease timer
 * (saas-agents-native AN3 — the relay DO reports its own lapse; this shared
 * path is where the control plane actually decides and destroys).
 */
export async function reclaimSession(
  deps: AgentsDeps,
  session: AgentSession,
  requestId: string,
  cause: string,
): Promise<{ destroyed: boolean; destroyError: boolean; reclaimed: boolean }> {
  // Name WHY each session was reclaimed: a `provisioning` session lapsing
  // means the runtime never dialed home (boot died before the first
  // heartbeat — the audit's blind spot); an active state means a live lease
  // simply expired. NEVER key material — ids + state + sandbox handle only.
  console.warn(
    `[agents-sweep] reclaim session=${session.publicId} org=${orgPublicId(session.orgId)} priorState=${session.state} cause=${cause} sandbox=${typeof session.sandbox.id === "string" ? session.sandbox.id : "none"}`,
  );
  const out = { destroyed: false, destroyError: false, reclaimed: false };
  try {
    if (await destroySandbox(deps, session, requestId)) out.destroyed = true;
  } catch {
    // Over-destroy posture: the box may already be gone (provider TTL
    // reclaim), the account disconnected, or the key rotated. Reclaim anyway.
    out.destroyError = true;
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
    out.reclaimed = true;
  } catch {
    // A racing transition (the runtime completed in the same tick) is fine —
    // the session reached a terminal state either way.
  }
  return out;
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

  const summary: SweepSummary = { examined: lapsed.length, reclaimed: 0, destroyed: 0, destroyErrors: 0, orphaned: 0 };
  for (const session of lapsed) {
    const r = await reclaimSession(
      deps,
      session,
      requestId,
      session.state === "provisioning" ? "never_booted" : "lease_lapsed",
    );
    if (r.destroyed) summary.destroyed++;
    if (r.destroyError) summary.destroyErrors++;
    if (r.reclaimed) summary.reclaimed++;
  }

  // The orphan pass (AF4 §3.2): a tree cannot outlive its root's intent. A
  // live child whose parent went terminal past grace is failed + destroyed —
  // the same over-destroy posture, the tree converges within two ticks.
  const orphans = await deps.repo.listOrphanedSessions({
    parentEndedCutoff: new Date(t - ORPHAN_GRACE_MS).toISOString(),
    limit: SWEEP_BATCH,
  });
  summary.examined += orphans.length;
  for (const session of orphans) {
    try {
      if (await destroySandbox(deps, session, requestId)) summary.destroyed++;
    } catch {
      summary.destroyErrors++;
    }
    try {
      await deps.repo.advanceSession(
        { orgId: session.orgId },
        {
          publicId: session.publicId,
          // suspended has no failed edge; canceled is its honest terminal.
          to: session.state === "suspended" ? "canceled" : "failed",
          sandbox: { ...session.sandbox, error: "orphaned" },
        },
      );
      summary.orphaned++;
    } catch {
      // Racing transition — terminal either way.
    }
  }
  return summary;
}
