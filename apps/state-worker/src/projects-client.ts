// Internal calls to projects-worker (service-binding only).
//
// The workspace-link surface (OP4) maps a git remote to an org + project. When
// the actor names a project that does not exist yet, we create it on demand
// (the contract's "creates project if absent" — design §2). Project lifecycle
// is owned by projects-worker, so state-worker never writes projects.projects
// directly; it forwards the actor's identity and lets projects-worker run its
// own `project.create` policy + entitlement gate.
//
// Env auto-registration (OP4: "register the environment on first run/plan")
// uses the internal create-or-touch route (OV9): it materializes the
// environment if absent AND bumps its last_active_at liveness signal on every
// reference, so an actively-used environment is never wrongly archived by the
// OV9 stale-archival sweep. System-initiated (no actor / policy / billing gate);
// the run/plan already happened, so materialization is not quota-blocked.

export interface ResolvedProject {
  id: string;
  slug: string;
  name: string;
  status: string;
}

export type ResolveProjectResult =
  | { ok: true; project: ResolvedProject | null }
  | { ok: false };

/** Resolve a project by public id or slug. `{ project: null }` is a clean miss. */
export async function resolveProject(
  projectsWorker: Fetcher,
  orgUuid: string,
  by: { slug?: string; projectId?: string },
  requestId: string,
): Promise<ResolveProjectResult> {
  let response: Response;
  try {
    const target = new URL("/v1/internal/projects/resolve", "http://projects-worker");
    target.searchParams.set("orgId", orgUuid);
    if (by.projectId) target.searchParams.set("projectId", by.projectId);
    if (by.slug) target.searchParams.set("slug", by.slug);
    response = await projectsWorker.fetch(target.toString(), {
      method: "GET",
      headers: { "x-request-id": requestId },
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) return { ok: false };
  const data = (parsed as { data: unknown }).data;
  if (!data || typeof data !== "object" || !("project" in data)) return { ok: false };
  const project = (data as { project: unknown }).project;
  if (project === null) return { ok: true, project: null };
  if (
    !project ||
    typeof project !== "object" ||
    typeof (project as ResolvedProject).id !== "string" ||
    typeof (project as ResolvedProject).slug !== "string"
  ) {
    return { ok: false };
  }
  return { ok: true, project: project as ResolvedProject };
}

export type CreateProjectResult =
  | { ok: true; project: ResolvedProject }
  | { ok: false; status: number };

/**
 * Create a project on demand, forwarding the actor so projects-worker enforces
 * `project.create` + the org's project-count entitlement. A 409 (slug taken,
 * lost the create race) is surfaced so the caller can fall back to a resolve.
 */
export async function createProject(
  projectsWorker: Fetcher,
  orgPublicId: string,
  body: { name: string; slug?: string },
  actor: { subjectId: string; subjectType: string },
  requestId: string,
): Promise<CreateProjectResult> {
  let response: Response;
  try {
    const target = new URL(
      `/v1/organizations/${orgPublicId}/projects`,
      "http://projects-worker",
    );
    response = await projectsWorker.fetch(target.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-actor-subject-id": actor.subjectId,
        "x-actor-subject-type": actor.subjectType,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 503 };
  }
  if (!response.ok) return { ok: false, status: response.status };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, status: 502 };
  }
  const project =
    parsed && typeof parsed === "object" && "data" in parsed
      ? (parsed as { data: { project?: unknown } }).data?.project
      : undefined;
  if (
    !project ||
    typeof project !== "object" ||
    typeof (project as ResolvedProject).id !== "string"
  ) {
    return { ok: false, status: 502 };
  }
  return { ok: true, project: project as ResolvedProject };
}

export interface ResolvedEnvironment {
  id: string;
  slug: string;
  name: string;
  status: string;
}

export type ListEnvironmentsResult =
  | { ok: true; environments: ResolvedEnvironment[] }
  | { ok: false };

/**
 * List a project's environments via the internal seam (id + slug + status).
 * Used by the SM3 secrets resolve to translate a ref's environment slug to the
 * environment UUID the config plane scopes by. `orgId`/`projectId` are raw
 * UUIDs. Fails closed.
 */
export async function listProjectEnvironments(
  projectsWorker: Fetcher,
  orgId: string,
  projectId: string,
  requestId: string,
): Promise<ListEnvironmentsResult> {
  let response: Response;
  try {
    const target = new URL("/v1/internal/projects/environments", "http://projects-worker");
    target.searchParams.set("orgId", orgId);
    target.searchParams.set("projectId", projectId);
    response = await projectsWorker.fetch(target.toString(), {
      method: "GET",
      headers: { "x-request-id": requestId },
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false };
  }
  const environments =
    parsed && typeof parsed === "object" && "data" in parsed
      ? (parsed as { data: { environments?: unknown } }).data?.environments
      : undefined;
  if (!Array.isArray(environments)) return { ok: false };
  const items: ResolvedEnvironment[] = [];
  for (const e of environments) {
    if (
      e &&
      typeof e === "object" &&
      typeof (e as ResolvedEnvironment).id === "string" &&
      typeof (e as ResolvedEnvironment).slug === "string"
    ) {
      items.push(e as ResolvedEnvironment);
    }
  }
  return { ok: true, environments: items };
}

export type RegisterEnvironmentResult =
  | { ok: true; created: boolean }
  | { ok: false; status: number };

/**
 * Create-or-touch an environment on activity (OV9), via the internal
 * service-binding route. Materializes the environment if absent and bumps its
 * last_active_at liveness signal (reviving an archived row). `created` reports
 * whether this call freshly inserted it. `orgId`/`projectId` are raw UUIDs (the
 * internal endpoint takes ids in the body, not public ids in the path).
 */
export async function registerEnvironmentActivity(
  projectsWorker: Fetcher,
  orgId: string,
  projectId: string,
  name: string,
  requestId: string,
): Promise<RegisterEnvironmentResult> {
  let response: Response;
  try {
    const target = new URL(
      "/v1/internal/projects/environments/register",
      "http://projects-worker",
    );
    response = await projectsWorker.fetch(target.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify({ orgId, projectId, name }),
    });
  } catch {
    return { ok: false, status: 503 };
  }
  if (!response.ok) return { ok: false, status: response.status };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, status: 502 };
  }
  const created =
    parsed && typeof parsed === "object" && "data" in parsed
      ? (parsed as { data: { created?: unknown } }).data?.created === true
      : false;
  return { ok: true, created };
}
