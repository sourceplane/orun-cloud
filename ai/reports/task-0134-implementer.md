# Task 0134 — PERF: DB connection reuse (module-scoped client pool)

Branch `impl/task-0134-connection-reuse`. The deferred high-impact lever from
PERF3. Backend (packages/db executor). No contract/signature change.

## Why

Every handler called `createSqlExecutor(env.SOURCEPLANE_DB)` per request, which
built a fresh `postgres()` client and `sql.end()`-ed it on dispose. So the
TLS/auth handshake to Hyperdrive recurred on **every request in every worker**
— the dominant per-worker latency floor (~0.5–1s) still visible after PERF2/3.

## What shipped

`packages/db/src/hyperdrive/executor.ts`:

- **Module-scoped client pool** keyed by connection string. The production
  default path (`createSqlExecutor(binding)` with no injected factory) now
  **reuses one warm `postgres()` client across requests** instead of creating +
  ending one per request. `dispose()` is a **no-op** on this path (the pooled
  client persists for the warm isolate); Hyperdrive pools the actual Postgres
  connections server-side.
- **Self-healing**: if a query fails with a connection-level error (including
  the Workers "Cannot perform I/O on behalf of a different request" case), the
  cached client is evicted, recreated, and the operation retried **once**. The
  retry fires only for connection errors — never constraint/business errors —
  and a write that hit a connection error has not committed, so re-running is
  safe.
- **Unchanged behavior for the injected-factory path** (unit tests / special
  cases): per-instance client with a real `dispose()` (`sql.end`), no pooling —
  so all existing executor tests pass verbatim.

This is intentionally a **measured, reversible** change: the self-heal degrades
gracefully if the runtime rejects cross-request reuse, and reverting is a
one-file change.

## Tests & gates

- New `tests/db/src/executor-pool.test.ts` (via `__poolTestHooks`): reuse of one
  client across executors for a connection string, separate clients per string,
  self-heal (evict→recreate→retry-once→succeed), **no** retry on a business
  error, `dispose()` no-op on the pooled path, and `isConnectionError`
  classification.
- db **531** (incl. the 12 original executor tests unchanged + 6 new), and the
  **full repo suite passes** (api-edge 313, membership 247, billing 65, …).
- Fixed an unrelated **pre-existing** failure surfaced because this db change
  makes `config-worker-tests` run in CI: `deployment-config.test.ts`'s
  placeholder scan matched a *comment* in identity-worker's wrangler (OAuth
  setup notes mention "placeholders"); it now strips `//` comments before
  scanning for placeholder Hyperdrive IDs.
- typecheck (repo-wide) + lint clean.

## Stage verification (post-deploy)

Re-measure authed-endpoint TTFB; expect the per-worker connection-setup floor to
drop on warm isolates (notably `/projects`, which still carried ~1.3s of
connect+query across two workers). Watch stage logs for any connection / "I/O on
behalf of a different request" errors — the self-heal should keep responses
succeeding regardless; persistent errors would be the signal to revert.
