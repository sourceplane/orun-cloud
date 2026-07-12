// The records read + the human-ack autonomy movement (saas-agents-fleet
// AF7, design §6). GET /agents/records computes every profile's track
// record + promotion assessment on read; PATCH /agents/profiles/{id} is the
// ONLY way any autonomy level moves up — human-acked, with the
// server-computed record attached as evidence. No agent identity can reach
// it: the human-only guard is structural, before the policy check, so no
// grant misconfiguration can open a self-promotion path (locked decision 5).

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import type { AgentSession, SessionEvent } from "@saas/db/agents";
import { AGENT_AUTONOMY_LEVELS, assessPromotion, PROMOTION_BAR_DEFAULTS, type AgentAutonomyLevel, type AgentRecordsEntry, type PromotionBar } from "@saas/contracts/agents";
import { AgentsError } from "@saas/db/agents";
import { errorResponse, listResponse, successResponse, validationError } from "../http.js";
import { computeRecord, RECORD_EVENT_SAMPLE } from "../record.js";
import { toPublicProfile } from "../mappers.js";

/** The workspace bar: caps.promotionBar on the workspace autonomy policy
 * overrides the shipped defaults (F-Q4). */
function resolveBar(caps: Record<string, unknown> | undefined): PromotionBar {
  const raw = caps?.promotionBar;
  if (typeof raw !== "object" || raw === null) return PROMOTION_BAR_DEFAULTS;
  const b = raw as Record<string, unknown>;
  return {
    minSessions:
      typeof b.minSessions === "number" && b.minSessions > 0
        ? b.minSessions
        : PROMOTION_BAR_DEFAULTS.minSessions,
    minCompletionRate:
      typeof b.minCompletionRate === "number" && b.minCompletionRate > 0 && b.minCompletionRate <= 1
        ? b.minCompletionRate
        : PROMOTION_BAR_DEFAULTS.minCompletionRate,
  };
}

async function recordFor(
  deps: AgentsDeps,
  orgId: string,
  profileInternalId: string,
  profilePublicId: string,
  allSessions: AgentSession[],
) {
  const scope = { orgId };
  const sessions = allSessions.filter((s) => s.profileId === profileInternalId);
  const eventsBySession = new Map<string, SessionEvent[]>();
  for (const s of sessions.slice(0, RECORD_EVENT_SAMPLE)) {
    eventsBySession.set(s.publicId, await deps.repo.listSessionEvents(scope, s.publicId));
  }
  return computeRecord(profilePublicId, sessions, eventsBySession);
}

export async function handleListRecords(
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.profile.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const scope = { orgId };
  const [profiles, sessions, policy] = await Promise.all([
    deps.repo.listProfiles(scope),
    deps.repo.listSessions(scope),
    deps.repo.getAutonomy(scope),
  ]);
  const bar = resolveBar(policy?.caps);
  const entries: AgentRecordsEntry[] = [];
  for (const p of profiles) {
    const record = await recordFor(deps, orgId, p.id, p.publicId, sessions);
    entries.push({
      profileId: p.publicId,
      autonomyDefault: p.autonomyDefault,
      record,
      promotion: assessPromotion(record, p.autonomyDefault, bar),
    });
  }
  return listResponse(entries, requestId, null);
}

/**
 * PATCH /agents/profiles/{id} — the human ack. Upward movement recomputes
 * the record server-side and stores it as the movement's evidence; downward
 * movement by a human is allowed (tightening never needs evidence). The
 * ladder index decides direction.
 */
export async function handleSetProfileAutonomy(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  profileId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  // STRUCTURAL human-only guard, before policy: an agent-session bearer or
  // a service principal can never move a leash — not its own, not another
  // profile's — regardless of what grants exist (design §6.2).
  if (actor.agentSessionId || actor.subjectType === "service_principal") {
    return errorResponse(
      "agent_autonomy_self_service",
      "Autonomy levels move only on a human's ack",
      403,
      requestId,
    );
  }
  if (!(await deps.authorize("organization.agent.profile.write", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["invalid JSON"] });
  }
  const b = body as Record<string, unknown>;
  if (
    typeof b.autonomyDefault !== "string" ||
    !(AGENT_AUTONOMY_LEVELS as readonly string[]).includes(b.autonomyDefault)
  ) {
    return validationError(requestId, { autonomyDefault: [`one of ${AGENT_AUTONOMY_LEVELS.join(", ")}`] });
  }
  const to = b.autonomyDefault as AgentAutonomyLevel;

  const scope = { orgId };
  const profiles = await deps.repo.listProfiles(scope);
  const profile = profiles.find((p) => p.publicId === profileId || p.id === profileId);
  if (!profile) {
    return errorResponse("agent_profile_not_found", `profile ${profileId} not found`, 404, requestId);
  }
  const from = profile.autonomyDefault;
  if (from === to) {
    return successResponse(toPublicProfile(profile), requestId);
  }
  const promoted =
    (AGENT_AUTONOMY_LEVELS as readonly string[]).indexOf(to) >
    (AGENT_AUTONOMY_LEVELS as readonly string[]).indexOf(from);

  // Evidence is server-derived — the record at the moment of the ack, never
  // a client-supplied claim.
  const evidence: Record<string, unknown> = {
    direction: promoted ? "promoted" : "demoted",
    from,
    to,
    by: actor.subjectId,
    at: new Date().toISOString(),
  };
  if (promoted) {
    const sessions = await deps.repo.listSessions(scope);
    evidence.record = await recordFor(deps, orgId, profile.id, profile.publicId, sessions);
  } else {
    evidence.trigger = "human";
  }

  try {
    const updated = await deps.repo.setProfileAutonomy(scope, {
      publicId: profile.publicId,
      autonomyDefault: to,
      evidence,
    });
    return successResponse(toPublicProfile(updated), requestId);
  } catch (e) {
    if (e instanceof AgentsError && e.code === "agent_profile_not_found") {
      return errorResponse(e.code, e.message, 404, requestId);
    }
    throw e;
  }
}
