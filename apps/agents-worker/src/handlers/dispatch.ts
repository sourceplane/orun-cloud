// Dispatch (saas-agents AG9, design §7.1–7.4): assignment → session, gated
// by the autonomy ladder and caps. This route is the ONE dispatch door — the
// Work-tab assignment hook, the (later) ES1 lane consumer, and "Dispatch all
// Ready" all re-enter here, so every autonomous spawn passes the same checks:
//
//   1. autonomy ≥ auto-dispatch (workspace default, spec override wins);
//   2. under the concurrency cap (active sessions < caps.maxConcurrent);
//   3. no live session already working the task (dedupe — dispatch twice,
//      get the same run, not two).
//
// A dispatch never writes work truth: the session it spawns produces the
// evidence; the fold derives the rung.

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import type { AgentSession } from "@saas/db/agents";
import { errorResponse, successResponse, validationError } from "../http.js";
import { toPublicSession } from "../mappers.js";
import { handleProvisionSession } from "./provision.js";

const ACTIVE_STATES = ["requested", "provisioning", "running", "awaiting_approval"] as const;
const DEFAULT_MAX_CONCURRENT = 3;

function isActive(s: AgentSession): boolean {
  return (ACTIVE_STATES as readonly string[]).includes(s.state);
}

export async function handleDispatch(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.session.create", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["invalid JSON"] });
  }
  const b = body as Record<string, unknown>;
  if (typeof b.taskKey !== "string" || !b.taskKey) {
    return validationError(requestId, { taskKey: ["required"] });
  }
  const taskKey = b.taskKey;
  const specKey = typeof b.specKey === "string" && b.specKey ? b.specKey : undefined;

  // Gate 1 — the autonomy ladder: the spec override wins over the workspace
  // default; anything below auto-dispatch refuses (a human spawns manually).
  const policy = (specKey ? await deps.repo.getAutonomy({ orgId }, specKey) : null) ??
    (await deps.repo.getAutonomy({ orgId }));
  const level = policy?.level ?? "assist";
  if (level !== "auto-dispatch" && level !== "full") {
    return errorResponse(
      "conflict",
      `Autonomy level is ${level}; dispatch needs auto-dispatch or full`,
      409,
      requestId,
    );
  }

  const sessions = await deps.repo.listSessions({ orgId });
  const active = sessions.filter(isActive);

  // Gate 2 — dedupe: one live run per task.
  const existing = active.find((s) => s.taskKey === taskKey);
  if (existing) {
    return errorResponse(
      "conflict",
      `Session ${existing.publicId} is already working ${taskKey}`,
      409,
      requestId,
    );
  }

  // Gate 3 — the workspace concurrency cap.
  const rawCap = policy?.caps?.maxConcurrent;
  const cap = typeof rawCap === "number" && rawCap > 0 ? rawCap : DEFAULT_MAX_CONCURRENT;
  if (active.length >= cap) {
    return errorResponse(
      "conflict",
      `Concurrency cap reached (${active.length}/${cap} active sessions)`,
      409,
      requestId,
    );
  }

  // Profile: explicit, or the sole one, or the impl-default convention.
  const profiles = await deps.repo.listProfiles({ orgId });
  const profile =
    (typeof b.profileId === "string" ? profiles.find((p) => p.publicId === b.profileId) : undefined) ??
    (profiles.length === 1 ? profiles[0] : profiles.find((p) => p.name === "impl-default"));
  if (!profile) {
    return errorResponse(
      "agent_profile_not_found",
      "No dispatchable profile: pass profileId, or create one named impl-default",
      404,
      requestId,
    );
  }

  const session = await deps.repo.createSession(
    { orgId },
    {
      profileId: profile.publicId,
      runKind: "implementation",
      spawnedBy: actor.subjectId,
      taskKey,
      ...(specKey ? { workRef: `work://${orgId}/${specKey}` } : {}),
    },
  );

  // Boot it. A spawn-gate refusal (providers unverified) leaves the session
  // requested — dispatched-but-parked, surfaced in the payload, retryable.
  const provision = await handleProvisionSession(deps, orgId, session.publicId, actor, requestId);
  if (provision.ok) {
    const provisioned = (await provision.json()) as { data: unknown };
    return successResponse({ session: provisioned.data, dispatched: true, provisioned: true }, requestId, 201);
  }
  const gate = (await provision.json()) as { error?: { message?: string } };
  const current = await deps.repo.getSession({ orgId }, session.publicId);
  return successResponse(
    {
      session: toPublicSession(current ?? session),
      dispatched: true,
      provisioned: false,
      gate: gate.error?.message ?? "provisioning refused",
    },
    requestId,
    201,
  );
}
