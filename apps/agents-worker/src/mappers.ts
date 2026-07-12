// Map the db-layer agent rows to the public wire shapes (@saas/contracts/agents).
// Safe projections only — no secret values, no raw transcript bytes.

import type {
  AgentProfile as DbProfile,
  AgentSession as DbSession,
  SessionEvent as DbSessionEvent,
} from "@saas/db/agents";
import type {
  AgentProfile,
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
