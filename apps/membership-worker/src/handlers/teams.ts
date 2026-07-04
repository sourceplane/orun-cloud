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
import { parseOrgPublicId, parseTeamPublicId, teamPublicId, orgPublicId } from "../ids.js";

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
    handle: t.handle,
    description: t.description,
    avatar: t.avatarRef,
    status: t.status,
    ...(t.memberCount !== undefined ? { memberCount: t.memberCount } : {}),
    createdAt: t.createdAt.toISOString(),
  };
}

function slugify(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// teams-foundation TF1 — a handle is the account-unique, mentionable key
// (`@payments`). Lower-kebab, 2–39 chars, cannot start with a hyphen (TF-A default
// lean). Stored lower-cased; the DB partial-unique index on lower(handle) enforces
// per-account, case-insensitive uniqueness among live teams.
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const MAX_DESCRIPTION_LEN = 500;

/**
 * Validate/normalize the optional handle/description/avatar profile fields shared
 * by create + update. Returns the normalized values, or a `field → messages`
 * object to surface as a 422. `undefined` means "not supplied" (leave unchanged).
 */
function parseProfileFields(body: {
  handle?: unknown;
  description?: unknown;
  avatar?: unknown;
}): { ok: true; handle?: string; description?: string; avatar?: string } | { ok: false; errors: Record<string, string[]> } {
  const errors: Record<string, string[]> = {};
  let handle: string | undefined;
  let description: string | undefined;
  let avatar: string | undefined;

  if (body.handle !== undefined && body.handle !== null) {
    if (typeof body.handle !== "string") {
      errors.handle = ["Must be a string"];
    } else {
      const normalized = body.handle.trim().toLowerCase();
      if (!HANDLE_RE.test(normalized)) {
        errors.handle = [
          "Must be 2–39 characters of lower-case letters, digits, and hyphens, and cannot start with a hyphen",
        ];
      } else {
        handle = normalized;
      }
    }
  }
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== "string") {
      errors.description = ["Must be a string"];
    } else if (body.description.length > MAX_DESCRIPTION_LEN) {
      errors.description = [`Must be at most ${MAX_DESCRIPTION_LEN} characters`];
    } else {
      description = body.description;
    }
  }
  if (body.avatar !== undefined && body.avatar !== null) {
    if (typeof body.avatar !== "string") {
      errors.avatar = ["Must be a string"];
    } else {
      avatar = body.avatar;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const out: { ok: true; handle?: string; description?: string; avatar?: string } = { ok: true };
  if (handle !== undefined) out.handle = handle;
  if (description !== undefined) out.description = description;
  if (avatar !== undefined) out.avatar = avatar;
  return out;
}

const MEMBER_TEAM_ROLES = new Set(["team_admin", "team_member"]);

function publicMember(m: TeamMember): Record<string, unknown> {
  return { subjectId: m.subjectId, subjectType: m.subjectType, teamRole: m.teamRole, status: m.status, createdAt: m.createdAt.toISOString() };
}

const MEMBER_SUBJECT_TYPES = new Set(["user", "service_principal"]);

/** Resolve the account org that owns `targetOrgUuid` (teams are account-owned). */
async function resolveAccount(
  repo: MembershipRepository,
  targetOrgUuid: Uuid,
  requestId: string,
): Promise<{ ok: true; accountUuid: Uuid } | { ok: false; res: Response }> {
  const orgResult = await repo.getOrganizationById(targetOrgUuid);
  if (!orgResult.ok) {
    return { ok: false, res: errorResponse("not_found", "Organization not found", 404, requestId) };
  }
  return { ok: true, accountUuid: asUuid(effectiveBillingOrgId(orgResult.value)) };
}

/** True when the actor holds `action` at account scope (WID6 account RBAC). */
async function accountAuthorized(
  env: Env,
  repo: MembershipRepository,
  actor: ActorContext,
  accountUuid: Uuid,
  action: string,
  requestId: string,
): Promise<boolean> {
  const actorRoles = await repo.listRoleAssignments(accountUuid, actor.subjectId);
  if (!actorRoles.ok) return false;
  const auth = await authorizeViaPolicy(env.POLICY_WORKER!, {
    actor,
    action,
    resource: { kind: "organization", id: accountUuid, orgId: accountUuid },
    orgId: accountUuid,
    roleAssignments: actorRoles.value,
    requestId,
  });
  return auth.allow;
}

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
  const acct = await resolveAccount(repo, targetOrgUuid, requestId);
  if (!acct.ok) return acct;
  if (!(await accountAuthorized(env, repo, actor, acct.accountUuid, action, requestId))) {
    return { ok: false, res: errorResponse("not_found", "Organization not found", 404, requestId) };
  }
  return { ok: true, accountUuid: acct.accountUuid };
}

/**
 * Authorize a *team-management* mutation (teams-foundation TF2) on a specific
 * team: rename/profile, roster add/remove, member-role change. Allowed when the
 * actor is an account admin for `accountAction` (WID6 superset) **or** an active
 * `team_admin` of the team itself — self-management without an account role. Also
 * confirms the team is live and belongs to the resolved account. Deny surfaces as
 * 404 (not-disclosing). This authority is deliberately separate from the
 * platform-grant authority that decides *what the team can do* (saas-teams TM2).
 */
