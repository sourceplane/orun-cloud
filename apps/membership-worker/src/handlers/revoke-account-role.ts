import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { asUuid } from "@saas/db/ids";
import { ACCOUNT_ROLES } from "@saas/contracts/membership";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId } from "../ids.js";

export interface RevokeAccountRoleDeps {
  repo: Pick<
    MembershipRepository,
    "getOrganizationById" | "listRoleAssignments" | "revokeAccountRole"
  >;
  /** Optional audit sink; a successful revoke emits `account.role.revoked`. */
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
}

/**
 * DELETE /v1/organizations/{orgId}/account-roles — revoke a user's
 * account-scoped role (teams-hub TH1a; closes the revoke half WID6 deferred).
 * Identified by its (subjectId, role) tuple in the body, mirroring the
 * team-grant revoke shape.
 *
 * Gate: the same authority as the grant path — `organization.member.update_role`
 * evaluated against the actor's roles ON THE ACCOUNT ORG. Team account grants
 * are NOT revocable here; they go through DELETE /team-roles.
 *
 * No last-owner guard: the account org's organization-scope `owner` (counted by
 * the org-member machinery) remains the ultimate authority even with every
 * account_* role revoked, so this cannot lock an account out.
 */
export async function handleRevokeAccountRole(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: RevokeAccountRoleDeps,
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

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);

    const orgResult = await repo.getOrganizationById(orgUuid);
    if (!orgResult.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    const accountUuid = asUuid(effectiveBillingOrgId(orgResult.value));

    const actorRoles = await repo.listRoleAssignments(accountUuid, actor.subjectId);
    if (!actorRoles.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    const authResult = await authorizeViaPolicy(env.POLICY_WORKER, {
      actor,
      action: "organization.member.update_role",
      resource: { kind: "organization", id: accountUuid, orgId: accountUuid },
      orgId: accountUuid,
      roleAssignments: actorRoles.value,
      requestId,
    });
    if (!authResult.allow) {
      // Deny-by-default; do not disclose the resource.
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const now = deps?.now ? deps.now() : new Date();
    const revoked = await repo.revokeAccountRole(accountUuid, subjectId, role, now);
    if (!revoked.ok) {
      if (revoked.error.kind === "not_found") {
        return errorResponse("not_found", "Grant not found", 404, requestId);
      }
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    // Audit the revoke. Best-effort: an audit-append failure must not fail an
    // already-committed revoke.
    const genId = deps?.generateId ?? (() => crypto.randomUUID());
    const eventsRepo = deps?.eventsRepo ?? (executor ? createEventsRepository(executor) : null);
    if (eventsRepo) {
      await eventsRepo.appendEventWithAudit({
        event: {
          id: genId(), type: "account.role.revoked", version: 1, source: "membership-worker",
          occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
          orgId: accountUuid, subjectKind: "subject", subjectId,
          requestId, payload: { subjectId, role, scopeKind: "account" },
        },
        audit: { id: genId(), category: "membership", description: `Account role ${role} revoked from ${subjectId}` },
      }).catch(() => { /* best-effort */ });
    }

    return successResponse(
      { assignment: { subjectId, role, scopeKind: "account", revoked: true } },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
