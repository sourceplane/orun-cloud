// Coordination routing (BM4b — coordination-api.md §3). The seam that sends the
// claim/heartbeat/complete/cancel verbs (and run init) to the per-run
// RunCoordinator Durable Object when the environment selects the DO backend. The
// DO is already §3-wire-conformant, so the handler layer authenticates and then
// *proxies* the DO's response verbatim — no envelope reshaping. When the backend
// is OP2 (default) or the binding is absent, the handlers keep the relational
// path and never call here.

import type { RunFoldState } from "@saas/contracts/coordination";
import { planProjection } from "@saas/contracts/coordination-projector";
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
export async function proxyCoordinatorLog(env: Env, runId: string, fromSeq: number): Promise<Response> {
  return proxy(await callCoordinator(env, runId, "GET", `/log?from=${fromSeq}`));
}

// ── OP2 compatibility facade (BM6 cutover) ──────────────────────────────────
// The deployed CLI speaks the OP2 protocol (path-style routes, runnerId-as-lease
// holder, the { claim: … } envelope). These helpers let that surface run on the
// DO backend transparently: they call the §3 verbs and normalize the result back
// to OP2 semantics, deriving the DO's leaseEpoch from the shard (OP2 has no
// concept of it) after verifying the requester still holds the lease. The DO
// re-checks epoch+holder atomically, so this is a safe pre-read, not a TOCTOU.

const TERMINAL_PHASES = new Set(["succeeded", "failed", "timed_out", "canceled", "memoized"]);

/**
 * True iff this run has an initialized DO shard, so its verbs route to the DO.
 * The coordination backend is sticky PER RUN: a run created on OP2 (no shard)
 * keeps finishing on OP2 even after the flag flips, and a DO-backed run keeps
 * using the DO even if the flag flips back. useDoCoordination only governs
 * whether a NEW run (createRun) seeds a shard — so flipping the flag never breaks
 * an in-flight run. A run is DO-backed exactly when /state reports its runId.
 */
export async function runIsDoBacked(env: Env, runId: string): Promise<boolean> {
  if (env.COORDINATOR === undefined) return false;
  const fold = await readCoordinatorState(env, runId);
  return fold !== null && fold.runId === runId;
}

/** The OP2 claim-reject vocabulary (contract §2.2). */
export type Op2ClaimReason = "already_claimed" | "terminal" | "deps_not_ready";

/** Map a §3 claim-reject reason to the OP2 vocabulary. */
function mapClaimReason(doReason: string): Op2ClaimReason {
  if (doReason === "deps_not_ready") return "deps_not_ready";
  if (doReason === "run_terminal" || doReason === "terminal") return "terminal";
  return "already_claimed"; // job_held and any other refusal
}

export type Op2ClaimResult =
  | { kind: "claimed"; leaseExpiresAt: string; attempt: number }
  | { kind: "refused"; reason: Op2ClaimReason }
  | { kind: "error" };

export type Op2LeaseResult = { kind: "ok"; leaseExpiresAt?: string } | { kind: "lease_lost" } | { kind: "error" };

/** OP2 :claim over the DO. The OP2 surface never requests memoization, so a
 *  cached/memo outcome cannot arise here; a refusal maps to an OP2 reason. */
export async function coordinatorClaimOP2(
  env: Env,
  runId: string,
  jobId: string,
  runnerId: string,
): Promise<Op2ClaimResult> {
  const res = await callCoordinator(env, runId, "POST", "/claim", { jobId, runnerId });
  if (!res.ok) return { kind: "error" };
  const b = (await res.json()) as { claimed?: boolean; leaseExpiresAt?: string; attempt?: number; reason?: string };
  if (b.claimed) return { kind: "claimed", leaseExpiresAt: b.leaseExpiresAt ?? "", attempt: b.attempt ?? 1 };
  return { kind: "refused", reason: mapClaimReason(b.reason ?? "job_held") };
}

