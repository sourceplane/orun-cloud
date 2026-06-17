// Workspace links + tenancy resolution (state-api-contract §5; design §2).
//
// A workspace link binds a normalized git remote to an org + project so the
// CLI can run `orun run --remote-state` with no flags after a one-time
// `orun cloud link`. This is the Orun-native analogue of integrations'
// repo_links, but trust-free: it works for any git remote with no GitHub App
// installed. state-worker owns `state.workspace_links` (design §2), so it owns
// these routes — mirroring how integrations-worker owns repo_links.
//
// Two endpoints:
//   POST /v1/organizations/{orgId}/cli/links   — create (policy org.cli.link),
//        creating the project on demand when absent.
//   GET  /v1/cli/links/resolve?remoteUrl=…     — org-independent; returns the
//        candidate orgs/projects the AUTHENTICATED actor may link/use for that
//        remote (powers the CLI picker). Read-scoped to the actor's orgs.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  CreateWorkspaceLinkResponse,
  ResolveWorkspaceLinksResponse,
  WorkspaceLink as PublicWorkspaceLink,
} from "@saas/contracts/state";
import { STATE_EVENT_TYPES, STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import type { CliSessionOrg } from "@saas/contracts/auth";
import type { PolicyResource } from "@saas/contracts/policy";
import { createStateRepository, type WorkspaceLink } from "@saas/db/state";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { uuidFromPublicId, type Uuid } from "@saas/db/ids";
import { errorResponse, listResponse, successResponse, validationError } from "../http.js";
import {
  generateUuid,
  orgPublicId,
  projectPublicId,
  workspaceLinkPublicId,
} from "../ids.js";
import { fetchAuthorizationContext, fetchSubjectOrgs } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { createProject, resolveProject, type ResolvedProject } from "../projects-client.js";
import { githubFullNameFromNormalized, normalizeRemoteUrl } from "../remote-url.js";

export interface WorkspaceLinkDeps {
  executor?: SqlExecutor;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_MIN = 2;
const SLUG_MAX = 63;

/** Derive a default project slug from a normalized remote's repo segment. */
function deriveSlugFromRemote(normalized: string): string {
  const repo = normalized.split("/").pop() ?? "project";
  const slug =
    repo
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX) || "project";
  return slug.length < SLUG_MIN ? `${slug}-app`.slice(0, SLUG_MAX) : slug;
}

function actorKindOf(subjectType: string): PublicWorkspaceLink["createdBy"]["kind"] {
  switch (subjectType) {
    case "user":
    case "service_principal":
    case "workflow":
    case "system":
      return subjectType;
    default:
      return "system";
  }
}

function toPublicLink(
  link: WorkspaceLink,
  orgSlug: string,
  projectSlug: string,
  actorFallbackKind: PublicWorkspaceLink["createdBy"]["kind"],
): PublicWorkspaceLink {
  return {
    id: workspaceLinkPublicId(link.id),
    orgId: orgPublicId(link.orgId),
    orgSlug,
    projectId: projectPublicId(link.projectId),
    projectSlug,
    remoteUrl: link.remoteUrl,
    provider: link.provider,
    providerRepoId: link.providerRepoId,
    providerOwnerId: link.providerOwnerId,
    providerOwnerLogin: link.providerOwnerLogin,
    ciSettings: link.ciSettings,
    createdBy: {
      id: link.createdBy.id ?? "",
      kind: link.createdBy.kind ?? actorFallbackKind,
    },
    createdAt: link.createdAt.toISOString(),
    lastSeenAt: link.lastSeenAt ? link.lastSeenAt.toISOString() : null,
  };
}

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

// ── Create ──────────────────────────────────────────────────

export async function handleCreateWorkspaceLink(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkspaceLinkDeps,
): Promise<Response> {
  if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER || !env.PROJECTS_WORKER) {
    return errorResponse("internal_error", "Authorization services not configured", 503, requestId);
  }

  // ── Authorize org.cli.link on the org (deny-by-default; resource-hiding
  //    means both "not a member" and "not allowed" return 404). ──
  //
  // Internal-service convention (matches projects-worker, config-worker, etc.):
  // pass the bare UUID — membership-worker's authorization-context handler
  // calls `asUuid()` on req.orgId and throws on non-canonical input, which
  // would surface as a 500 here and a CLI "not authorized to link" 404. The
  // policy-engine matches `fact.scope.orgId === resource.orgId` by string
  // equality, so resource.orgId must use the SAME format the facts carry
  // (membership-worker propagates whatever we send into scope.orgId).
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) {
    console.error(JSON.stringify({ level: "error", scope: "state.links.create", reason: "membership_context_unreachable", requestId, orgId, subjectId: actor.subjectId, subjectType: actor.subjectType }));
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const resource: PolicyResource = { kind: "organization", orgId };
  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER,
    actor.subjectId,
    actor.subjectType,
    STATE_POLICY_ACTIONS.CLI_LINK,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    console.error(JSON.stringify({ level: "error", scope: "state.links.create", reason: "policy_denied", requestId, orgId, subjectId: actor.subjectId, action: STATE_POLICY_ACTIONS.CLI_LINK, membershipCount: contextResult.memberships.length, memberships: contextResult.memberships.map((m) => ({ role: (m as { role?: string }).role, scope: (m as { scope?: unknown }).scope })) }));
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  // ── Parse + validate body. ──
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const normalized = normalizeRemoteUrl(body.remoteUrl);
  if (!normalized) {
    return validationError(requestId, {
      remoteUrl: ["Required; must be a git remote URL (ssh or https)"],
    });
  }

  let requestedSlug: string | null = null;
  if (body.projectSlug !== undefined && body.projectSlug !== null) {
    if (
      typeof body.projectSlug !== "string" ||
      body.projectSlug.length < SLUG_MIN ||
      body.projectSlug.length > SLUG_MAX ||
      !SLUG_RE.test(body.projectSlug)
    ) {
      return validationError(requestId, {
        projectSlug: ["Must be a slug: 2-63 lowercase letters, numbers, or hyphens"],
      });
    }
    requestedSlug = body.projectSlug;
  }

  // Optional rename-stable provider identity (OV2.1). Each field is a string or
  // absent; non-string values are ignored rather than rejected (additive).
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const providerIdentity = {
    provider: str(body.provider),
    providerRepoId: str(body.providerRepoId),
    providerOwnerId: str(body.providerOwnerId),
    providerOwnerLogin: str(body.providerOwnerLogin),
  };

  // ── Resolve the org slug (the actor is a member, per the policy check). ──
  const orgsResult = await fetchSubjectOrgs(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    requestId,
  );
  if (!orgsResult.ok) {
    console.error(JSON.stringify({ level: "error", scope: "state.links.create", reason: "subject_orgs_unreachable", requestId, subjectId: actor.subjectId }));
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const orgPublic = orgPublicId(orgId);
  const orgEntry = orgsResult.orgs.find((o) => o.id === orgPublic);
  if (!orgEntry) {
    console.error(JSON.stringify({ level: "error", scope: "state.links.create", reason: "org_not_in_subject_orgs", requestId, orgPublic, subjectId: actor.subjectId, knownOrgIds: orgsResult.orgs.map((o) => o.id) }));
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  // ── Find-or-create the project. ──
  const slug = requestedSlug ?? deriveSlugFromRemote(normalized);
  let project: ResolvedProject;

  const existing = await resolveProject(env.PROJECTS_WORKER, orgId, { slug }, requestId);
  if (!existing.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  if (existing.project) {
    project = existing.project;
  } else {
    // Create on demand under the actor's project.create grant (the roles that
    // carry org.cli.link also carry project.create — see policy-engine maps).
    const created = await createProject(
      env.PROJECTS_WORKER,
      orgPublic,
      { name: slug, slug },
      { subjectId: actor.subjectId, subjectType: actor.subjectType },
      requestId,
    );
    if (!created.ok) {
      if (created.status === 409) {
        // Lost the create race or slug already taken — resolve and reuse.
        const reResolved = await resolveProject(env.PROJECTS_WORKER, orgId, { slug }, requestId);
        if (!reResolved.ok || !reResolved.project) {
          return errorResponse("conflict", "Project slug already in use", 409, requestId);
        }
        project = reResolved.project;
      } else if (created.status === 412) {
        return errorResponse(
          "precondition_failed",
          "Creating a project is not included in your current plan",
          412,
          requestId,
          { reason: "limit_reached" },
        );
      } else if (created.status === 404 || created.status === 403) {
        // Project creation requires project.create, which the actor lacks.
        console.error(JSON.stringify({ level: "error", scope: "state.links.create", reason: "project_create_denied", requestId, orgPublic, slug, projectsWorkerStatus: created.status }));
        return errorResponse("not_found", "Not found", 404, requestId);
      } else {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
    } else {
      project = created.project;
    }
  }

  const projectUuid = uuidFromPublicId(project.id, "prj");
  if (!projectUuid) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  // ── Write the workspace link (idempotent on the active-remote unique index). ──
  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const linkId = generateUuid();
    const created = await repo.createWorkspaceLink({
      id: linkId,
      orgId,
      projectId: projectUuid,
      remoteUrl: normalized,
      createdBy: { id: actor.subjectId, kind: actorKindOf(actor.subjectType) },
      provider: providerIdentity,
    });

    let link: WorkspaceLink;
    if (!created.ok) {
      if (created.error.kind === "conflict") {
        // An active link for (org, remote) already exists — idempotent: return
        // the existing one (the CLI may re-link from a fresh clone).
        const all = await repo.listActiveWorkspaceLinksForRemote(normalized);
        const match =
          all.ok && all.value.find((l) => l.orgId === orgId && l.remoteUrl === normalized);
        if (!match) return errorResponse("conflict", "Workspace already linked", 409, requestId);
        link = match;
      } else {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
    } else {
      link = created.value;
    }

    // ── Audit: emit org.cli.linked (best-effort; never fails the link). ──
    if (created.ok) {
      try {
        const events = createEventsRepository(executor);
        await events.appendEventWithAudit({
          event: {
            id: generateUuid(),
            type: STATE_EVENT_TYPES.CLI_LINKED,
            version: 1,
            source: "state-worker",
            occurredAt: new Date(),
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId,
            projectId: link.projectId,
            subjectKind: "workspace_link",
            subjectId: link.id,
            subjectName: normalized,
            requestId,
            payload: {
              version: 1,
              orgId: orgPublic,
              projectId: project.id,
              workspaceLinkId: workspaceLinkPublicId(link.id),
              remoteUrl: normalized,
            },
          },
          audit: {
            id: generateUuid(),
            category: "workspace_links",
            description: `Linked workspace to ${normalized}`,
            projectId: link.projectId,
          },
        });
      } catch {
        // Best-effort audit.
      }
    }

    const payload: CreateWorkspaceLinkResponse = {
      link: toPublicLink(link, orgEntry.slug, project.slug, actorKindOf(actor.subjectType)),
    };
    return successResponse(payload, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── Resolve (org-independent; scoped to the actor's orgs) ────

export async function handleResolveWorkspaceLinks(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  deps?: WorkspaceLinkDeps,
): Promise<Response> {
  if (!env.MEMBERSHIP_WORKER) {
    return errorResponse("internal_error", "Authorization services not configured", 503, requestId);
  }

  const url = new URL(request.url);
  const normalized = normalizeRemoteUrl(url.searchParams.get("remoteUrl"));
  if (!normalized) {
    return validationError(requestId, {
      remoteUrl: ["Required; must be a git remote URL (ssh or https)"],
    });
  }

  // The actor's orgs bound the result set — resolve never leaks links from an
  // org the actor is not a member of.
  const orgsResult = await fetchSubjectOrgs(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    requestId,
  );
  if (!orgsResult.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const orgBySlugHex = new Map<string, CliSessionOrg>();
  for (const o of orgsResult.orgs) {
    // o.id is `org_<hex>`; index by the raw hex for fast row matching.
    orgBySlugHex.set(o.id, o);
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const all = await repo.listActiveWorkspaceLinksForRemote(normalized);
    if (!all.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    // Keep only links in orgs the actor belongs to.
    const candidates: PublicWorkspaceLink[] = [];
    for (const link of all.value) {
      const orgPublic = orgPublicId(link.orgId);
      const orgEntry = orgBySlugHex.get(orgPublic);
      if (!orgEntry) continue;
      // Resolve the project slug for the projection (best-effort).
      let projectSlug = "";
      if (env.PROJECTS_WORKER) {
        // projects-worker /v1/internal/projects/resolve validates projectId as
        // a bare UUID and 400s on the `prj_<hex>` public form. Pass the UUID.
        const resolved = await resolveProject(
          env.PROJECTS_WORKER,
          link.orgId,
          { projectId: link.projectId },
          requestId,
        );
        if (resolved.ok && resolved.project) projectSlug = resolved.project.slug;
      }
      candidates.push(
        toPublicLink(link, orgEntry.slug, projectSlug, actorKindOf(actor.subjectType)),
      );
    }

    const payload: ResolveWorkspaceLinksResponse = { candidates, links: candidates };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── List (org/project-scoped; powers the console CLI page) ───

export async function handleListWorkspaceLinks(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: WorkspaceLinkDeps,
): Promise<Response> {
  if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Authorization services not configured", 503, requestId);
  }

  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);

  // Read is gated on the same org.cli.link grant — listing links is part of the
  // CLI-link management surface. (Viewers without it get a clean 404.)
  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER,
    actor.subjectId,
    actor.subjectType,
    STATE_POLICY_ACTIONS.CLI_LINK,
    { kind: "organization", orgId },
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) return errorResponse("not_found", "Not found", 404, requestId);

  const orgsResult = await fetchSubjectOrgs(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    requestId,
  );
  const orgSlug = orgsResult.ok
    ? orgsResult.orgs.find((o) => o.id === orgPublicId(orgId))?.slug ?? ""
    : "";

  let projectSlug = "";
  if (env.PROJECTS_WORKER) {
    // projects-worker /v1/internal/projects/resolve validates projectId as
    // a bare UUID and 400s on the `prj_<hex>` public form. Pass the UUID.
    const resolved = await resolveProject(
      env.PROJECTS_WORKER,
      orgId,
      { projectId },
      requestId,
    );
    if (resolved.ok && resolved.project) projectSlug = resolved.project.slug;
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const result = await repo.listWorkspaceLinks(orgId, projectId, { limit: 100, cursor: null });
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const links = result.value.items
      .filter((l) => l.status === "active")
      .map((l) => toPublicLink(l, orgSlug, projectSlug, actorKindOf(actor.subjectType)));
    const payload = { links };
    const cursor = result.value.nextCursor
      ? `${result.value.nextCursor.createdAt}|${result.value.nextCursor.id}`
      : null;
    return listResponse(payload, requestId, cursor);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── Unlink (soft; org/project-scoped) ───────────────────────

export async function handleUnlinkWorkspaceLink(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  linkId: Uuid,
  deps?: WorkspaceLinkDeps,
): Promise<Response> {
  if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Authorization services not configured", 503, requestId);
  }

  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);

  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER,
    actor.subjectId,
    actor.subjectType,
    STATE_POLICY_ACTIONS.CLI_LINK,
    { kind: "organization", orgId },
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) return errorResponse("not_found", "Not found", 404, requestId);

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const existing = await repo.getWorkspaceLink(orgId, linkId);
    if (!existing.ok || existing.value.projectId !== projectId) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    if (existing.value.status === "active") {
      const unlinked = await repo.unlinkWorkspaceLink(orgId, linkId);
      if (!unlinked.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
      try {
        const events = createEventsRepository(executor);
        await events.appendEventWithAudit({
          event: {
            id: generateUuid(),
            type: STATE_EVENT_TYPES.CLI_UNLINKED,
            version: 1,
            source: "state-worker",
            occurredAt: new Date(),
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId,
            projectId,
            subjectKind: "workspace_link",
            subjectId: linkId,
            subjectName: existing.value.remoteUrl,
            requestId,
            payload: {
              version: 1,
              orgId: orgPublicId(orgId),
              projectId: projectPublicId(projectId),
              workspaceLinkId: workspaceLinkPublicId(linkId),
              remoteUrl: existing.value.remoteUrl,
            },
          },
          audit: {
            id: generateUuid(),
            category: "workspace_links",
            description: `Unlinked workspace from ${existing.value.remoteUrl}`,
            projectId,
          },
        });
      } catch {
        // Best-effort audit.
      }
    }
    return successResponse({ deleted: true }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// Re-exported for cross-linking the console to an IG connection covering the
// same repo (design §2). Pure; safe to call in tests.
export { githubFullNameFromNormalized };
