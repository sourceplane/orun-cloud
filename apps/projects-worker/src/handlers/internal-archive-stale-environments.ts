// Internal worker-to-worker seam: archive environments no longer pushed to. The
// OV9 stale-archival sweep — driven by the state-worker cron (OV9.2), coalesced
// into its single scheduled slot per risk R9.
//
// Reachable only over Cloudflare service bindings — there is no public route to
// this path and api-edge never forwards /v1/internal/*. No actor, no policy: the
// caller is a platform cron acting on retention policy, not a user.
//
// Bounded work: archive at most `limit` of the oldest-inactive active rows past
// the cutoff per call (the cron drains a backlog over successive ticks). Each
// archived environment emits `environment.archived` (system actor); the archive
// + its events commit atomically, so a crash mid-sweep re-archives idempotently
// (an already-archived row is no longer 'active' and is skipped). Reversible — a
// later activity touch revives a row.

import type { Env } from "../env.js";
import type { ProjectsRepository, ProjectsResult, Environment } from "@saas/db/projects";
import type { EventsRepository } from "@saas/db/events";
import { createProjectsRepository } from "@saas/db/projects";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { errorResponse, successResponse } from "../http.js";
import { orgPublicId, projectPublicId, environmentPublicId } from "../ids.js";

const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export interface HandleInternalArchiveStaleEnvironmentsDeps {
  projectsRepo?: ProjectsRepository;
  eventsRepo?: EventsRepository;
}

export async function handleInternalArchiveStaleEnvironments(
  request: Request,
  env: Env,
  requestId: string,
  deps?: HandleInternalArchiveStaleEnvironmentsDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB && !(deps?.projectsRepo && deps?.eventsRepo)) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  // Body is optional; bad JSON falls back to defaults rather than erroring (a
  // cron call may send an empty body).
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }

  const olderThanDays = clampInt(body.olderThanDays, DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS);
  const limit = clampInt(body.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

  const executor = deps?.projectsRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - olderThanDays * DAY_MS);

    const doSweep = async (
      projectsRepo: ProjectsRepository,
      eventsRepo: EventsRepository,
    ): Promise<ProjectsResult<Environment[]>> => {
      const archived = await projectsRepo.archiveStaleEnvironments(cutoff, now, limit);
      if (!archived.ok) return archived;

      for (const e of archived.value) {
        const eventResult = await eventsRepo.appendEventWithAudit({
          event: {
            id: crypto.randomUUID(),
            type: "environment.archived",
            version: 1,
            source: "projects-worker",
            occurredAt: now,
            actorType: "system",
            actorId: "system",
            orgId: e.orgId,
            projectId: e.projectId,
            environmentId: e.id,
            subjectKind: "environment",
            subjectId: e.id,
            subjectName: e.name,
            requestId,
            payload: {
              environmentId: environmentPublicId(e.id),
              projectId: projectPublicId(e.projectId),
              orgId: orgPublicId(e.orgId),
              name: e.name,
              reason: "stale",
              retentionDays: olderThanDays,
              lastActiveAt: e.lastActiveAt.toISOString(),
            },
          },
          audit: {
            id: crypto.randomUUID(),
            category: "projects",
            description: `Archived stale environment "${e.name}" (no activity for ${olderThanDays}d)`,
            projectId: e.projectId,
            environmentId: e.id,
          },
        });
        if (!eventResult.ok) throw new Error("event_append_failed");
      }
      return archived;
    };

    let result: ProjectsResult<Environment[]>;
    if (deps?.projectsRepo && deps?.eventsRepo) {
      result = await doSweep(deps.projectsRepo, deps.eventsRepo);
    } else {
      result = await executor!.transaction(async (txExecutor) => {
        const projectsRepo = createProjectsRepository(txExecutor);
        const eventsRepo = createEventsRepository(txExecutor);
        return doSweep(projectsRepo, eventsRepo);
      });
    }

    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse(
      {
        archived: result.value.length,
        retentionDays: olderThanDays,
        environmentIds: result.value.map((e) => environmentPublicId(e.id)),
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
