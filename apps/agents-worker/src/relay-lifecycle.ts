// relay-lifecycle — lifecycle in the object (saas-agents-native AN3). The
// per-session relay DO arms a lease-lapse timer reset by every heartbeat and
// a retention timer at seal; this module is the timer's DECISION logic, kept
// pure-ish (deps-injected, no DO types) so jest drives it against the memory
// repository. The posture: the DO gains a timer, not authority — on fire it
// re-reads control-plane truth and, only if the lease really lapsed, walks
// the same reclaim path the backstop cron uses (`reclaimSession`, sweep.ts).

import type { AgentsDeps } from "./deps.js";
import { isTerminal } from "@saas/db/agents";
import { reclaimSession } from "./sweep.js";

/** Grace past the lease instant before the timer's reclaim — matches the
 * cron sweep's grace so a self-reported reclaim is never more aggressive
 * than the backstop's. */
export const RELAY_LEASE_GRACE_MS = 5 * 60 * 1000;

/** How long a sealed session's DO mirror is retained before the object
 * purges its own storage. The mirror is a projection — the DB event log and
 * the sealed snapshot in orun's graph carry everything durable. */
export const RELAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type LeaseLapseOutcome =
  | { outcome: "reclaimed" }
  | { outcome: "active"; rearmAt: string } // heartbeats resumed — re-arm
  | { outcome: "terminal" } // already sealed; nothing to do
  | { outcome: "gone" }; // no such session (control plane wins)

/**
 * reportLeaseLapse — the lease timer fired. Decide against DB truth:
 * a session whose lease (plus grace) is still in the future re-arms (a
 * heartbeat landed but the DO's timer wasn't the one it reset); a terminal
 * or missing session is left alone; a genuinely lapsed one is reclaimed via
 * the shared sweep path.
 */
export async function reportLeaseLapse(
  deps: AgentsDeps,
  orgId: string,
  sessionId: string,
  requestId: string,
  now: () => Date = () => new Date(),
): Promise<LeaseLapseOutcome> {
  const session = await deps.repo.getSession({ orgId }, sessionId);
  if (!session) return { outcome: "gone" };
  if (isTerminal(session.state)) return { outcome: "terminal" };
  const leaseMs = session.leaseExpiresAt ? new Date(session.leaseExpiresAt).getTime() : 0;
  const due = leaseMs + RELAY_LEASE_GRACE_MS;
  if (leaseMs > 0 && due > now().getTime()) {
    return { outcome: "active", rearmAt: new Date(due).toISOString() };
  }
  await reclaimSession(deps, session, requestId, "lease_lapsed(self-reported)");
  return { outcome: "reclaimed" };
}
