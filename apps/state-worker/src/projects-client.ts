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
// uses the same public create-environment route; a 409 is the idempotent
// "already registered" case and is treated as success.

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

export type RegisterEnvironmentResult =
  | { ok: true; created: boolean }
  | { ok: false; status: number };

/**
 * Idempotently register an environment by slug on first reference (OP4). A 409
 * (already exists) is the success-no-op case. Forwards the actor so
 * projects-worker runs `environment.create`.
 */
export async function registerEnvironment(
  projectsWorker: Fetcher,
  orgPublicId: string,
  projectPublicId: string,
  name: string,
  actor: { subjectId: string; subjectType: string },
  requestId: string,
): Promise<RegisterEnvironmentResult> {
  let response: Response;
  try {
    const target = new URL(
      `/v1/organizations/${orgPublicId}/projects/${projectPublicId}/environments`,
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
      body: JSON.stringify({ name }),
    });
  } catch {
    return { ok: false, status: 503 };
  }
  if (response.status === 409) return { ok: true, created: false };
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, created: true };
}
