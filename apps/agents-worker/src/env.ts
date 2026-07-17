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
  /** The per-session attach relay (saas-agents-native AN1): `AttachRelay
   * extends Agent` — WS head attach with hibernation, SSE + long-poll retained
   * as fallback, RelayCore verbatim. Every session lives here; the pre-AN1
   * `SessionRelay` KV class and its `RELAY_CUTOVER_AT` gate were decommissioned
   * once the cutover completed (lock 7). Optional = dormant when unbound. */
  ATTACH_RELAY?: DurableObjectNamespace;
  /** Deploy environment name ("dev" | "stage" | "prod" | "local"). */
  ENVIRONMENT: string;
}
