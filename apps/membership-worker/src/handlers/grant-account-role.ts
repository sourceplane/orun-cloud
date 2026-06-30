import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { asUuid } from "@saas/db/ids";
import { ACCOUNT_ROLES } from "@saas/contracts/membership";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId } from "../ids.js";

export interface GrantAccountRoleDeps {
  repo: Pick<
    MembershipRepository,
    "getOrganizationById" | "listRoleAssignments" | "createRoleAssignment"
  >;
  now?: () => Date;
  generateId?: () => string;
}

/**
 * Grant an account-scoped role (saas-workspace-id WID6 — design §8.2).
 *
 * The role is written to membership.role_assignments on the ACCOUNT org (the
 * parent, or the org itself if it is the account root) with scope_kind='account'.
 * It then cascades — via the authorization-context assembly + the policy engine's
 * account-role catalog — to authority on every workspace under the account, with
 * no per-workspace rows.
 *
 * Gate: only an actor who is account_owner/account_admin on the account (or an
 * organization `owner` of the account org) may grant. This is enforced by the
 * existing policy check (`organization.member.update_role`) evaluated against the
 * actor's role assignments ON THE ACCOUNT ORG — a workspace-only admin holds no
 * role on the account, so the check denies them.
 */
export async function handleGrantAccountRole(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: GrantAccountRoleDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }
  if (!env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be an object"] });
  }

  const { role, subjectId } = body as { role?: unknown; subjectId?: unknown };
  if (typeof role !== "string" || !(ACCOUNT_ROLES as readonly string[]).includes(role)) {
    return validationError(requestId, { role: ["Must be a valid account role"] });
  }
  if (typeof subjectId !== "string" || subjectId.length === 0) {
    return validationError(requestId, { subjectId: ["Required"] });
  }

  const policyWorker = env.POLICY_WORKER;
  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);

    // Resolve the account org: account roles live on the account (parent) org.
    const orgResult = await repo.getOrganizationById(orgUuid);
    if (!orgResult.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    const accountUuid = asUuid(effectiveBillingOrgId(orgResult.value));

    // Authorize the actor against the ACCOUNT org. Listing the actor's role
    // assignments on the account org means a workspace-only admin (whose role is
    // on a child) surfaces no relevant fact and is denied; an account_admin /
    // account_owner / org owner of the account is allowed.
    const actorRoles = await repo.listRoleAssignments(accountUuid, actor.subjectId);
    if (!actorRoles.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const authResult = await authorizeViaPolicy(policyWorker, {
      actor,
      action: "organization.member.update_role",
      resource: { kind: "organization", id: accountUuid, orgId: accountUuid },
      orgId: accountUuid,
      roleAssignments: actorRoles.value,
      requestId,
    });
    if (!authResult.allow) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());

    const created = await repo.createRoleAssignment({
      id: genId(),
      orgId: accountUuid,
      subjectId,
      subjectType: "user",
      role,
      scopeKind: "account",
      createdAt: now,
    });
    if (!created.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    return successResponse(
      {
        assignment: {
          subjectId,
          role: created.value.role,
          scopeKind: created.value.scopeKind,
        },
      },
      requestId,
      201,
    );
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
