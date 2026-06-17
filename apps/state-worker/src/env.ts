export interface Env {
  PLATFORM_DB?: Hyperdrive;
  /** Object/log blob store (R2 bucket `orun-state`). CAS + log chunks (design §4). */
  ORUN_STATE?: R2Bucket;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  PROJECTS_WORKER?: Fetcher;
  /**
   * integrations-worker service binding (OV5/IG9 write-back). The run-result
   * driver POSTs a Check Run back to GitHub through this binding; absent =
   * write-back is dormant (a safe no-op, e.g. before the GitHub App exists). The
   * App private key lives in integrations-worker — state-worker never sees it.
   */
  INTEGRATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;

  // ── Per-environment secrets (wrangler secret put; never vars) ──
  // All optional while the worker is dormant (OP0 — health-only). The state
  // surface (run coordination, object/log plane, catalog, workspace links)
  // lands at OP2+ and reads these then; the worker stays health-only until.

  /**
   * Hex-encoded 256-bit key for any at-rest envelope encryption the state
   * plane adds (reserved; unused while dormant).
   */
  STATE_ENCRYPTION_KEY?: string;
}
