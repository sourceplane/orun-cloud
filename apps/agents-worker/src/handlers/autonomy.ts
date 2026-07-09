// Autonomy policy routes (saas-agents AG9, design §7.3): the workspace's
// dial from "agents only act when a human clicks" to "assignment dispatches
// autonomously" — per workspace, overridable per spec. The ladder
// (manual → assist → auto-dispatch → full) and caps are POLICY, stored here;
// the dispatch gate (dispatch.ts) is the only reader that acts on them.

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import { AUTONOMY_LEVELS, type AutonomyLevel } from "@saas/db/agents";
import { errorResponse, successResponse, validationError } from "../http.js";

export async function handleGetAutonomy(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.autonomy.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const url = new URL(request.url);
  const specKey = url.searchParams.get("spec") ?? undefined;
  const policy = await deps.repo.getAutonomy({ orgId }, specKey);
  // The workspace default backs any unset spec policy; both surfaced so the
  // console can render "inherited" honestly.
  const workspace = specKey ? await deps.repo.getAutonomy({ orgId }) : policy;
  return successResponse(
    {
      policy,
      workspaceDefault: workspace,
      effectiveLevel: policy?.level ?? workspace?.level ?? "assist",
    },
    requestId,
  );
}

export async function handleSetAutonomy(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.autonomy.write", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["invalid JSON"] });
  }
  const b = body as Record<string, unknown>;
  if (typeof b.level !== "string" || !(AUTONOMY_LEVELS as readonly string[]).includes(b.level)) {
    return validationError(requestId, { level: [`one of ${AUTONOMY_LEVELS.join(", ")}`] });
  }
  const policy = await deps.repo.setAutonomy(
    { orgId },
    {
      level: b.level as AutonomyLevel,
      ...(typeof b.specKey === "string" && b.specKey ? { specKey: b.specKey } : {}),
      ...(typeof b.caps === "object" && b.caps !== null ? { caps: b.caps as Record<string, unknown> } : {}),
    },
  );
  return successResponse(policy, requestId);
}
