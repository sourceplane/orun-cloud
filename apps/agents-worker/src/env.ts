// Bindings the agents-worker declares. Optional (`?`) = safe-by-default when
// unbound: AG5 is the dormant foundation (only /health lives), so the worker
// deploys and reports healthy with nothing wired. AG6 adds the DB + downstream
// service bindings and the per-session Durable Object.

export interface Env {
  /** Pooled Postgres (Hyperdrive) for the agents schema. Absent until AG6. */
  PLATFORM_DB?: Hyperdrive;
  /** Membership worker — resolves the responsible principal for a profile. */
  MEMBERSHIP_WORKER?: Fetcher;
  /** Policy worker — deny-by-default authorization on control-plane routes. */
  POLICY_WORKER?: Fetcher;
  /** Deploy environment name ("dev" | "stage" | "prod" | "local"). */
  ENVIRONMENT: string;
}
