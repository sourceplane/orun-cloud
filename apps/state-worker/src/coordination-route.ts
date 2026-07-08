// Coordination routing (BM4b — coordination-api.md §3). The seam that sends the
// claim/heartbeat/complete/cancel verbs (and run init) to the per-run
// RunCoordinator Durable Object when the environment selects the DO backend. The
// DO is already §3-wire-conformant, so the handler layer authenticates and then
// *proxies* the DO's response verbatim — no envelope reshaping. When the backend
// is OP2 (default) or the binding is absent, the handlers keep the relational
// path and never call here.

import type { RunFoldState } from "@saas/contracts/coordination";
import { planProjection } from "@saas/contracts/coordination-projector";
import { gateObservationsFromRunFold, insertWorkObservation } from "@saas/db/work";
import { applyProjection, type ProjectionScope } from "@saas/db/state";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import type { Env } from "./env.js";

/** Plan job as parsed from a create-run body. */
export interface CoordinationPlanJob {
  jobId: string;
  deps?: string[];
  component?: string | null;
}

/** Actor stamp forwarded onto coordination events. */
export interface CoordinationActorStamp {
  id: string;
  type: string;
}

/** True when this environment routes coordination to the DO (fails closed to OP2). */
export function useDoCoordination(env: Env): boolean {
  return env.COORDINATION_BACKEND === "do" && env.COORDINATOR !== undefined;
}

/** The per-run DO stub, addressed by the public runId (ULID) — one shard per run. */
export function coordinatorStub(env: Env, runId: string): DurableObjectStub {
  const ns = env.COORDINATOR!;
  return ns.get(ns.idFromName(runId));
}

/** Map the create-run plan DAG into the DO's plan shape ({ jobs: { id: { deps } } }). */
export function planFromJobs(jobs: CoordinationPlanJob[]): { jobs: Record<string, { deps: string[] }> } {
  const out: Record<string, { deps: string[] }> = {};
  for (const j of jobs) out[j.jobId] = { deps: j.deps ?? [] };
  return { jobs: out };
}

async function callCoordinator(
  env: Env,
  runId: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  const stub = coordinatorStub(env, runId);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  // The hostname is irrelevant — the stub routes by path only.
  return stub.fetch(`https://coordinator${path}`, init);
}