async function authorizeTeamManagement(
  env: Env,
  repo: MembershipRepository,
  actor: ActorContext,
  targetOrgUuid: Uuid,
  teamUuid: Uuid,
  accountAction: string,
  requestId: string,
): Promise<{ ok: true; accountUuid: Uuid; team: Team } | { ok: false; res: Response }> {
  const acct = await resolveAccount(repo, targetOrgUuid, requestId);
  if (!acct.ok) return acct;

  const teamResult = await repo.getTeamById(teamUuid);
  if (!teamResult.ok || teamResult.value.accountOrgId !== acct.accountUuid) {
    return { ok: false, res: errorResponse("not_found", "Team not found", 404, requestId) };
  }

  // Plane A — account admin (WID6) is a superset over team management.
  if (await accountAuthorized(env, repo, actor, acct.accountUuid, accountAction, requestId)) {
    return { ok: true, accountUuid: acct.accountUuid, team: teamResult.value };
  }
  // Plane B — an active team_admin manages the roster + profile self-service.
  const membership = await repo.getTeamMember(teamUuid, actor.subjectId);
  if (membership.ok && membership.value.status === "active" && membership.value.teamRole === "team_admin") {
    return { ok: true, accountUuid: acct.accountUuid, team: teamResult.value };
  }
  return { ok: false, res: errorResponse("not_found", "Team not found", 404, requestId) };
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
  const profile = parseProfileFields(body as Record<string, unknown>);
  if (!profile.ok) return validationError(requestId, profile.errors);

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
        ...(profile.handle !== undefined ? { handle: profile.handle } : {}),
        ...(profile.description !== undefined ? { description: profile.description } : {}),
        ...(profile.avatar !== undefined ? { avatarRef: profile.avatar } : {}),
        createdAt: now,
      });
      if (!created.ok) return created;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.created", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: authz.accountUuid, subjectKind: "team", subjectId: teamPublicId(teamUuid),
            requestId, payload: { teamId: teamPublicId(teamUuid), name: name.trim(), slug: slugLower, ...(profile.handle !== undefined ? { handle: profile.handle } : {}) },
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
      if (result.error.kind === "conflict") return errorResponse("conflict", "A team with that slug or handle already exists", 409, requestId);
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

