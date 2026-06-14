import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import {
  handleCreateWorkspaceLink,
  handleListWorkspaceLinks,
  handleResolveWorkspaceLinks,
  handleUnlinkWorkspaceLink,
} from "./handlers/links.js";
import { generateRequestId, parseOrgPublicId, parseProjectPublicId, parseWorkspaceLinkPublicId } from "./ids.js";
import { asUuid } from "@saas/db/ids";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

// OP4 — Tenancy resolution & workspace links (state-api-contract §5).
const ORG_CLI_LINKS_RE = /^\/v1\/organizations\/([^/]+)\/cli\/links$/;
const CLI_LINKS_RESOLVE_PATH = "/v1/cli/links/resolve";
// Console-management surface (list + unlink) for the project Settings → CLI
// page. Org/project-scoped; not part of the CLI contract but the same owner.
const ORG_PROJECT_CLI_LINKS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/cli\/links$/;
const ORG_PROJECT_CLI_LINK_RE =
  /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/cli\/links\/([^/]+)$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const requestId = resolveRequestId(request);
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Health check — no auth required.
  if (pathname === "/health") {
    return handleHealth(env, requestId);
  }

  // OP2/OP3 (run coordination §2, object/log plane §3, catalog heads §3.1) stay
  // dormant — those routes land in later milestones. OP4 brings the workspace-
  // link surface (§5) live behind the api-edge state-facade + actor headers.

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const actor = resolveActor(request);
  if (!actor) {
    return errorResponse("unauthenticated", "Authentication required", 401, requestId);
  }

  // GET /v1/cli/links/resolve?remoteUrl= — org-independent picker.
  if (pathname === CLI_LINKS_RESOLVE_PATH) {
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleResolveWorkspaceLinks(request, env, requestId, actor);
  }

  // POST /v1/organizations/{orgId}/cli/links — create (policy org.cli.link).
  let m = pathname.match(ORG_CLI_LINKS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleCreateWorkspaceLink(request, env, requestId, actor, orgId);
  }

  // GET .../projects/{projectId}/cli/links — console list.
  m = pathname.match(ORG_PROJECT_CLI_LINKS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListWorkspaceLinks(request, env, requestId, actor, orgId, projectId);
  }

  // DELETE .../projects/{projectId}/cli/links/{linkId} — console unlink.
  m = pathname.match(ORG_PROJECT_CLI_LINK_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const linkId = parseWorkspaceLinkPublicId(m[3]!);
    if (!orgId || !projectId || !linkId) return notFound(requestId, pathname);
    if (request.method !== "DELETE") return methodNotAllowed(requestId);
    return handleUnlinkWorkspaceLink(env, requestId, actor, orgId, projectId, asUuid(linkId));
  }

  return notFound(requestId, pathname);
}
