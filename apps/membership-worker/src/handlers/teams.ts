import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository, Team, TeamMember } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { asUuid, type Uuid } from "@saas/db/ids";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, parseTeamPublicId, teamPublicId } from "../ids.js";

// saas-teams TM4b — team lifecycle management (create · list · get · delete).
// Teams are account-owned, so every operation authorizes against the ACCOUNT org
// (the parent, or the org itself if it is the account root). Mutations emit
// `team.*` audit/events. Update + membership land in TM4b2.

export interface TeamsDeps {
  repo: MembershipRepository;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
}

function publicTeam(t: Team): Record<string, unknown> {
  return {
    id: teamPublicId(t.id),
    name: t.name,
    slug: t.slugLower,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
  };
}

function slugify(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function publicMember(m: TeamMember): Record<string, unknown> {
  return { subjectId: m.subjectId, subjectType: m.subjectType, status: m.status, createdAt: m.createdAt.toISOString() };
}

const MEMBER_SUBJECT_TYPES = new Set(["user", "service_principal"]);

/**
 * Resolve the account org for the target and authorize the actor for `action`
 * on the account (teams are account-owned). Returns the account UUID or an
 * error Response (deny surfaces as 404, not-disclosing).
 */
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

function preflight(env: Env, deps: TeamsDeps | undefined, requestId: string): Response | null {
  if (!deps && !env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  if (!env.POLICY_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  return null;
}

// ── create ──────────────────────────────────────────────────────────
export async function handleCreateTeam(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: TeamsDeps,
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
  const { name, slug } = body as { name?: unknown; slug?: unknown };
  if (typeof name !== "string" || name.trim().length === 0) {
    return validationError(requestId, { name: ["Required"] });
  }
  if (slug !== undefined && typeof slug !== "string") {
    return validationError(requestId, { slug: ["Must be a string"] });
  }
  const slugLower = slugify(typeof slug === "string" && slug.length > 0 ? slug : name);
  if (slugLower.length === 0) {
    return validationError(requestId, { slug: ["Could not derive a slug"] });
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const authz = await authorizeOnAccount(env, repo, actor, orgUuid, "team.create", requestId);
    if (!authz.ok) return authz.res;

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());
    const teamUuid = asUuid(crypto.randomUUID());

    const run = async (r: MembershipRepository, ev: Pick<EventsRepository, "appendEventWithAudit"> | null) => {
      const created = await r.createTeam({
        id: teamUuid,
        accountOrgId: authz.accountUuid,
        name: name.trim(),
        slugLower,
        createdAt: now,
      });
      if (!created.ok) return created;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.created", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: authz.accountUuid, subjectKind: "team", subjectId: teamPublicId(teamUuid),
            requestId, payload: { teamId: teamPublicId(teamUuid), name: name.trim(), slug: slugLower },
          },
          audit: { id: genId(), category: "membership", description: `Team ${teamPublicId(teamUuid)} created` },
        });
      }
      return created;
    };

    let result;
    if (executor && "transaction" in executor) {
      result = await executor.transaction(async (tx) => run(createMembershipRepository(tx), createEventsRepository(tx)));
    } else {
      result = await run(repo, deps?.eventsRepo ?? null);
    }
    if (!result.ok) {
      if (result.error.kind === "conflict") return errorResponse("conflict", "A team with that slug already exists", 409, requestId);
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }
    return successResponse({ team: publicTeam(result.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── list ────────────────────────────────────────────────────────────
export async function handleListTeams(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: TeamsDeps,
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
    const teams = await repo.listTeams(authz.accountUuid);
    if (!teams.ok) return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    return successResponse({ teams: teams.value.map(publicTeam) }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── get ─────────────────────────────────────────────────────────────
export async function handleGetTeam(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  teamIdParam: string,
  deps?: TeamsDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) return errorResponse("not_found", "Organization not found", 404, requestId);
  const teamUuid = parseTeamPublicId(teamIdParam);
  if (!teamUuid) return errorResponse("not_found", "Team not found", 404, requestId);
  const pf = preflight(env, deps, requestId);
  if (pf) return pf;

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const authz = await authorizeOnAccount(env, repo, actor, orgUuid, "organization.member.list", requestId);
    if (!authz.ok) return authz.res;
    const team = await repo.getTeamById(teamUuid);
    if (!team.ok || team.value.accountOrgId !== authz.accountUuid) {
      return errorResponse("not_found", "Team not found", 404, requestId);
    }
    return successResponse({ team: publicTeam(team.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── delete (soft) + cascade-revoke grants ───────────────────────────
export async function handleDeleteTeam(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  teamIdParam: string,
  deps?: TeamsDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) return errorResponse("not_found", "Organization not found", 404, requestId);
  const teamUuid = parseTeamPublicId(teamIdParam);
  if (!teamUuid) return errorResponse("not_found", "Team not found", 404, requestId);
  const pf = preflight(env, deps, requestId);
  if (pf) return pf;

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const authz = await authorizeOnAccount(env, repo, actor, orgUuid, "team.delete", requestId);
    if (!authz.ok) return authz.res;

    const existing = await repo.getTeamById(teamUuid);
    if (!existing.ok || existing.value.accountOrgId !== authz.accountUuid) {
      return errorResponse("not_found", "Team not found", 404, requestId);
    }

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());
    const teamPub = teamPublicId(teamUuid);

    const run = async (r: MembershipRepository, ev: Pick<EventsRepository, "appendEventWithAudit"> | null) => {
      const deleted = await r.deleteTeam(teamUuid, now);
      if (!deleted.ok) return deleted;
      // Cascade: revoke every grant the team held (never orphan grant rows).
      const revoked = await r.revokeAllTeamGrants(teamPub, now);
      const revokedCount = revoked.ok ? revoked.value.length : 0;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.deleted", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: authz.accountUuid, subjectKind: "team", subjectId: teamPub,
            requestId, payload: { teamId: teamPub, revokedGrantCount: revokedCount },
          },
          audit: { id: genId(), category: "membership", description: `Team ${teamPub} deleted (${revokedCount} grant(s) revoked)` },
        });
      }
      return deleted;
    };

    let result;
    if (executor && "transaction" in executor) {
      result = await executor.transaction(async (tx) => run(createMembershipRepository(tx), createEventsRepository(tx)));
    } else {
      result = await run(repo, deps?.eventsRepo ?? null);
    }
    if (!result.ok) return errorResponse("not_found", "Team not found", 404, requestId);
    return successResponse({ team: publicTeam(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── update (rename / re-slug) ───────────────────────────────────────
export async function handleUpdateTeam(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  teamIdParam: string,
  deps?: TeamsDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) return errorResponse("not_found", "Organization not found", 404, requestId);
  const teamUuid = parseTeamPublicId(teamIdParam);
  if (!teamUuid) return errorResponse("not_found", "Team not found", 404, requestId);
  const pf = preflight(env, deps, requestId);
  if (pf) return pf;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (!body || typeof body !== "object") return validationError(requestId, { body: ["Request body must be an object"] });
  const { name, slug } = body as { name?: unknown; slug?: unknown };
  if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
    return validationError(requestId, { name: ["Must be a non-empty string"] });
  }
  if (slug !== undefined && typeof slug !== "string") {
    return validationError(requestId, { slug: ["Must be a string"] });
  }
  if (name === undefined && slug === undefined) {
    return validationError(requestId, { body: ["Provide name and/or slug"] });
  }
  const nextName = typeof name === "string" ? name.trim() : undefined;
  const nextSlug = typeof slug === "string" ? slugify(slug) : undefined;
  if (nextSlug !== undefined && nextSlug.length === 0) {
    return validationError(requestId, { slug: ["Could not derive a slug"] });
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const authz = await authorizeOnAccount(env, repo, actor, orgUuid, "team.update", requestId);
    if (!authz.ok) return authz.res;

    const existing = await repo.getTeamById(teamUuid);
    if (!existing.ok || existing.value.accountOrgId !== authz.accountUuid) {
      return errorResponse("not_found", "Team not found", 404, requestId);
    }

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());
    const teamPub = teamPublicId(teamUuid);

    const run = async (r: MembershipRepository, ev: Pick<EventsRepository, "appendEventWithAudit"> | null) => {
      const updated = await r.updateTeam(teamUuid, {
        ...(nextName !== undefined ? { name: nextName } : {}),
        ...(nextSlug !== undefined ? { slugLower: nextSlug } : {}),
        updatedAt: now,
      });
      if (!updated.ok) return updated;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.updated", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: authz.accountUuid, subjectKind: "team", subjectId: teamPub,
            requestId, payload: { teamId: teamPub, ...(nextName !== undefined ? { name: nextName } : {}), ...(nextSlug !== undefined ? { slug: nextSlug } : {}) },
          },
          audit: { id: genId(), category: "membership", description: `Team ${teamPub} updated` },
        });
      }
      return updated;
    };

    let result;
    if (executor && "transaction" in executor) {
      result = await executor.transaction(async (tx) => run(createMembershipRepository(tx), createEventsRepository(tx)));
    } else {
      result = await run(repo, deps?.eventsRepo ?? null);
    }
    if (!result.ok) {
      if (result.error.kind === "conflict") return errorResponse("conflict", "A team with that slug already exists", 409, requestId);
      return errorResponse("not_found", "Team not found", 404, requestId);
    }
    return successResponse({ team: publicTeam(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── members: list ───────────────────────────────────────────────────
export async function handleListTeamMembers(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  teamIdParam: string,
  deps?: TeamsDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) return errorResponse("not_found", "Organization not found", 404, requestId);
  const teamUuid = parseTeamPublicId(teamIdParam);
  if (!teamUuid) return errorResponse("not_found", "Team not found", 404, requestId);
  const pf = preflight(env, deps, requestId);
  if (pf) return pf;

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const authz = await authorizeOnAccount(env, repo, actor, orgUuid, "organization.member.list", requestId);
    if (!authz.ok) return authz.res;
    const existing = await repo.getTeamById(teamUuid);
    if (!existing.ok || existing.value.accountOrgId !== authz.accountUuid) {
      return errorResponse("not_found", "Team not found", 404, requestId);
    }
    const members = await repo.listTeamMembers(teamUuid);
    if (!members.ok) return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    return successResponse({ members: members.value.map(publicMember) }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── members: add ────────────────────────────────────────────────────
export async function handleAddTeamMember(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  teamIdParam: string,
  deps?: TeamsDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) return errorResponse("not_found", "Organization not found", 404, requestId);
  const teamUuid = parseTeamPublicId(teamIdParam);
  if (!teamUuid) return errorResponse("not_found", "Team not found", 404, requestId);
  const pf = preflight(env, deps, requestId);
  if (pf) return pf;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (!body || typeof body !== "object") return validationError(requestId, { body: ["Request body must be an object"] });
  const { subjectId, subjectType } = body as { subjectId?: unknown; subjectType?: unknown };
  if (typeof subjectId !== "string" || subjectId.length === 0) {
    return validationError(requestId, { subjectId: ["Required"] });
  }
  const memberType = subjectType === undefined ? "user" : subjectType;
  if (typeof memberType !== "string" || !MEMBER_SUBJECT_TYPES.has(memberType)) {
    return validationError(requestId, { subjectType: ["Must be one of: user, service_principal"] });
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const authz = await authorizeOnAccount(env, repo, actor, orgUuid, "team.member.add", requestId);
    if (!authz.ok) return authz.res;
    const existing = await repo.getTeamById(teamUuid);
    if (!existing.ok || existing.value.accountOrgId !== authz.accountUuid) {
      return errorResponse("not_found", "Team not found", 404, requestId);
    }

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());
    const teamPub = teamPublicId(teamUuid);

    const run = async (r: MembershipRepository, ev: Pick<EventsRepository, "appendEventWithAudit"> | null) => {
      const added = await r.addTeamMember({ teamId: teamUuid, subjectId, subjectType: memberType, createdAt: now });
      if (!added.ok) return added;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.member.added", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: authz.accountUuid, subjectKind: "team", subjectId: teamPub,
            requestId, payload: { teamId: teamPub, memberSubjectId: subjectId, memberSubjectType: memberType },
          },
          audit: { id: genId(), category: "membership", description: `Subject added to team ${teamPub}` },
        });
      }
      return added;
    };

    let result;
    if (executor && "transaction" in executor) {
      result = await executor.transaction(async (tx) => run(createMembershipRepository(tx), createEventsRepository(tx)));
    } else {
      result = await run(repo, deps?.eventsRepo ?? null);
    }
    if (!result.ok) return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    return successResponse({ member: publicMember(result.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── members: remove ─────────────────────────────────────────────────
export async function handleRemoveTeamMember(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  teamIdParam: string,
  subjectIdParam: string,
  deps?: TeamsDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) return errorResponse("not_found", "Organization not found", 404, requestId);
  const teamUuid = parseTeamPublicId(teamIdParam);
  if (!teamUuid) return errorResponse("not_found", "Team not found", 404, requestId);
  const subjectId = decodeURIComponent(subjectIdParam);
  if (subjectId.length === 0) return errorResponse("not_found", "Member not found", 404, requestId);
  const pf = preflight(env, deps, requestId);
  if (pf) return pf;

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const authz = await authorizeOnAccount(env, repo, actor, orgUuid, "team.member.remove", requestId);
    if (!authz.ok) return authz.res;
    const existing = await repo.getTeamById(teamUuid);
    if (!existing.ok || existing.value.accountOrgId !== authz.accountUuid) {
      return errorResponse("not_found", "Team not found", 404, requestId);
    }

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());
    const teamPub = teamPublicId(teamUuid);

    const run = async (r: MembershipRepository, ev: Pick<EventsRepository, "appendEventWithAudit"> | null) => {
      const removed = await r.removeTeamMember(teamUuid, subjectId);
      if (!removed.ok) return removed;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.member.removed", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: authz.accountUuid, subjectKind: "team", subjectId: teamPub,
            requestId, payload: { teamId: teamPub, memberSubjectId: subjectId },
          },
          audit: { id: genId(), category: "membership", description: `Subject removed from team ${teamPub}` },
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
    if (!result.ok) return errorResponse("not_found", "Member not found", 404, requestId);
    return successResponse({ member: publicMember(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
