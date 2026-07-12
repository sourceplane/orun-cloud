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
import { checkDoor } from "../budget.js";
import { uuidToHex } from "@saas/db/ids";

/** Public `org_<hex>` id for the work:// provenance ref (the scope orgId is
 * the UUID; the ref points at the console's public-id-keyed work item). */
function orgPublicId(orgUuid: string): string {
  return `org_${uuidToHex(orgUuid)}`;
}

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
  // Two provenances, ONE door (design §5.2): a task dispatch (the ladder
  // gates it) or a routine firing (the standing human authorization gates
  // it). Both share entitlement, dedupe, and the concurrency cap.
  const routineId = typeof b.routineId === "string" && b.routineId ? b.routineId : undefined;
  if (!routineId && (typeof b.taskKey !== "string" || !b.taskKey)) {
    return validationError(requestId, { taskKey: ["required (or routineId)"] });
  }
  const taskKey = typeof b.taskKey === "string" && b.taskKey ? b.taskKey : undefined;
  const specKey = typeof b.specKey === "string" && b.specKey ? b.specKey : undefined;

  // Gate 0 — the feature.agents entitlement (AG10 §8, D3-open: only an
  // explicit plan disable refuses; the deny carries the upgrade path).
  if (deps.entitlement) {
    const gate = await deps.entitlement(orgId, requestId);
    if (gate.kind === "deny") {
      return errorResponse("forbidden", gate.message, 403, requestId);
    }
  }

  // Gate 0.5 — the budget door (AF8): an exhausted envelope refuses loud
  // before anything spawns. Ceilings, not advisories.
  {
    const [budgets, sessions] = await Promise.all([
      deps.repo.listBudgets({ orgId }),
      deps.repo.listSessions({ orgId }),
    ]);
    const refusal = checkDoor(budgets, sessions, {}, new Date());
    if (refusal) return errorResponse(refusal.code, refusal.message, 409, requestId);
  }

  if (routineId) return dispatchRoutineFiring(deps, orgId, routineId, actor, requestId);

  if (!taskKey) return validationError(requestId, { taskKey: ["required"] });

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
      ...(specKey ? { workRef: `work://${orgPublicId(orgId)}/${specKey}` } : {}),
    },
  );

  // Boot it. A spawn-gate refusal (providers unverified) leaves the session
  // requested — dispatched-but-parked, surfaced in the payload, retryable.
  return bootDispatchedSession(deps, orgId, session, actor, requestId);
}

/** Shared boot tail for both provenances: provision, or park honestly. */
async function bootDispatchedSession(
  deps: AgentsDeps,
  orgId: string,
  session: AgentSession,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
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

/**
 * A routine firing (saas-agents-fleet AF6, design §5.2). The ladder does not
 * gate it — the standing human authorization is the routine row itself
 * (enabled, unparked); what remains are the shared mechanical gates: one
 * live run per routine, and the workspace concurrency cap. Exported for the
 * scheduler tick, which enters below the HTTP authorize (the sweep posture:
 * an internal maintenance path acting on a human-authorized standing order).
 */
export async function dispatchRoutineFiring(
  deps: AgentsDeps,
  orgId: string,
  routineId: string,
  actor: ActorContext,
  requestId: string,
  now: () => Date = () => new Date(),
): Promise<Response> {
  const scope = { orgId };
  const routine = await deps.repo.getRoutine(scope, routineId);
  if (!routine) {
    return errorResponse("agent_routine_not_found", `Routine ${routineId} not found`, 404, requestId);
  }
  if (!routine.enabled || routine.parked) {
    return errorResponse(
      "agent_routine_not_live",
      routine.parked
        ? `Routine is parked (${routine.parkedReason ?? "repeated failures"}); resume it first`
        : "Routine is disabled",
      409,
      requestId,
    );
  }

  const sessions = await deps.repo.listSessions(scope);
  const active = sessions.filter(isActive);

  // Dedupe — one live run per routine (the task-dedupe idiom).
  const existing = active.find((s) => s.routineId === routine.publicId);
  if (existing) {
    return errorResponse(
      "conflict",
      `Session ${existing.publicId} is already running routine ${routine.name}`,
      409,
      requestId,
    );
  }

  // The workspace concurrency cap, shared with task dispatch.
  const policy = await deps.repo.getAutonomy(scope);
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

  const session = await deps.repo.createSession(scope, {
    profileId: routine.profileId,
    runKind: routine.runKind,
    spawnedBy: actor.subjectId,
    routineId: routine.publicId,
    workRef: `work://${orgPublicId(orgId)}/routine/${routine.name}`,
  });
  // The firing mark moves regardless of how the session ends — misfire
  // semantics key off it (fire once on recovery, never a backlog).
  await deps.repo.updateRoutineState(scope, {
    publicId: routine.publicId,
    lastFiredAt: now().toISOString(),
  });

  return bootDispatchedSession(deps, orgId, session, actor, requestId);
}
