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
   * per session, the SSE fan-out + input return-queue. The DRAINING class of
   * the AN1 re-platform (saas-agents-native, lock 7): sessions created before
   * RELAY_CUTOVER_AT stay here until lease + retention expire; the binding is
   * deleted one release after the cutover. */
  SESSION_RELAY?: DurableObjectNamespace;
  /** The SDK relay (saas-agents-native AN1): `AttachRelay extends Agent` —
   * WS head attach with hibernation, SSE + long-poll retained as fallback,
   * RelayCore verbatim. New sessions route here when bound. */
  ATTACH_RELAY?: DurableObjectNamespace;
  /** Session-epoch cutover instant (ISO 8601): sessions created before it
   * drain on SESSION_RELAY, at/after it land on ATTACH_RELAY. Unset with both
   * classes bound ⇒ everything routes to ATTACH_RELAY (fresh environments). */
  RELAY_CUTOVER_AT?: string;
  /** Deploy environment name ("dev" | "stage" | "prod" | "local"). */
  ENVIRONMENT: string;
}