/** Read a job's current lease holder + epoch from the shard, or null if absent. */
async function jobLease(env: Env, runId: string, jobId: string): Promise<{ phase: string; holder: string | null; leaseEpoch: number } | null> {
  const fold = await readCoordinatorState(env, runId);
  const job = fold?.jobs?.[jobId] as { phase?: string; holder?: string | null; leaseEpoch?: number } | undefined;
  if (!job) return null;
  return { phase: job.phase ?? "queued", holder: job.holder ?? null, leaseEpoch: job.leaseEpoch ?? 0 };
}

/** OP2 :heartbeat over the DO. Lease-lost (incl. takeover) maps to the OP2 409. */
export async function coordinatorHeartbeatOP2(env: Env, runId: string, jobId: string, runnerId: string): Promise<Op2LeaseResult> {
  const lease = await jobLease(env, runId, jobId);
  if (!lease || lease.holder !== runnerId) return { kind: "lease_lost" };
  const res = await callCoordinator(env, runId, "POST", "/heartbeat", { jobId, runnerId, leaseEpoch: lease.leaseEpoch });
  if (res.status === 409) return { kind: "lease_lost" };
  if (!res.ok) return { kind: "error" };
  const b = (await res.json()) as { leaseExpiresAt?: string };
  return b.leaseExpiresAt !== undefined ? { kind: "ok", leaseExpiresAt: b.leaseExpiresAt } : { kind: "ok" };
}

/** OP2 :update (terminal) over the DO. Terminal-sticky: a re-complete of an
 *  already-finished job is idempotent (the DO no-ops it) regardless of holder. */
export async function coordinatorCompleteOP2(
  env: Env,
  runId: string,
  jobId: string,
  runnerId: string,
  status: "succeeded" | "failed",
  errorText: string | null,
): Promise<Op2LeaseResult> {
  const lease = await jobLease(env, runId, jobId);
  if (!lease) return { kind: "lease_lost" };
  // A non-terminal job may only be completed by its current holder; a terminal
  // job is idempotent (the DO short-circuits before the lease check).
  if (!TERMINAL_PHASES.has(lease.phase) && lease.holder !== runnerId) return { kind: "lease_lost" };
  const res = await callCoordinator(env, runId, "POST", "/complete", {
    jobId,
    runnerId,
    leaseEpoch: lease.leaseEpoch,
    outcome: status,
    ...(errorText !== null ? { errorText } : {}),
  });
  if (res.status === 409) return { kind: "lease_lost" };
  if (!res.ok) return { kind: "error" };
  return { kind: "ok" };
}

/** OP2 cancel over the DO (run-level; no lease). Returns false on transport error. */
export async function coordinatorCancelOP2(env: Env, runId: string, actor: { id: string; type: string }): Promise<boolean> {
  const res = await callCoordinator(env, runId, "POST", "/cancel", { actor });
  return res.ok;
}

// ── Projection trigger (BM3c) ───────────────────────────────────────────────
// After a state-changing verb, fold the shard and project it into Postgres so
// reads (status/jobs) stay fresh. The DO is the authority; this keeps the
// delayed read model close behind, seq-guarded so it is safe to run repeatedly.

/** Read the run shard's folded state (GET /state → RunFoldState), or null. */
async function readCoordinatorState(env: Env, runId: string): Promise<RunFoldState | null> {
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
  const cur = await executor.execute<{ last_seq: string | number }>(
    `SELECT last_seq FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid = $3`,
    [scope.orgId, scope.projectId, runId],
  );
  const appliedSeq = cur.rows[0] ? Number(cur.rows[0].last_seq) : 0;
  await applyProjection(executor, scope, planProjection(fold, appliedSeq));
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
): Promise<void> {
  if (!env.PLATFORM_DB && !deps?.executor) return;
  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  try {
    await projectCoordinatorRun(env, executor, scope, runId);
  } catch (err) {
    // Eventually consistent: a projection failure must never fail the verb — but
    // it must never be invisible either. A persistent failure here (e.g. the BM3
    // `state.runs.last_seq` column missing because migration 350 was not applied
    // before the COORDINATION_BACKEND=do cutover) silently freezes the read model
    // into a DO/Postgres split-brain. Surface it loudly so tail/alerting catches
    // it instead of clients seeing a run that never progresses.
    console.error(`[projection] run ${runId} projection failed (read model may be stale): ${String(err)}`);
  } finally {
    if (!deps?.executor && "dispose" in executor) {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
