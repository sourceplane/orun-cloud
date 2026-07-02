export interface Env {
  PLATFORM_DB?: Hyperdrive;
  /**
   * Per-run coordination shard (BM2b/BM4). One RunCoordinator Durable Object per
   * run (idFromName(runId)) owns the append-only log + deciders + lease alarm.
   * Bound in all environments; the §3 verbs route here when the coordination
   * backend is the DO. Optional so a misconfigured env fails closed to OP2.
   */
  COORDINATOR?: DurableObjectNamespace;
  /** Object/log blob store (R2 bucket `orun-state`). CAS + log chunks (design §4). */
  ORUN_STATE?: R2Bucket;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  PROJECTS_WORKER?: Fetcher;
  /**
   * config-worker service binding (SM3). The lease-verified secret resolve
   * (POST …/state/runs/{runId}/secrets/resolve) calls config-worker's internal
   * resolve (POST /v1/internal/config/secrets/resolve) over this binding after
   * verifying bearer authz + a live job lease. Absent = the resolve is
   * unavailable (503), never a leak.
   */
  CONFIG_WORKER?: Fetcher;
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

  /**
   * Master kill-switch for object-GC reclamation (OV9). When unset (the default)
   * the collect endpoint can only ever dry-run — it never deletes, regardless of
   * the request. Set to the string "true" per environment to allow an explicit
   * `dryRun: false` collect to actually delete unreachable objects from R2 + the
   * index. Off by default so deletion is a deliberate, per-environment opt-in.
   */
  STATE_GC_COLLECT_ENABLED?: string;

  /**
   * Coordination backend selector (BM4/BM6 cutover). "do" routes the §3 verbs to
   * the RunCoordinator Durable Object; anything else (incl. unset) keeps the OP2
   * relational claim path. Per-environment flag so traffic flips without a
   * redeploy; fails closed to OP2 when the DO binding is absent.
   */
  COORDINATION_BACKEND?: string;
}
