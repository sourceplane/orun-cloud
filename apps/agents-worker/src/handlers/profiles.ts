// Agent-profile control-plane handlers (saas-agents AG6). A profile binds an
// orun agent type to a service principal with a mandatory responsible owner.

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import { AgentsError, isDelegationInterface } from "@saas/db/agents";
import { errorResponse, listResponse, successResponse, validationError } from "../http.js";
import { toPublicProfile } from "../mappers.js";

export async function handleListProfiles(
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.profile.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const rows = await deps.repo.listProfiles({ orgId });
  return listResponse(rows.map(toPublicProfile), requestId, null);
}

export async function handleCreateProfile(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
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
  const missing: Record<string, string[]> = {};
  for (const field of ["name", "principalId", "owner", "agentType", "harness", "model"]) {
    if (typeof b[field] !== "string" || !b[field]) missing[field] = ["required"];
  }
  // DX7: the delegation interface is a closed vocabulary; junk refuses loud.
  if (b.interface !== undefined && (typeof b.interface !== "string" || !isDelegationInterface(b.interface))) {
    missing.interface = ["one of orun-sandbox, anthropic-managed"];
  }
  if (Object.keys(missing).length > 0) return validationError(requestId, missing);

  try {
    const profile = await deps.repo.createProfile(
      { orgId },
      {
        name: b.name as string,
        principalId: b.principalId as string,
        owner: b.owner as string,
        agentType: b.agentType as string,
        harness: b.harness as string,
        model: b.model as string,
        ...(typeof b.interface === "string" && isDelegationInterface(b.interface)
          ? { interface: b.interface }
          : {}),
        ...(typeof b.autonomyDefault === "string" ? { autonomyDefault: b.autonomyDefault as never } : {}),
        // The capability ceiling (narrowing-only): the managed interface's
        // no-ask gate reads capability.tools at provision time.
        ...(typeof b.capability === "object" && b.capability !== null
          ? { capability: b.capability as Record<string, unknown> }
          : {}),
      },
    );
    return successResponse(toPublicProfile(profile), requestId, 201);
  } catch (e) {
    if (e instanceof AgentsError) {
      const status = e.code.endsWith("conflict") ? 409 : 400;
      return errorResponse(e.code, e.message, status, requestId);
    }
    throw e;
  }
}
