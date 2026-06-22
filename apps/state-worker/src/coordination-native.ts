// Native v2 coordination wire (BM4 — coordination-api.md §2/§3). Exposes the
// event-sourced verbs and reads on the public router, routed to the per-run
// RunCoordinator Durable Object. This is distinct from the OP2 compatibility
// facade in coordination-route.ts: these handlers speak the §3 wire verbatim
// (colon-verbs, client-supplied leaseEpoch, the raw `{ claimed, … }` bodies) and
// stamp the *verified* actor onto every appended event — so coordination
// provenance is the authenticated runner, not `system:coordinator`.
//
// Surface (all path-scoped under …/state/runs):
//   POST …/runs/{runId}/jobs/{jobId}:claim      (state.run.write)
//   POST …/runs/{runId}/jobs/{jobId}:heartbeat  (state.run.write)
//   POST …/runs/{runId}/jobs/{jobId}:complete   (state.run.write)
//   POST …/runs/{runId}:cancel                  (state.run.write)
//   GET  …/runs/{runId}/log?from={seq}          (state.run.read)
//   GET  …/runs/{runId}/frontier                (state.run.read)
//
// Only DO-backed runs have this surface; anything else (OP2 run, no shard, or the
// DO backend disabled) hides as a 404, after the deny-by-default authz check, so
// cross-tenant existence never leaks.

import { STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import type { Uuid } from "@saas/db/ids";
import type { Env } from "./env.js";
import type { ActorContext } from "./router.js";
import type { RunHandlerDeps } from "./handlers/runs.js";
import { errorResponse, validationError } from "./http.js";
import { authorizeRun } from "./authz.js";
import { isValidDigest, objectKey, requireBucket } from "./object-store.js";
import { orgPublicId, projectPublicId } from "./ids.js";
import {
  projectAfterVerb,
  proxyCoordinatorFrontier,
  proxyCoordinatorLog,
  proxyCoordinatorVerb,
  runIsDoBacked,
  useDoCoordination,
} from "./coordination-route.js";

/** Authorize, then require a DO-backed run (else 404). Authz precedes the
 *  existence probe so a cross-tenant caller can never distinguish "no run" from
 *  "not yours". */
async function gate(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  action: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, action);
  if (!authz.ok) return { ok: false, response: authz.response };
  if (!useDoCoordination(env) || !(await runIsDoBacked(env, runUlid))) {
    return { ok: false, response: errorResponse("not_found", "Not found", 404, requestId) };
  }
  return { ok: true };
}

function stampOf(actor: ActorContext): { id: string; type: string } {
  return { id: actor.subjectId, type: actor.subjectType };
}

/** Whether a `job-result` (or any CAS object) exists for this digest in the
 *  project's store. A memo hit must reference a real object — the runner adopts
 *  the result and skips execution, so an absent/fabricated digest cannot be
 *  allowed to shortcut work (contract §: referenced object must exist). Returns
 *  false when the digest is malformed or no object store is bound. */
async function memoResultExists(env: Env, orgId: Uuid, projectId: Uuid, digest: string): Promise<boolean> {
  if (!isValidDigest(digest)) return false;
  const b = requireBucket(env);
  if (!b.ok) return false;
  const head = await b.bucket.head(objectKey(orgPublicId(orgId), projectPublicId(projectId), digest));
  return head !== null;
}

/** POST …/runs/{runId}/jobs/{jobId}:claim — conditional-append claim. */
export async function handleNativeClaim(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  jobId: string,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const g = await gate(env, requestId, actor, orgId, projectId, runUlid, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!g.ok) return g.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
  if (!runnerId) return validationError(requestId, { runnerId: ["Required; non-empty string"] });
  const verbBody: Record<string, unknown> = { jobId, runnerId, actor: stampOf(actor) };
  if (typeof body.hermetic === "boolean") verbBody.hermetic = body.hermetic;
  if (typeof body.memoResultDigest === "string") {
    // Verify the referenced result exists before the DO can honor it as a cache
    // hit — never let a client shortcut execution with a fabricated or GC'd
    // digest. (Resolving the digest from the job's jobInputHash server-side, so
    // the client supplies only the key, is the remaining BM1 work.)
    if (!(await memoResultExists(env, orgId, projectId, body.memoResultDigest))) {
      return errorResponse("object_missing", `Memoized result ${body.memoResultDigest} does not exist`, 412, requestId);
    }
    verbBody.memoResultDigest = body.memoResultDigest;
  }
  const res = await proxyCoordinatorVerb(env, runUlid, "claim", verbBody);
  await projectAfterVerb(env, deps, { orgId, projectId }, runUlid);
  return res;
}

