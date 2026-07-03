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
import { computeDigest, isValidDigest, logChunkPrefix, memoIndexKey, objectKey, requireBucket } from "./object-store.js";
import { orgPublicId, projectPublicId } from "./ids.js";
import {
  ensureRunShard,
  projectAfterVerb,
  proxyCoordinatorFrontier,
  proxyCoordinatorLog,
  proxyCoordinatorVerb,
} from "./coordination-route.js";

// ── Coordination diagnostics (temporary; observability-only) ────────────────
// Structured, greppable log lines to pinpoint the single-run-shard stall under
// concurrent runners (all CI jobs share one exec-id ⇒ one RunCoordinator DO).
// Lifecycle verbs (claim/complete) always log with edge→DO round-trip latency +
// the decision; the high-frequency verbs (heartbeat/log poll) log only when slow
// or non-2xx, to keep volume sane. Tail with: grep '"m":"coorddiag"'.
const SLOW_MS = 400;

function diag(fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- temporary coordination diagnostics
  console.log(JSON.stringify({ m: "coorddiag", ...fields }));
}

/** Peek a proxied verb response body without consuming the original. */
async function peekBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.clone().json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

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
  // Require a DO-backed run (else 404). `ensureRunShard` only CHECKS backing now
  // (no lazy-seed): createRun is the sole seeder, with the complete plan from the
  // request body. A claim that arrives before createRun finishes seeding gets a
  // transient 404 and the client retries — correct, and it avoids the partial
  // run_jobs re-seed that used to poison the plan.
  if (!(await ensureRunShard(env, runUlid))) {
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

/** Resolve the memoized `job-result` digest for a `jobInputHash` from the
 *  project's memo index — the server's own lookup, so the client supplies only
 *  the key, never the digest. Returns null when there is no index entry or the
 *  referenced object no longer exists (e.g. GC'd) — either way the job re-runs. */
async function resolveMemoDigest(env: Env, orgId: Uuid, projectId: Uuid, jobInputHash: string): Promise<string | null> {
  if (!isValidDigest(jobInputHash)) return null;
  const b = requireBucket(env);
  if (!b.ok) return null;
  const marker = await b.bucket.get(memoIndexKey(orgPublicId(orgId), projectPublicId(projectId), jobInputHash));
  if (marker === null) return null;
  const digest = (await marker.text()).trim();
  if (!(await memoResultExists(env, orgId, projectId, digest))) return null;
  return digest;
}

/** Seal a job's streamed log into a content-addressed `log` object on :complete
 *  (§4): list the job's R2 chunks, assemble them in seq order, and write the
 *  concatenation to the CAS. Returns the `log` digest, or null when the job
 *  produced no output. Reads R2 directly (no Postgres index) so the assembled
 *  bytes are the ground truth and the seal works without the projection store. */
async function sealJobLog(env: Env, orgId: Uuid, projectId: Uuid, runUlid: string, jobId: string): Promise<string | null> {
  const b = requireBucket(env);
  if (!b.ok) return null;
  const bucket = b.bucket;
  const prefix = logChunkPrefix(orgPublicId(orgId), projectPublicId(projectId), runUlid, jobId);

  // List every chunk under the job's prefix (paged), then order by numeric seq —
  // a lexical sort would put "10" before "2", so parse the suffix as an integer.
  const keys: { seq: number; key: string }[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const o of listed.objects) {
      const seq = Number.parseInt(o.key.slice(prefix.length), 10);
      if (Number.isInteger(seq)) keys.push({ seq, key: o.key });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  if (keys.length === 0) return null;
  keys.sort((x, y) => x.seq - y.seq);

  const parts: Uint8Array[] = [];
  let total = 0;
  for (const { key } of keys) {
    const obj = await bucket.get(key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    parts.push(bytes);
    total += bytes.byteLength;
  }
  const assembled = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    assembled.set(p, offset);
    offset += p.byteLength;
  }
  const digest = await computeDigest(assembled);
  // Content-addressed + idempotent: re-sealing the same bytes is a no-op write.
  await bucket.put(objectKey(orgPublicId(orgId), projectPublicId(projectId), digest), assembled);
  return digest;
}

/** Record `jobInputHash → resultDigest` in the project's memo index so a later
 *  hermetic claim with the same input hash can be served from cache. Best-effort:
 *  memoization is opt-in and never required for correctness, so an index write
 *  failure (or no object store) is swallowed. */
async function recordMemoResult(env: Env, orgId: Uuid, projectId: Uuid, jobInputHash: string, resultDigest: string): Promise<void> {
  if (!isValidDigest(jobInputHash) || !isValidDigest(resultDigest)) return;
  const b = requireBucket(env);
  if (!b.ok) return;
  try {
    await b.bucket.put(memoIndexKey(orgPublicId(orgId), projectPublicId(projectId), jobInputHash), resultDigest);
  } catch {
    // index is a cache; a failed write just means the next run re-executes.
  }
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
  ctx?: ExecutionContext,
): Promise<Response> {
  const gateT0 = Date.now();
  const g = await gate(env, requestId, actor, orgId, projectId, runUlid, STATE_POLICY_ACTIONS.RUN_WRITE);
  const gateMs = Date.now() - gateT0;
  if (!g.ok) {
    diag({ v: "claim", runId: runUlid, jobId, gateMs, status: g.response.status, gated: true });
    return g.response;
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
  if (!runnerId) return validationError(requestId, { runnerId: ["Required; non-empty string"] });
  const verbBody: Record<string, unknown> = { jobId, runnerId, actor: stampOf(actor) };
  if (typeof body.hermetic === "boolean") verbBody.hermetic = body.hermetic;
  if (body.hermetic === true && typeof body.jobInputHash === "string") {
    // Server-resolved memoization (BM1): the client supplies only the input-hash
    // key; the server looks up the result digest in its own project-scoped index.
    // This is the trust-correct path — the client can neither fabricate a hit nor
    // pick which result is reused.
    const resolved = await resolveMemoDigest(env, orgId, projectId, body.jobInputHash);
    if (resolved !== null) verbBody.memoResultDigest = resolved;
  } else if (typeof body.memoResultDigest === "string") {
    // Legacy path: a pre-resolved client digest. Still verify the object exists
    // (no fabricated/GC'd hit can shortcut execution) — 412 otherwise.
    if (!(await memoResultExists(env, orgId, projectId, body.memoResultDigest))) {
      return errorResponse("object_missing", `Memoized result ${body.memoResultDigest} does not exist`, 412, requestId);
    }
    verbBody.memoResultDigest = body.memoResultDigest;
  }
  const doT0 = Date.now();
  const res = await proxyCoordinatorVerb(env, runUlid, "claim", verbBody);
  const doMs = Date.now() - doT0;
  const b = await peekBody(res);
  // Every claim logs: how long the DO round-trip took, and the decision — a stall
  // shows here as either a slow doMs (shard contention) or a repeated
  // claimed:false/deps_not_ready (a runner spinning on a frontier that never
  // advances). gateMs isolates the ensureRunShard/isolate-cache cost.
  diag({ v: "claim", runId: runUlid, jobId, runnerId, gateMs, doMs, status: res.status, claimed: b.claimed, reason: b.reason, seq: b.seq });
  await projectAfterVerb(env, deps, { orgId, projectId }, runUlid, ctx);
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
  _deps?: RunHandlerDeps,
): Promise<Response> {
  const g = await gate(env, requestId, actor, orgId, projectId, runUlid, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!g.ok) return g.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
  const leaseEpoch = typeof body.leaseEpoch === "number" ? body.leaseEpoch : NaN;
  if (!runnerId) return validationError(requestId, { runnerId: ["Required; non-empty string"] });
  if (!Number.isFinite(leaseEpoch)) return validationError(requestId, { leaseEpoch: ["Required; number"] });
  const doT0 = Date.now();
  const res = await proxyCoordinatorVerb(env, runUlid, "heartbeat", { jobId, runnerId, leaseEpoch, actor: stampOf(actor) });
  const doMs = Date.now() - doT0;
  // Heartbeat is high-frequency (every ~20s per runner); log only anomalies: a
  // slow DO round-trip (contention) or a lease_lost/error (churn).
  if (doMs > SLOW_MS || res.status !== 200) diag({ v: "heartbeat", runId: runUlid, jobId, runnerId, doMs, status: res.status });
  // No read-model projection on heartbeat — deliberately. A heartbeat only renews
  // the lease, which the DO owns and enforces; the only projected field it would
  // touch is `leaseExpiresAt`. At ~1000 concurrent jobs a per-heartbeat DO fold +
  // Postgres upsert would dominate DB load for zero correctness gain. The bounded
  // projection sweep reconciles `leaseExpiresAt` for non-terminal runs, and the
  // lifecycle verbs (claim/complete/cancel) still project immediately.
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
  ctx?: ExecutionContext,
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
  // Seal the job's log into a `log` object before the append, so the digest can
  // ride on the JobSucceeded event (§4). Best-effort: a seal failure must not
  // block completion, so it only adds the field when it produced a digest.
  if (outcome === "succeeded") {
    try {
      const logsDigest = await sealJobLog(env, orgId, projectId, runUlid, jobId);
      if (logsDigest) verbBody.logsDigest = logsDigest;
    } catch {
      // A seal hiccup must never block a job's completion; the log simply stays
      // unsealed (still retrievable chunk-by-chunk via the OP3 log read).
    }
  }
  const doT0 = Date.now();
  const res = await proxyCoordinatorVerb(env, runUlid, "complete", verbBody);
  diag({ v: "complete", runId: runUlid, jobId, runnerId, outcome, doMs: Date.now() - doT0, status: res.status });
  // Index jobInputHash → resultDigest so a later hermetic claim with the same
  // inputs is served from cache (BM1). Only on a recorded success that carries
  // both; best-effort and never blocks the response.
  if (res.ok && outcome === "succeeded" && typeof body.resultDigest === "string" && typeof body.jobInputHash === "string") {
    await recordMemoResult(env, orgId, projectId, body.jobInputHash, body.resultDigest);
  }
  await projectAfterVerb(env, deps, { orgId, projectId }, runUlid, ctx);
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
  ctx?: ExecutionContext,
): Promise<Response> {
  const g = await gate(env, requestId, actor, orgId, projectId, runUlid, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!g.ok) return g.response;
  const res = await proxyCoordinatorVerb(env, runUlid, "cancel", { actor: stampOf(actor) });
  await projectAfterVerb(env, deps, { orgId, projectId }, runUlid, ctx);
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
  const params = new URL(request.url).searchParams;
  const from = Number(params.get("from") ?? "0");
  // ?wait=<seconds> turns the read into a long-poll: when no event sits past the
  // cursor, the shard holds the request until one is appended or the wait lapses
  // (live-tail for `status --watch` / `logs --follow` without busy polling).
  const wait = Number(params.get("wait") ?? "0");
  const doT0 = Date.now();
  const res = await proxyCoordinatorLog(
    env,
    runUlid,
    Number.isFinite(from) ? from : 0,
    Number.isFinite(wait) && wait > 0 ? wait : 0,
  );
  const body = await peekBody(res);
  const events = Array.isArray(body.events) ? body.events.length : undefined;
  // The tail is how a dependent runner learns its deps finished. Log every poll:
  // `from` cursor, wait budget, DO round-trip, #events returned, and the head seq.
  // A stuck dependent shows as repeated polls that return 0 events while the head
  // has actually advanced past its cursor.
  diag({ v: "log", runId: runUlid, from: Number.isFinite(from) ? from : 0, wait, doMs: Date.now() - doT0, events, head: (body.head as { seq?: number } | undefined)?.seq, status: res.status });
  return res;
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
  const doT0 = Date.now();
  const res = await proxyCoordinatorFrontier(env, runUlid);
  const body = await peekBody(res);
  const jobs = Array.isArray(body.jobs) ? (body.jobs as string[]) : undefined;
  // Frontier drives which job a runner claims next. If runnable jobs never appear
  // here despite deps completing, claims stall — this shows the projected
  // frontier a runner sees each poll.
  diag({ v: "frontier", runId: runUlid, doMs: Date.now() - doT0, runnable: jobs?.length, jobs: jobs?.slice(0, 20), status: res.status });
  return res;
}
