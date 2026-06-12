# saas-performance — Risks & Open Questions

## Hard-won lessons (do not regress)

- **No cross-request connection reuse on Workers.** Task 0134 (#224/#225) added a
  module-scoped postgres client pool; stage rejected it — `Cannot perform I/O on
  behalf of a different request` (membership 500, billing flaky 503; self-heal
  retry insufficient). Reverted (#227) to per-request client + real `dispose()`,
  with a comment documenting why. Any Workers-safe reuse (Hyperdrive driver
  guidance / `ctx.waitUntil(sql.end())`) **must be canaried on stage before
  retry**. It is also largely unnecessary — Hyperdrive pooling already makes the DB
  round-trip ~6ms over floor.
- **Array params are unsafe with `fetch_types:false`.** The PERF3 batched
  role-assignment lookup used `subject_id = ANY($2)` with a JS array, which throws
  at bind time (no array element-type OID). Fixed (#228) with a scalar
  parameterized IN-list (still one batched query; N+1 win preserved). Prefer
  IN-lists over array params; verify **all** DB-backed endpoints after a perf
  change, not just one.

## Open questions

- **PERF6:** which Analytics Engine dataset + dashboard surface for per-route
  p50/p95? Synthetic prober cadence/placement?
- **PERF8:** safe-GET edge cache invalidation key (actor+scope+route) vs mutation
  fan-out — confirm no stale-after-write window for the same actor.
- **PERF9:** Hyperdrive cache-eligibility audit outcome; read-replica trigger
  threshold (traffic level that justifies a Supabase read replica + read routing).