/** POST …/runs/{runId}/jobs/{jobId}:heartbeat — renew the lease (409 on lease loss). */
export async function handleNativeHeartbeat(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  jobId: string,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const g = await gate(env, requestId, actor, orgId, projectId, runUlid, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!g.ok) return g.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
  const leaseEpoch = typeof body.leaseEpoch === "number" ? body.leaseEpoch : NaN;
  if (!runnerId) return validationError(requestId, { runnerId: ["Required; non-empty string"] });
  if (!Number.isFinite(leaseEpoch)) return validationError(requestId, { leaseEpoch: ["Required; number"] });
  const res = await proxyCoordinatorVerb(env, runUlid, "heartbeat", { jobId, runnerId, leaseEpoch, actor: stampOf(actor) });
  await projectAfterVerb(env, deps, { orgId, projectId }, runUlid);
  return res;
}

/** POST …/runs/{runId}/jobs/{jobId}:complete — terminal append (succeeded|failed). */
export async function handleNativeComplete(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  jobId: string,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const g = await gate(env, requestId, actor, orgId, projectId, runUlid, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!g.ok) return g.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
  const leaseEpoch = typeof body.leaseEpoch === "number" ? body.leaseEpoch : NaN;
  const outcome = body.outcome === "succeeded" || body.outcome === "failed" ? body.outcome : null;
  if (!runnerId) return validationError(requestId, { runnerId: ["Required; non-empty string"] });
  if (!Number.isFinite(leaseEpoch)) return validationError(requestId, { leaseEpoch: ["Required; number"] });
  if (!outcome) return validationError(requestId, { outcome: ['Required; "succeeded" | "failed"'] });
  const verbBody: Record<string, unknown> = { jobId, runnerId, leaseEpoch, outcome, actor: stampOf(actor) };
  if (typeof body.resultDigest === "string") verbBody.resultDigest = body.resultDigest;
  if (typeof body.errorText === "string") verbBody.errorText = body.errorText;
  if (typeof body.reason === "string") verbBody.reason = body.reason;
  const res = await proxyCoordinatorVerb(env, runUlid, "complete", verbBody);
  await projectAfterVerb(env, deps, { orgId, projectId }, runUlid);
  return res;
}

/** POST …/runs/{runId}:cancel — run-level cancel (no lease). */
export async function handleNativeCancel(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const g = await gate(env, requestId, actor, orgId, projectId, runUlid, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!g.ok) return g.response;
  const res = await proxyCoordinatorVerb(env, runUlid, "cancel", { actor: stampOf(actor) });
  await projectAfterVerb(env, deps, { orgId, projectId }, runUlid);
  return res;
}

/** GET …/runs/{runId}/log?from={seq} — the run's event stream from a cursor. */
export async function handleNativeLog(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
): Promise<Response> {
  const g = await gate(env, requestId, actor, orgId, projectId, runUlid, STATE_POLICY_ACTIONS.RUN_READ);
  if (!g.ok) return g.response;
  const from = Number(new URL(request.url).searchParams.get("from") ?? "0");
  return proxyCoordinatorLog(env, runUlid, Number.isFinite(from) ? from : 0);
}

/** GET …/runs/{runId}/frontier — the currently-runnable job ids. */
export async function handleNativeFrontier(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
): Promise<Response> {
  const g = await gate(env, requestId, actor, orgId, projectId, runUlid, STATE_POLICY_ACTIONS.RUN_READ);
  if (!g.ok) return g.response;
  return proxyCoordinatorFrontier(env, runUlid);
}
