// Internal worker-to-worker seam: create-or-touch an environment from a system
// activity signal (a run/plan referencing it). The OV9 liveness touch.
//
// Reachable only over Cloudflare service bindings — there is no public route to
// this path and api-edge never forwards /v1/internal/*. No actor, no policy, no
// billing gate: the caller is a platform worker materializing an environment the
// user already referenced (system-initiated, not a user action), so it must not
// be quota-blocked. Idempotent: the first call inserts, later calls bump
// last_active_at and revive an archived row.
//
// On a fresh insert it emits `environment.created` (system actor) so the audit
// trail stays complete; a touch of an existing row emits nothing.

import type { Env } from "../env.js";
import type { ProjectsRepository, ProjectsResult, Environment } from "@saas/db/projects";
import type { EventsRepository } from "@saas/db/events";
import { createProjectsRepository } from "@saas/db/projects";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid, isUuid } from "@saas/db/ids";
import { errorResponse, successResponse, validationError } from "../http.js";
import { orgPublicId, projectPublicId, environmentPublicId } from "../ids.js";

const NAME_MIN = 1;
const NAME_MAX = 100;
const SLUG_MAX = 63;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function deriveSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX) || "environment"
  );
}

export interface HandleInternalRegisterEnvironmentDeps {
  projectsRepo?: ProjectsRepository;
  eventsRepo?: EventsRepository;
}

export async function handleInternalRegisterEnvironment(
  request: Request,
  env: Env,
  requestId: string,
  deps?: HandleInternalRegisterEnvironmentDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB && !(deps?.projectsRepo && deps?.eventsRepo)) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const orgId = typeof body.orgId === "string" ? body.orgId : "";
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!isUuid(orgId) || !isUuid(projectId)) {
    return errorResponse("bad_request", "orgId and projectId must be UUIDs", 400, requestId);
  }

  const fields: Record<string, string[]> = {};
  const name = typeof body.name === "string" ? body.name : "";
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    fields.name = [`Must be a string between ${NAME_MIN} and ${NAME_MAX} characters`];
  }
  let slug: string;
  if (body.slug !== undefined && body.slug !== null) {
    if (typeof body.slug !== "string" || !SLUG_RE.test(body.slug) || body.slug.length > SLUG_MAX) {
      fields.slug = ["Must be a valid slug"];
      slug = "";
    } else {
      slug = body.slug;
    }
  } else {
    slug = deriveSlug(name);
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const executor = deps?.projectsRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const orgUuid = asUuid(orgId);
    const projectUuid = asUuid(projectId);
    const environmentId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const now = new Date();

    const doRegister = async (projectsRepo: ProjectsRepository, eventsRepo: EventsRepository) => {
      const result = await projectsRepo.registerEnvironmentActivity({
        id: environmentId,
        orgId: orgUuid,
        projectId: projectUuid,
        name,
        slug,
        slugLower: slug.toLowerCase(),
        at: now,
      });
      if (!result.ok) return result;

      // First materialization only: record the auto-created environment.
      if (result.value.created) {
        const eventResult = await eventsRepo.appendEventWithAudit({
          event: {
            id: eventId,
            type: "environment.created",
            version: 1,
            source: "projects-worker",
            occurredAt: now,
            actorType: "system",
            actorId: "system",
            orgId: orgUuid,
            projectId: projectUuid,
            environmentId: result.value.environment.id,
            subjectKind: "environment",
            subjectId: result.value.environment.id,
            subjectName: result.value.environment.name,
            requestId,
            payload: {
              environmentId: environmentPublicId(result.value.environment.id),
              projectId: projectPublicId(projectUuid),
              orgId: orgPublicId(orgUuid),
              name: result.value.environment.name,
              slug: result.value.environment.slug,
              autoRegistered: true,
            },
          },
          audit: {
            id: auditId,
            category: "projects",
            description: `Registered environment "${result.value.environment.name}" on first use`,
            projectId: projectUuid,
            environmentId: result.value.environment.id,
          },
        });
        if (!eventResult.ok) throw new Error("event_append_failed");
      }

      return result;
    };

    let result: ProjectsResult<{ environment: Environment; created: boolean }>;
    if (deps?.projectsRepo && deps?.eventsRepo) {
      result = await doRegister(deps.projectsRepo, deps.eventsRepo);
    } else {
      result = await executor!.transaction(async (txExecutor) => {
        const projectsRepo = createProjectsRepository(txExecutor);
        const eventsRepo = createEventsRepository(txExecutor);
        return doRegister(projectsRepo, eventsRepo);
      });
    }

    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse(
      {
        environment: {
          id: result.value.environment.id,
          slug: result.value.environment.slug,
          name: result.value.environment.name,
          status: result.value.environment.status,
        },
        created: result.value.created,
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
