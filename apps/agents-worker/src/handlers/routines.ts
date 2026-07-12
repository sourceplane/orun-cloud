// Routine registry routes (saas-agents-fleet AF6, design §5.1): the standing
// trigger + binding rows. A routine only ever SPAWNS sessions — the scheduler
// tick fires it through the AG9 dispatch door — so these handlers are pure
// configuration CRUD. Definition and trigger are immutable after create (the
// sealed-definition posture); the PATCH surface is standing state only:
// enable/disable and RESUME (parking is automatic, resuming is human).

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import { AgentsError, RUN_KINDS, ROUTINE_TRIGGER_KINDS, type RoutineTriggerKind, type RunKind } from "@saas/db/agents";
import { errorResponse, listResponse, notFound, successResponse, validationError } from "../http.js";
import { toPublicRoutine } from "../mappers.js";
import { isHourlyOrCoarser, parseCron } from "../cron.js";

export async function handleListRoutines(
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.routine.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const rows = await deps.repo.listRoutines({ orgId });
  return listResponse(rows.map(toPublicRoutine), requestId, null);
}

export async function handleCreateRoutine(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.routine.write", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["invalid JSON"] });
  }
  const b = body as Record<string, unknown>;
  const invalid: Record<string, string[]> = {};
  if (typeof b.name !== "string" || !b.name) invalid.name = ["required"];
  if (typeof b.profileId !== "string" || !b.profileId) invalid.profileId = ["required"];
  if (typeof b.runKind !== "string" || !(RUN_KINDS as readonly string[]).includes(b.runKind)) {
    invalid.runKind = [`one of ${RUN_KINDS.join(", ")}`];
  }
  if (
    typeof b.triggerKind !== "string" ||
    !(ROUTINE_TRIGGER_KINDS as readonly string[]).includes(b.triggerKind)
  ) {
    invalid.triggerKind = [`one of ${ROUTINE_TRIGGER_KINDS.join(", ")}`];
  }
  const triggerConfig =
    typeof b.triggerConfig === "object" && b.triggerConfig !== null
      ? (b.triggerConfig as Record<string, unknown>)
      : {};
  if (b.triggerKind === "cron") {
    const expr = typeof triggerConfig.cron === "string" ? triggerConfig.cron : "";
    const spec = expr ? parseCron(expr) : null;
    if (!spec) {
      invalid.triggerConfig = ["cron: a valid 5-field expression is required"];
    } else if (!isHourlyOrCoarser(spec)) {
      // The product floor (design §5.1): a routine may fire at most hourly.
      invalid.triggerConfig = ["cron: minimum interval is hourly (pin one minute value)"];
    }
  }
  if (Object.keys(invalid).length > 0) return validationError(requestId, invalid);

  try {
    const routine = await deps.repo.createRoutine(
      { orgId },
      {
        name: b.name as string,
        profileId: b.profileId as string,
        runKind: b.runKind as RunKind,
        triggerKind: b.triggerKind as RoutineTriggerKind,
        triggerConfig,
        // Not the UUID-column bug class: routines.created_by is TEXT and
        // stores the public membership subject (like sessions' spawned_by).
        // eslint-disable-next-line no-restricted-syntax
        createdBy: actor.subjectId,
        ...(typeof b.definitionRef === "string" && b.definitionRef ? { definitionRef: b.definitionRef } : {}),
        ...(typeof b.caps === "object" && b.caps !== null ? { caps: b.caps as Record<string, unknown> } : {}),
      },
    );
    return successResponse(toPublicRoutine(routine), requestId, 201);
  } catch (e) {
    if (e instanceof AgentsError) {
      const status =
        e.code === "agent_profile_not_found" ? 404 : e.code === "agent_routine_conflict" ? 409 : 422;
      return errorResponse(e.code, e.message, status, requestId);
    }
    throw e;
  }
}

export async function handleUpdateRoutine(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  routineId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.routine.write", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["invalid JSON"] });
  }
  const b = body as Record<string, unknown>;
  if (b.enabled === undefined && b.parked === undefined) {
    return validationError(requestId, { body: ["one of enabled, parked required"] });
  }
  if (b.parked === true) {
    // Parking is automatic (the tick's failure latch); a human can only
    // RESUME — the asymmetry that keeps the latch honest.
    return validationError(requestId, { parked: ["only false (resume) is accepted"] });
  }
  try {
    const routine = await deps.repo.updateRoutineState(
      { orgId },
      {
        publicId: routineId,
        ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
        // Resume resets the latch AND the failure count — a fresh start.
        ...(b.parked === false ? { parked: false, parkedReason: null, consecutiveFailures: 0 } : {}),
      },
    );
    return successResponse(toPublicRoutine(routine), requestId);
  } catch (e) {
    if (e instanceof AgentsError && e.code === "agent_routine_not_found") {
      return notFound(requestId, routineId);
    }
    throw e;
  }
}

export async function handleDeleteRoutine(
  deps: AgentsDeps,
  orgId: string,
  routineId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.routine.write", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const deleted = await deps.repo.deleteRoutine({ orgId }, routineId);
  if (!deleted) return notFound(requestId, routineId);
  return successResponse({ deleted: true }, requestId);
}
