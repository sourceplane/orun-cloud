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
  /** Config worker — provider-key custody (store/resolve, AG12). */
  CONFIG_WORKER?: Fetcher;
  /** Identity worker — agent-session token mint (AG6 §3.2). */
  IDENTITY_WORKER?: Fetcher;
  /** Billing worker — the feature.agents entitlement gate (AG10). */
  BILLING_WORKER?: Fetcher;
  /** Metering worker — usage emission (AG10). */
  METERING_WORKER?: Fetcher;
  /** Per-session attach relay Durable Object (saas-agents-live AL6): one DO
   * per session, the SSE fan-out + input return-queue. Absent in the dormant
   * posture; attach/input routes 503 until wired. */
  SESSION_RELAY?: DurableObjectNamespace;
  /** Deploy environment name ("dev" | "stage" | "prod" | "local"). */
  ENVIRONMENT: string;
}
