// Internal worker-to-worker seam: resolve a single project by slug (or id) so
// other bounded contexts can map a known org + slug to a project's public id
// and name. First consumer: state-worker's workspace-link surface (OP4), which
// needs the project's slug + name for the link projection and to decide
// whether a project must be created on demand.
//
// Reachable only over Cloudflare service bindings — there is no public route
// to this path and api-edge never forwards /v1/internal/*. No actor, no
// policy: the caller is a platform worker acting on already-authorized input
// (the caller enforces org.cli.link before asking). Ids arrive as raw UUIDs.

import type { Env } from "../env.js";
import { createProjectsRepository } from "@saas/db/projects";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid, isUuid } from "@saas/db/ids";
import { errorResponse, successResponse } from "../http.js";
import { projectPublicId } from "../ids.js";

export async function handleInternalResolveProject(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId") ?? "";
  const projectId = url.searchParams.get("projectId");
  const slug = url.searchParams.get("slug");
  if (!isUuid(orgId)) {
    return errorResponse("bad_request", "orgId must be a UUID", 400, requestId);
  }
  if (!projectId && !slug) {
    return errorResponse("bad_request", "projectId or slug is required", 400, requestId);
  }
  if (projectId && !isUuid(projectId)) {
    return errorResponse("bad_request", "projectId must be a UUID", 400, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createProjectsRepository(executor);
    const result = projectId
      ? await repo.getProjectById(asUuid(orgId), asUuid(projectId))
      : await repo.getProjectBySlug(asUuid(orgId), slug!.toLowerCase());

    if (!result.ok) {
      if (result.error.kind === "not_found") {
        // A clean, expected miss: the caller decides whether to create.
        return successResponse({ project: null }, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    return successResponse(
      {
        project: {
          id: projectPublicId(result.value.id),
          slug: result.value.slug,
          name: result.value.name,
          status: result.value.status,
        },
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
