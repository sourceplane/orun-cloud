// Environment auto-registration + liveness touch (OP4 deliverable 3 / OV9).
//
// When a run or plan references an environment by name, the platform registers
// it so it shows up as a real `projects.environments` row (stacks, drift,
// secrets all key off environment identity) AND bumps its last_active_at
// liveness signal — so an actively-used environment is never wrongly archived by
// the OV9 stale-archival sweep. This is the seam OP2 wires into run-create and
// OV9.2 also wires into catalog head-advance.
//
// Idempotent + system-initiated: the internal register route upserts on
// (org, project, slug), so a re-reference is a cheap liveness bump (`created`
// false) rather than a conflict. A bad/empty name is a no-op (returns `skipped`)
// so a run is never blocked by an un-namable environment.

import { registerEnvironmentActivity } from "./projects-client.js";

const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;

export type EnvRegistrationOutcome =
  | { kind: "registered" }
  | { kind: "exists" }
  | { kind: "skipped"; reason: "empty_name" | "invalid_name" }
  | { kind: "error"; status: number };

/**
 * Ensure the named environment exists for a project and mark it active,
 * idempotently. Safe to call on every run/plan/catalog-push referencing the
 * name — the first call creates it, the rest bump last_active_at. `orgId` and
 * `projectId` are raw UUIDs; projects-worker derives the slug from the name.
 */
export async function ensureEnvironmentRegistered(
  projectsWorker: Fetcher,
  orgId: string,
  projectId: string,
  environmentName: string | null | undefined,
  requestId: string,
): Promise<EnvRegistrationOutcome> {
  if (environmentName == null) {
    return { kind: "skipped", reason: "empty_name" };
  }
  const trimmed = environmentName.trim();
  if (trimmed.length === 0) {
    return { kind: "skipped", reason: "empty_name" };
  }
  if (!ENV_NAME_RE.test(trimmed)) {
    return { kind: "skipped", reason: "invalid_name" };
  }

  const result = await registerEnvironmentActivity(projectsWorker, orgId, projectId, trimmed, requestId);
  if (!result.ok) {
    return { kind: "error", status: result.status };
  }
  return result.created ? { kind: "registered" } : { kind: "exists" };
}
