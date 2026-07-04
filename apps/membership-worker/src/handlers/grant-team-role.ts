import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { asUuid } from "@saas/db/ids";
import { ACCOUNT_ROLES, ORGANIZATION_ROLES } from "@saas/contracts/membership";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, parseTeamPublicId } from "../ids.js";

const PROJECT_ROLES = ["project_admin", "project_builder", "project_viewer"] as const;
const SCOPE_KINDS = new Set(["account", "organization", "project"]);

export interface GrantTeamRoleDeps {
  repo: Pick<
    MembershipRepository,
    "getOrganizationById" | "getTeamById" | "listRoleAssignments" | "createRoleAssignment"
  >;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
}

/**
 * Grant a Team a role (saas-teams TM2).
 *
 * Writes a `role_assignments` row with `subject_type='team'` and
 * `subject_id = team_<hex>` at one of three scopes:
 *   * account       → role ∈ ACCOUNT_ROLES; written on the ACCOUNT org, cascades
 *                     to every workspace (WID6 machinery, TM3 expansion).
 *   * organization  → role ∈ ORGANIZATION_ROLES; written on the target workspace.
 *   * project       → role ∈ PROJECT_ROLES; written on the target org, scope_ref
 *                     = the project id.
 *
 * Authority follows the grant's scope: the actor must hold
 * `organization.member.update_role` on the *authority org* — the account org for
 * account scope, the target org for organization/project scope. (Finer
 * project-admin delegation waits on the team.* permission catalog in TM4; today
 * an org admin grants project-scoped team roles.)
 *
 * The team must belong to the account that owns the target org — no cross-account
 * or dangling grants (TF3 invariant).
 */
export async function handleGrantTeamRole(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: GrantTeamRoleDeps,
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
  const { teamId, role, scopeKind, scopeRef } = body as {
    teamId?: unknown;
    role?: unknown;
    scopeKind?: unknown;
    scopeRef?: unknown;
  };

  if (typeof teamId !== "string") {
    return validationError(requestId, { teamId: ["Required"] });
  }
  const teamUuid = parseTeamPublicId(teamId);
  if (!teamUuid) {
    return validationError(requestId, { teamId: ["Must be a valid team id (team_…)"] });
  }
  if (typeof scopeKind !== "string" || !SCOPE_KINDS.has(scopeKind)) {
    return validationError(requestId, { scopeKind: ["Must be one of: account, organization, project"] });
  }
  if (typeof role !== "string") {
    return validationError(requestId, { role: ["Required"] });
  }
  // Role must match the scope.
  const roleOk =
    (scopeKind === "account" && (ACCOUNT_ROLES as readonly string[]).includes(role)) ||
    (scopeKind === "organization" && (ORGANIZATION_ROLES as readonly string[]).includes(role)) ||
    (scopeKind === "project" && (PROJECT_ROLES as readonly string[]).includes(role));
  if (!roleOk) {
    return validationError(requestId, { role: [`Not a valid role for ${scopeKind} scope`] });
  }
  let scopeRefValue: string | null = null;
  if (scopeKind === "project") {
    if (typeof scopeRef !== "string" || scopeRef.length === 0) {
      return validationError(requestId, { scopeRef: ["Required for project scope"] });
    }
    scopeRefValue = scopeRef;
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);

    // Resolve the target org + its account.
    const orgResult = await repo.getOrganizationById(orgUuid);
    if (!orgResult.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    const accountUuid = asUuid(effectiveBillingOrgId(orgResult.value));

    // TF3 access-principal invariant — a subject_type='team' grant may only bind
    // to a LIVE team_ entity in this account: the id decodes to a real team
    // (parseTeamPublicId above), the team is not soft-deleted, and it belongs to
    // the target org's account. getTeamById already filters status<>'deleted',
    // but we assert `active` explicitly so the invariant holds even if that query
    // ever changes — no dangling or cross-account team grants can be written.
    const teamResult = await repo.getTeamById(teamUuid);
    if (
      !teamResult.ok ||
      teamResult.value.accountOrgId !== accountUuid ||
      teamResult.value.status !== "active"
    ) {
      return errorResponse("not_found", "Team not found", 404, requestId);
    }

    // Authority org: account org for account scope, else the target org.
    const authorityOrg = scopeKind === "account" ? accountUuid : orgUuid;
    const grantOrg = authorityOrg;

    const actorRoles = await repo.listRoleAssignments(authorityOrg, actor.subjectId);
    if (!actorRoles.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    const authResult = await authorizeViaPolicy(env.POLICY_WORKER, {
      actor,
      action: "team.role.grant",
      resource: { kind: "organization", id: authorityOrg, orgId: authorityOrg },
      orgId: authorityOrg,
      roleAssignments: actorRoles.value,
      requestId,
    });
    if (!authResult.allow) {
      // Deny-by-default; do not disclose the resource.
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());

    // TF5 — write the grant and its team.role.granted event/audit atomically.
    const run = async (
      r: Pick<MembershipRepository, "createRoleAssignment">,
      ev: Pick<EventsRepository, "appendEventWithAudit"> | null,
    ) => {
      const createdRow = await r.createRoleAssignment({
        id: genId(),
        orgId: grantOrg,
        subjectId: teamId,
        subjectType: "team",
        role,
        scopeKind,
        scopeRef: scopeRefValue,
        createdAt: now,
      });
      if (!createdRow.ok) return createdRow;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.role.granted", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: grantOrg, subjectKind: "team", subjectId: teamId,
            requestId, payload: { teamId, role, scopeKind, scopeRef: scopeRefValue },
          },
          audit: { id: genId(), category: "membership", description: `Team ${teamId} granted ${role} at ${scopeKind} scope` },
        });
      }
      return createdRow;
    };

    let created;
    if (executor && "transaction" in executor) {
      created = await executor.transaction(async (tx) => run(createMembershipRepository(tx), createEventsRepository(tx)));
    } else {
      created = await run(repo, deps?.eventsRepo ?? null);
    }
    if (!created.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    return successResponse(
      {
        grant: {
          teamId,
          role: created.value.role,
          scopeKind: created.value.scopeKind,
          scopeRef: created.value.scopeRef,
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