// ── my teams (teams-ownership TO3 — the "My Teams" lens) ────────────
// The caller's own active team memberships in the account. No authz gate beyond
// authentication + a resolvable org: it discloses only the caller's own
// memberships, which powers the "My Services / My Teams' activity" filters.
export async function handleMyTeams(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: TeamsDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) return errorResponse("not_found", "Organization not found", 404, requestId);
  if (!deps && !env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const acct = await resolveAccount(repo, orgUuid, requestId);
    if (!acct.ok) return acct.res;
    const teams = await repo.listTeamsForSubject(acct.accountUuid, actor.subjectId);
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

/**
 * GET …/teams/{teamId}/grants — every ACTIVE grant the team holds, across all
 * orgs (teams-hub TH3a): "what can this team do, and where". Same read gate as
 * getTeam (`organization.member.list` on the account) and the same
 * team-belongs-to-this-account check; each row carries its target org so the
 * Team Page can show workspace-scoped grants against their workspace.
 */
export async function handleListTeamGrants(
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
    const grants = await repo.listTeamGrants(teamPublicId(teamUuid));
    if (!grants.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }
    return successResponse(
      {
        grants: grants.value.map((g) => ({
          role: g.role,
          scopeKind: g.scopeKind,
          scopeRef: g.scopeRef,
          orgId: orgPublicId(asUuid(g.orgId)),
          createdAt: g.createdAt.toISOString(),
        })),
      },
      requestId,
    );
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
  const { name, slug, handle, description, avatar } = body as {
    name?: unknown;
    slug?: unknown;
    handle?: unknown;
    description?: unknown;
    avatar?: unknown;
  };
  if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
    return validationError(requestId, { name: ["Must be a non-empty string"] });
  }
  if (slug !== undefined && typeof slug !== "string") {
    return validationError(requestId, { slug: ["Must be a string"] });
  }
  const profile = parseProfileFields({ handle, description, avatar });
  if (!profile.ok) return validationError(requestId, profile.errors);
  if (
    name === undefined &&
    slug === undefined &&
    profile.handle === undefined &&
    profile.description === undefined &&
    profile.avatar === undefined
  ) {
    return validationError(requestId, { body: ["Provide at least one of name, slug, handle, description, avatar"] });
  }
  const nextName = typeof name === "string" ? name.trim() : undefined;
  const nextSlug = typeof slug === "string" ? slugify(slug) : undefined;
  if (nextSlug !== undefined && nextSlug.length === 0) {
    return validationError(requestId, { slug: ["Could not derive a slug"] });
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    // teams-foundation TF2 — profile edits are team-management: an account admin
    // OR an active team_admin of the team may rename/re-slug/edit the profile.
    const authz = await authorizeTeamManagement(env, repo, actor, orgUuid, teamUuid, "team.update", requestId);
    if (!authz.ok) return authz.res;

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());
    const teamPub = teamPublicId(teamUuid);

    const run = async (r: MembershipRepository, ev: Pick<EventsRepository, "appendEventWithAudit"> | null) => {
      const updated = await r.updateTeam(teamUuid, {
        ...(nextName !== undefined ? { name: nextName } : {}),
        ...(nextSlug !== undefined ? { slugLower: nextSlug } : {}),
        ...(profile.handle !== undefined ? { handle: profile.handle } : {}),
        ...(profile.description !== undefined ? { description: profile.description } : {}),
        ...(profile.avatar !== undefined ? { avatarRef: profile.avatar } : {}),
        updatedAt: now,
      });
      if (!updated.ok) return updated;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.updated", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: authz.accountUuid, subjectKind: "team", subjectId: teamPub,
            requestId, payload: { teamId: teamPub, ...(nextName !== undefined ? { name: nextName } : {}), ...(nextSlug !== undefined ? { slug: nextSlug } : {}), ...(profile.handle !== undefined ? { handle: profile.handle } : {}) },
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
      if (result.error.kind === "conflict") return errorResponse("conflict", "A team with that slug or handle already exists", 409, requestId);
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
  const { subjectId, subjectType, teamRole } = body as { subjectId?: unknown; subjectType?: unknown; teamRole?: unknown };
  if (typeof subjectId !== "string" || subjectId.length === 0) {
    return validationError(requestId, { subjectId: ["Required"] });
  }
  const memberType = subjectType === undefined ? "user" : subjectType;
  if (typeof memberType !== "string" || !MEMBER_SUBJECT_TYPES.has(memberType)) {
    return validationError(requestId, { subjectType: ["Must be one of: user, service_principal"] });
  }
  const memberRole = teamRole === undefined ? "team_member" : teamRole;
  if (typeof memberRole !== "string" || !MEMBER_TEAM_ROLES.has(memberRole)) {
    return validationError(requestId, { teamRole: ["Must be one of: team_admin, team_member"] });
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    // teams-foundation TF2 — an account admin OR an active team_admin may add.
    const authz = await authorizeTeamManagement(env, repo, actor, orgUuid, teamUuid, "team.member.add", requestId);
    if (!authz.ok) return authz.res;

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());
    const teamPub = teamPublicId(teamUuid);

    const run = async (r: MembershipRepository, ev: Pick<EventsRepository, "appendEventWithAudit"> | null) => {
      const added = await r.addTeamMember({ teamId: teamUuid, subjectId, subjectType: memberType, teamRole: memberRole, createdAt: now });
      if (!added.ok) return added;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.member.added", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: authz.accountUuid, subjectKind: "team", subjectId: teamPub,
            requestId, payload: { teamId: teamPub, memberSubjectId: subjectId, memberSubjectType: memberType, memberTeamRole: memberRole },
          },
          audit: { id: genId(), category: "membership", description: `Subject added to team ${teamPub} as ${memberRole}` },
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
    // teams-foundation TF2 — an account admin OR an active team_admin may remove.
    const authz = await authorizeTeamManagement(env, repo, actor, orgUuid, teamUuid, "team.member.remove", requestId);
    if (!authz.ok) return authz.res;

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

// ── members: change team_role (teams-foundation TF2) ────────────────
export async function handleUpdateTeamMemberRole(
  request: Request,
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (!body || typeof body !== "object") return validationError(requestId, { body: ["Request body must be an object"] });
  const { teamRole } = body as { teamRole?: unknown };
  if (typeof teamRole !== "string" || !MEMBER_TEAM_ROLES.has(teamRole)) {
    return validationError(requestId, { teamRole: ["Must be one of: team_admin, team_member"] });
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    // Team-management: an account admin OR an active team_admin may change roles.
    const authz = await authorizeTeamManagement(env, repo, actor, orgUuid, teamUuid, "team.member.add", requestId);
    if (!authz.ok) return authz.res;

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => crypto.randomUUID());
    const teamPub = teamPublicId(teamUuid);

    const run = async (r: MembershipRepository, ev: Pick<EventsRepository, "appendEventWithAudit"> | null) => {
      const updated = await r.updateTeamMemberRole(teamUuid, subjectId, teamRole);
      if (!updated.ok) return updated;
      if (ev) {
        await ev.appendEventWithAudit({
          event: {
            id: genId(), type: "team.member.role_changed", version: 1, source: "membership-worker",
            occurredAt: now, actorType: actor.subjectType, actorId: actor.subjectId,
            orgId: authz.accountUuid, subjectKind: "team", subjectId: teamPub,
            requestId, payload: { teamId: teamPub, memberSubjectId: subjectId, teamRole },
          },
          audit: { id: genId(), category: "membership", description: `Member of team ${teamPub} set to ${teamRole}` },
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
    if (!result.ok) return errorResponse("not_found", "Member not found", 404, requestId);
    return successResponse({ member: publicMember(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
