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
  } catch {
    // Eventually consistent: a projection failure must never fail the verb.
  } finally {
    if (!deps?.executor && "dispose" in executor) {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