/** Re-emit a DO response as a fresh Response (status + JSON body preserved). */
async function proxy(doResponse: Response): Promise<Response> {
  const text = await doResponse.text();
  return new Response(text, {
    status: doResponse.status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Idempotently initialize the run shard (RunCreated). Same plan ⇒ 200; different plan ⇒ 409. */
export async function initCoordinator(
  env: Env,
  runId: string,
  init: { plan: { jobs: Record<string, { deps: string[] }> }; planDigest: string; sourceHash: string; environment?: string | null; actor?: CoordinationActorStamp },
): Promise<Response> {
  return callCoordinator(env, runId, "POST", "/init", { runId, ...init });
}

/** Proxy one §3 mutating verb (claim|heartbeat|complete|cancel) to the run shard. */
export async function proxyCoordinatorVerb(
  env: Env,
  runId: string,
  verb: "claim" | "heartbeat" | "complete" | "cancel",
  body: Record<string, unknown>,
): Promise<Response> {
  return proxy(await callCoordinator(env, runId, "POST", `/${verb}`, body));
}

/** Proxy the §2 event-log read (GET /log?from=) to the run shard. */
export async function proxyCoordinatorLog(env: Env, runId: string, fromSeq: number, waitSeconds = 0): Promise<Response> {
  const wait = waitSeconds > 0 ? `&wait=${waitSeconds}` : "";
  return proxy(await callCoordinator(env, runId, "GET", `/log?from=${fromSeq}${wait}`));
}

/** Serve the §2 frontier read (GET /frontier) — the runnable job ids, projected
 *  from the shard's fold. An absent/uninitialized shard yields an empty frontier. */
export async function proxyCoordinatorFrontier(env: Env, runId: string): Promise<Response> {
  const fold = await readCoordinatorState(env, runId);
  const jobs = fold?.frontier ?? [];
  return new Response(JSON.stringify({ jobs }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── Run backing check ───────────────────────────────────────────────────────

// Isolate-local set of run ULIDs confirmed DO-backed. Backing is MONOTONIC — a
// run, once seeded, stays shard-backed for its entire life (the shard is never
// torn down mid-run) — so a positive result is safe to cache for the isolate's
// lifetime. This is the hot-path fix for high-concurrency runs: the native gate
// runs `runIsDoBacked` on EVERY verb (claim/heartbeat/complete AND every log
// long-poll and frontier read), and without the cache each call is a full
// `GET /state` on the single-threaded per-run DO, which serializes the ENTIRE
// run fold every time. With ~90 runners on one run-shard (CI fans a whole DAG
// onto one exec-id) that fold-serialization storm saturates the shard and the
// verbs stall. Caching collapses it to one `GET /state` per run per isolate.
// A negative result is never cached, so a not-yet-seeded run still self-heals.
const doBackedRuns = new Set<string>();
// Hygiene bound: isolates are recycled often and entries are short ULIDs, but
// cap the set so a very long-lived isolate seeing many runs can't grow it
// without limit. Clearing only forces a re-probe (one GET /state), never wrong.
const DO_BACKED_CACHE_CAP = 20_000;

function markDoBacked(runId: string): void {
  if (doBackedRuns.size >= DO_BACKED_CACHE_CAP) doBackedRuns.clear();
  doBackedRuns.add(runId);
}

/** Test seam: drop the isolate-local backed-run cache so each case starts cold. */
export function __resetDoBackedCache(): void {
  doBackedRuns.clear();
}

/**
 * True iff this run has an initialized DO shard, so its verbs route to the DO.
 * The coordination backend is sticky PER RUN: a run created on OP2 (no shard)
 * keeps finishing on OP2 even after the flag flips, and a DO-backed run keeps
 * using the DO even if the flag flips back. useDoCoordination only governs
 * whether a NEW run (createRun) seeds a shard — so flipping the flag never breaks
 * an in-flight run. A run is DO-backed exactly when /state reports its runId.
 *
 * Result is cached per isolate once positive (backing is monotonic) so the
 * per-verb existence check stops re-serializing the DO fold under load.
 */
export async function runIsDoBacked(env: Env, runId: string): Promise<boolean> {
  if (env.COORDINATOR === undefined) return false;
  if (doBackedRuns.has(runId)) return true;
  const fold = await readCoordinatorState(env, runId);
  const backed = fold !== null && fold.runId === runId;
  if (backed) markDoBacked(runId);
  return backed;
}

/**
 * Gate for the native coordination verbs: is this run served by a DO shard?
 *
 * DELIBERATELY does NOT lazy-seed. An earlier version rebuilt a missing shard
 * from the persisted `run_jobs`, but `createRun` inserts those rows one-by-one,
 * so a claim racing an in-flight create read a PARTIAL `run_jobs` set and seeded
 * the shard with a subset of the plan. Because the DO's `init` is idempotent by
 * planDigest and the partial seed reused the FULL plan's digest, the partial plan
 * stuck and `createRun`'s later full seed was silently dropped — jobs outside the
 * subset then `:claim` → `not_found` forever (the CI stall). `createRun` already
 * seeds the complete plan from the request body, and its fail-fast guard means a
 * created run is always seeded, so the only correct answer here is "is it backed
 * yet?" — a not-yet-seeded run transiently 404s and the client retries.
 */
export async function ensureRunShard(env: Env, runUlid: string): Promise<boolean> {
  return useDoCoordination(env) && (await runIsDoBacked(env, runUlid));
}

// ── Projection trigger (BM3c) ───────────────────────────────────────────────
// After a state-changing verb, fold the shard and project it into Postgres so
// reads (status/jobs) stay fresh. The DO is the authority; this keeps the
// delayed read model close behind, seq-guarded so it is safe to run repeatedly.

/** Read the run shard's folded state (GET /state → RunFoldState), or null.
 *  Exported for the SM3 lease verification (lease.ts) — the resolve route
 *  checks the DO fold's (phase, holder, leaseEpoch, leaseExpiresAt) directly. */
export async function readCoordinatorState(env: Env, runId: string): Promise<RunFoldState | null> {
  const res = await callCoordinator(env, runId, "GET", "/state");
  if (!res.ok) return null;
  return (await res.json()) as RunFoldState;
}

/** Fold the shard and apply the projection (guarded by the run's stored last_seq). */
export async function projectCoordinatorRun(
  env: Env,
  executor: SqlExecutor,
  scope: ProjectionScope,
  runId: string,
): Promise<void> {
  const fold = await readCoordinatorState(env, runId);
  if (fold === null) return;
  const cur = await executor.execute<{ last_seq: string | number; git_commit: string | null }>(
    `SELECT last_seq, git_commit FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid = $3`,
    [scope.orgId, scope.projectId, runId],
  );
  const appliedSeq = cur.rows[0] ? Number(cur.rows[0].last_seq) : 0;
  await applyProjection(executor, scope, planProjection(fold, appliedSeq));

  // orun-work v2 (WP3): terminal jobs are gate verdicts — orun's OWN
  // execution truth (P-3), keyed to the run's git revision. Idempotent per
  // (run, job, phase), so sweeps and per-verb projections re-emit safely.
  const gitCommit = cur.rows[0] ? ((cur.rows[0].git_commit as string | null) ?? null) : null;
  const gates = gateObservationsFromRunFold(runId, gitCommit, fold, new Date().toISOString());
  for (const draft of gates) {
    await insertWorkObservation(executor, scope.orgId, { ...draft, workspace: scope.orgId });
  }
}

/**
 * Handler-side projection: best-effort, never fails the verb (the read model is
 * eventually consistent — the DO log is the source of truth). Manages its own
 * executor unless the caller injects one (tests).
 */
export async function projectAfterVerb(
  env: Env,
  deps: { executor?: SqlExecutor } | undefined,
  scope: ProjectionScope,
  runId: string,
  ctx?: ExecutionContext,
): Promise<void> {
  if (!env.PLATFORM_DB && !deps?.executor) return;
  // BM3 / DB-protection at scale: when an ExecutionContext is provided, defer
  // the projection to `ctx.waitUntil` so the verb response is not blocked on a
  // DB roundtrip. The projection still runs (the worker keeps the request alive
  // until the deferred promise settles), and the bounded projection sweep is the
  // safety net if it ever fails. Without a ctx (e.g. unit tests, ad-hoc calls)
  // we keep the synchronous path so callers can deterministically observe the
  // post-verb read-model state.
  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const ownsExecutor = !deps?.executor;
  const work = async () => {
    try {
      await projectCoordinatorRun(env, executor, scope, runId);
    } catch (err) {
      // Eventually consistent: a projection failure must never fail the verb —
      // but it must never be invisible either. A persistent failure here (e.g.
      // the BM3 `state.runs.last_seq` column missing because migration 350 was
      // not applied before the COORDINATION_BACKEND=do cutover) silently freezes
      // the read model into a DO/Postgres split-brain. Surface it loudly so
      // tail/alerting catches it instead of clients seeing a run that never
      // progresses.
      console.error(`[projection] run ${runId} projection failed (read model may be stale): ${String(err)}`);
    } finally {
      if (ownsExecutor && "dispose" in executor) {
        await (executor as unknown as { dispose: () => Promise<void> }).dispose();
      }
    }
  };
  if (ctx) {
    ctx.waitUntil(work());
    return;
  }
  await work();
}

// ── Projector-readiness gate (fail-closed cutover) ──────────────────────────
// The DO backend is only safe for a NEW run once the projector can write its
// fold into Postgres — i.e. migration 350 (state.runs.last_seq) is applied on
// this environment. Until then, seeding a shard yields a silent split-brain: the
// DO holds the truth while the read model freezes at creation. Probe the column
// once and cache a positive result for the isolate's life; a negative result is
// NOT cached, so the worker honors the cutover the moment the migration lands —
// no redeploy. This is what makes useDoCoordination's "fails closed to OP2"
// contract real for the createRun seeding decision.
let projectorReadyCache = false;

/**
 * True once `state.runs.last_seq` (migration 350) is confirmed present, so the
 * projector can keep the read model in sync. Fails closed (false) on any probe
 * error: a new run then stays on the fully-functional OP2 relational path
 * instead of stranding in a DO/Postgres split-brain.
 */
export async function projectorReady(executor: SqlExecutor): Promise<boolean> {
  if (projectorReadyCache) return true;
  try {
    await executor.execute("SELECT last_seq FROM state.runs LIMIT 0");
    projectorReadyCache = true;
    return true;
  } catch {
    return false;
  }
}

/** Test seam: clear the cached probe result so each case starts cold. */
export function __resetProjectorReadyCache(): void {
  projectorReadyCache = false;
}
