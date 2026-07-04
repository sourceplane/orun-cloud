import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository, TeamOwnerHandle } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { asUuid, type Uuid } from "@saas/db/ids";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, parseTeamPublicId, teamPublicId } from "../ids.js";
import { normalizeOwnerHandle } from "../owner-handle.js";

// teams-ownership TO1 — the account-authored owner-handle → team alias map.
// This is ORG METADATA, not catalog content (18-state intact): it binds a
// git-authored `owner:` string to a team entity. Management is account-admin
// (team.owner_handle.set/remove); reads use the account member-list gate. Every
// mutation emits a `team.owner_handle.*` audit/event.

export interface OwnerHandlesDeps {
  repo: MembershipRepository;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
}

function publicOwnerHandle(h: TeamOwnerHandle): Record<string, unknown> {
  return {
    ownerHandle: h.ownerHandle,
    teamId: h.teamId,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}

function preflight(env: Env, deps: OwnerHandlesDeps | undefined, requestId: string): Response | null {
  if (!deps && !env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  if (!env.POLICY_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  return null;
}

/** Resolve the account org for the target and authorize `action` on it. */
async function authorizeOnAccount(
  env: Env,
  repo: MembershipRepository,
  actor: ActorContext,
  targetOrgUuid: Uuid,
  action: string,
  requestId: string,
): Promise<{ ok: true; accountUuid: Uuid } | { ok: false; res: Response }> {
  const orgResult = await repo.getOrganizationById(targetOrgUuid);
  if (!orgResult.ok) {
    return { ok: false, res: errorResponse("not_found", "Organization not found", 404, requestId) };
  }
  const accountUuid = asUuid(effectiveBillingOrgId(orgResult.value));
  const actorRoles = await repo.listRoleAssignments(accountUuid, actor.subjectId);
  if (!actorRoles.ok) {
    return { ok: false, res: errorResponse("not_found", "Organization not found", 404, requestId) };
  }
  const auth = await authorizeViaPolicy(env.POLICY_WORKER!, {
    actor,
    action,
    resource: { kind: "organization", id: accountUuid, orgId: accountUuid },
    orgId: accountUuid,
    roleAssignments: actorRoles.value,
    requestId,
  });
  if (!auth.allow) {
    return { ok: false, res: errorResponse("not_found", "Organization not found", 404, requestId) };
  }
  return { ok: true, accountUuid };
}

// ── list ────────────────────────────────────────────────────────────
export async function handleListOwnerHandles(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: OwnerHandlesDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) return errorResponse("not_found", "Organization not found", 404, requestId);
  const pf = preflight(env, deps, requestId);
  if (pf) return pf;

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const authz = await authorizeOnAccount(env, repo, actor, orgUuid, "organization.member.list", requestId);
    if (!authz.ok) return authz.res;
    const rows = await repo.listTeamOwnerHandles(authz.accountUuid);
    if (!rows.ok) return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    return successResponse({ ownerHandles: rows.value.map(publicOwnerHandle) }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── set (upsert an alias) ───────────────────────────────────────────
export async function handleSetOwnerHandle(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: OwnerHandlesDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) return errorResponse("not_found", "Organization not found", 404, requestId);
  const pf = preflight(env, deps, requestId);
  if (pf) return pf;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (!body || typeof body !== "object") return validationError(requestId, { body: ["Request body must be an object"] });
  const { ownerHandle, teamId } = body as { ownerHandle?: unknown; teamId?: unknown };
  if (typeof ownerHandle !== "string" || normalizeOwnerHandle(ownerHandle).length === 0) {
    return validationError(requestId, { ownerHandle: ["Required (a non-empty owner string)"] });
  }
  if (typeof teamId !== "string") {
    return validationError(requestId, { teamId: ["Required"] });
  }
  const teamUuid = parseTeamPublicId(teamId);
  if (!teamUuid) return validationError(requestId, { teamId: ["Must be a valid team id (team_…)"] });
  const normalizedHandle = normalizeOwnerHandle(ownerHandle);

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const authz = await authorizeOnAccount(env, repo, actor, orgUuid, "team.owner_handle.set", requestId);
    if (!authz.ok) return authz.res;

    // The alias may only point at a LIVE team in this account (id-bound, TF3-style).
    const team = await repo.getTeamById(teamUuid);
    if (!team.ok || team.value.accountOrgId !== authz.accountUuid || team.value.status !== "active") {
      return errorResponse("not_found", "Team not found", 404, requestId);
    }

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());
    const teamPub = teamPublicId(teamUuid);

    const run = async (r: MembershipRepository, ev: Pick<EventsRepository, "appendEventWithAudit"> | null) => {
      const saved = await r.upsertTeamOwnerHandle({
        accountOrgId: authz.accountUuid,
        ownerHandle: normalizedHandle,
        teamId: teamPub,
        createdAt: now,
      });
      if (!saved.ok) return saved;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.owner_handle.set", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: authz.accountUuid, subjectKind: "team", subjectId: teamPub,
            requestId, payload: { teamId: teamPub, ownerHandle: normalizedHandle },
          },
          audit: { id: genId(), category: "membership", description: `Owner handle '${normalizedHandle}' mapped to team ${teamPub}` },
        });
      }
      return saved;
    };

    let result;
    if (executor && "transaction" in executor) {
      result = await executor.transaction(async (tx) => run(createMembershipRepository(tx), createEventsRepository(tx)));
    } else {
      result = await run(repo, deps?.eventsRepo ?? null);
    }
    if (!result.ok) return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    return successResponse({ ownerHandle: publicOwnerHandle(result.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── delete (remove an alias) ────────────────────────────────────────
export async function handleDeleteOwnerHandle(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  ownerHandleParam: string,
  deps?: OwnerHandlesDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) return errorResponse("not_found", "Organization not found", 404, requestId);
  const ownerHandle = normalizeOwnerHandle(decodeURIComponent(ownerHandleParam));
  if (ownerHandle.length === 0) return errorResponse("not_found", "Owner handle not found", 404, requestId);
  const pf = preflight(env, deps, requestId);
  if (pf) return pf;

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const authz = await authorizeOnAccount(env, repo, actor, orgUuid, "team.owner_handle.remove", requestId);
    if (!authz.ok) return authz.res;

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());

    const run = async (r: MembershipRepository, ev: Pick<EventsRepository, "appendEventWithAudit"> | null) => {
      const removed = await r.deleteTeamOwnerHandle(authz.accountUuid, ownerHandle);
      if (!removed.ok) return removed;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.owner_handle.removed", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: authz.accountUuid, subjectKind: "team", subjectId: removed.value.teamId,
            requestId, payload: { teamId: removed.value.teamId, ownerHandle },
          },
          audit: { id: genId(), category: "membership", description: `Owner handle '${ownerHandle}' unmapped from team ${removed.value.teamId}` },
        });
      }
      return removed;
    };

    let result;
    if (executor && "transaction" in executor) {
      result = await executor.transaction(async (tx) => run(createMembershipRepository(tx), createEventsRepository(tx)));
    } else {
      result = await run(repo, deps?.eventsRepo ?? null);
    }
    if (!result.ok) return errorResponse("not_found", "Owner handle not found", 404, requestId);
    return successResponse({ ownerHandle: publicOwnerHandle(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
