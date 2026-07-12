// Budget routes (saas-agents-fleet AF8, design §7): the ceilings registry.
// Configuration only — enforcement lives at the door (dispatch/spawn) and at
// ingest (the graceful interrupt); the 80% marks surface on the attention
// fold. Human-scale CRUD, deny-by-default like every agents surface.

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import { AgentsError, BUDGET_GRAINS, type BudgetGrain, type Budget } from "@saas/db/agents";
import { errorResponse, listResponse, notFound, successResponse, validationError } from "../http.js";
import type { AgentBudget } from "@saas/contracts/agents";

function toPublicBudget(b: Budget): AgentBudget {
  return {
    id: b.publicId,
    grain: b.grain,
    maxTokens: b.maxTokens,
    createdBy: b.createdBy,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    ...(b.ref !== undefined ? { ref: b.ref } : {}),
  };
}

export async function handleListBudgets(
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.budget.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const rows = await deps.repo.listBudgets({ orgId });
  return listResponse(rows.map(toPublicBudget), requestId, null);
}

export async function handleSetBudget(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.budget.write", orgId, actor, requestId))) {
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
  if (typeof b.grain !== "string" || !(BUDGET_GRAINS as readonly string[]).includes(b.grain)) {
    invalid.grain = [`one of ${BUDGET_GRAINS.join(", ")}`];
  }
  if (typeof b.maxTokens !== "number" || !Number.isFinite(b.maxTokens) || b.maxTokens <= 0) {
    invalid.maxTokens = ["a positive number of tokens"];
  }
  if (b.grain === "routine" && (typeof b.ref !== "string" || !b.ref)) {
    invalid.ref = ["routine budgets pin a routine public id"];
  }
  if (b.grain !== "routine" && b.ref !== undefined) {
    invalid.ref = ["only routine budgets take a ref (other grains are org defaults)"];
  }
  if (Object.keys(invalid).length > 0) return validationError(requestId, invalid);

  try {
    const budget = await deps.repo.setBudget(
      { orgId },
      {
        grain: b.grain as BudgetGrain,
        maxTokens: b.maxTokens as number,
        // Not the UUID-column bug class: budgets.created_by is TEXT and
        // stores the public membership subject (like sessions' spawned_by).
        // eslint-disable-next-line no-restricted-syntax
        createdBy: actor.subjectId,
        ...(typeof b.ref === "string" && b.ref ? { ref: b.ref } : {}),
      },
    );
    return successResponse(toPublicBudget(budget), requestId);
  } catch (e) {
    if (e instanceof AgentsError) {
      return errorResponse(e.code, e.message, 422, requestId);
    }
    throw e;
  }
}

export async function handleDeleteBudget(
  deps: AgentsDeps,
  orgId: string,
  budgetId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.budget.write", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const deleted = await deps.repo.deleteBudget({ orgId }, budgetId);
  if (!deleted) return notFound(requestId, budgetId);
  return successResponse({ deleted: true }, requestId);
}
