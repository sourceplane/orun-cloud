export interface Env {
  PLATFORM_DB?: Hyperdrive;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /**
   * Brokered secrets (saas-integration-hub IH7): validate-binding at secret
   * create + mint-at-resolve, both over integrations-worker's internal
   * service-binding-only routes.
   */
  INTEGRATIONS_WORKER?: Fetcher;
  /** IH7: the `limit.brokered_secrets` entitlement gate on brokered creation. */
  BILLING_WORKER?: Fetcher;
  ENVIRONMENT: string;
  /** Hex-encoded 256-bit key for secret payload encryption (AES-256-GCM). */
  SECRET_ENCRYPTION_KEY?: string;
  /**
   * Hex-encoded 256-bit key-encryption key (SM2): wraps/unwraps the per-workspace
   * DEKs in config.secret_deks. When set, all new secret writes produce v:2
   * envelopes; when absent, writes fall back to the v:1 SECRET_ENCRYPTION_KEY
   * path. Delivered as a plain worker secret for now — the Cloudflare Secrets
   * Store binding is deferred to the saas-secrets-sync SS4 epic.
   */
  SECRET_KEK?: string;
}
