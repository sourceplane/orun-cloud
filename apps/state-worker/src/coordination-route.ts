// Coordination routing (BM4b — coordination-api.md §3). The seam that sends the
// claim/heartbeat/complete/cancel verbs (and run init) to the per-run
// RunCoordinator Durable Object when the environment selects the DO backend. The
// DO is already §3-wire-conformant, so the handler layer authenticates and then
// *proxies* the DO's response verbatim — no envelope reshaping. When the backend
// is OP2 (default) or the binding is absent, the handlers keep the relational
// path and never call here.

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
