// Map the db-layer agent rows to the public wire shapes (@saas/contracts/agents).
// Safe projections only — no secret values, no raw transcript bytes.

import type {
  AgentProfile as DbProfile,
  AgentSession as DbSession,
  Routine as DbRoutine,
  SessionEvent as DbSessionEvent,
} from "@saas/db/agents";
import type {
  AgentProfile,
  AgentRoutine,
  AgentSession,
  AgentSessionEventWire,
} from "@saas/contracts/agents";

export function toPublicProfile(p: DbProfile): AgentProfile {
  return {
    id: p.publicId,
    name: p.name,
    principalId: p.principalId,
    owner: p.owner,
    agentType: p.agentType,
    harness: p.harness,
    model: p.model,
    autonomyDefault: p.autonomyDefault,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function toPublicSession(s: DbSession): AgentSession {
  const out: AgentSession = {
    id: s.publicId,
    profileId: s.profileId,
    runKind: s.runKind,
    state: s.state,
    spawnedBy: s.spawnedBy,
    createdAt: s.createdAt,
  };
  if (s.workRef !== undefined) out.workRef = s.workRef;
  if (s.taskKey !== undefined) out.taskKey = s.taskKey;
  // The one sandbox field that surfaces: the (already-redacted) failure
  // reason — lease_lost, "503 from provider" — never ids or key material.
  if (typeof s.sandbox.error === "string" && s.sandbox.error) out.failureReason = s.sandbox.error;
  if (s.prUrl !== undefined) out.prUrl = s.prUrl;
  if (s.snapshotId !== undefined) out.snapshotId = s.snapshotId;
  if (s.startedAt !== undefined) out.startedAt = s.startedAt;
  if (s.endedAt !== undefined) out.endedAt = s.endedAt;
  // Delegation tree (AF4) — public-id keyed, safe to surface verbatim.
  if (s.parentSessionId !== undefined) out.parentSessionId = s.parentSessionId;
  out.rootSessionId = s.rootSessionId;
  out.depth = s.depth;
  // Routine provenance (AF6) — fleet grouping + park math.
  if (s.routineId !== undefined) out.routineId = s.routineId;
  return out;
}

export function toPublicRoutine(r: DbRoutine): AgentRoutine {
  const out: AgentRoutine = {
    id: r.publicId,
    name: r.name,
    profileId: r.profileId,
    runKind: r.runKind,
    triggerKind: r.triggerKind,
    triggerConfig: r.triggerConfig,
    caps: r.caps,
    enabled: r.enabled,
    parked: r.parked,
    consecutiveFailures: r.consecutiveFailures,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  if (r.definitionRef !== undefined) out.definitionRef = r.definitionRef;
  if (r.parkedReason !== undefined) out.parkedReason = r.parkedReason;
  if (r.lastFiredAt !== undefined) out.lastFiredAt = r.lastFiredAt;
  return out;
}

export function toPublicEvent(e: DbSessionEvent): AgentSessionEventWire {
  const out: AgentSessionEventWire = {
    seq: e.seq,
    kind: e.kind,
    at: e.at,
    payload: e.payload,
  };
  if (e.ref !== undefined) out.ref = e.ref;
  return out;
}
