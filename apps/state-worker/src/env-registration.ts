// Environment auto-registration (OP4 deliverable 3).
//
// When a run or plan first references an environment by name, the platform
// registers it so it shows up as a real `projects.environments` row (stacks,
// drift, secrets all key off environment identity). This is the SEAM OP2 wires
// into run-create — it is intentionally dormant here: no run route calls it
// yet. Kept minimal, idempotent, and unit-tested so OP2 only has to call it.
//
// Idempotency is delegated to projects-worker's unique (project, slug) index:
// a duplicate registration comes back 409 and we report `created: false`
// rather than erroring. A bad/empty name is a no-op (returns `skipped`) so a
// run is never blocked by an un-namable environment.

import { registerEnvironment } from "./projects-client.js";

const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;

export type EnvRegistrationOutcome =
  | { kind: "registered" }
  | { kind: "exists" }
  | { kind: "skipped"; reason: "empty_name" | "invalid_name" }
  | { kind: "error"; status: number };

/**
 * Ensure the named environment exists for a project, idempotently. Safe to
 * call on every run/plan referencing the name — the first call creates it, the
 * rest are cheap no-ops. `environmentName` is the human name; projects-worker
 * derives the slug.
 */
export async function ensureEnvironmentRegistered(
  projectsWorker: Fetcher,
  orgPublicId: string,
  projectPublicId: string,
  environmentName: string | null | undefined,
  actor: { subjectId: string; subjectType: string },
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

  const result = await registerEnvironment(
    projectsWorker,
    orgPublicId,
    projectPublicId,
    trimmed,
    actor,
    requestId,
  );
  if (!result.ok) {
    return { kind: "error", status: result.status };
  }
  return result.created ? { kind: "registered" } : { kind: "exists" };
}
