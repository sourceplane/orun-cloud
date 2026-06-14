// Log append/read (OP3 — state-api-contract §2.3, design §4.3).
//
// Append-only, chunked logs. A chunk's bytes land in R2
// (`state/{org}/{project}/runs/{runId}/logs/{jobId}/{seq}`); a Postgres
// `state.log_chunks` index row (keyed by (run, job, seq)) is the ledger and the
// live-tail cursor source. Reads assemble the bytes from R2 and return a
// `nextSeq` cursor so the console and `orun logs --follow` tail by polling.
//
// Append REQUIRES a live job lease for the calling runner: a chunk from a runner
// that lost its lease is rejected `409 lease_lost` (the job already re-queued;
// the runner must stop). Append gates on state.run.write, read on state.run.read
// (§6). Chunks are bounded to ≤ 1 MiB.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { AppendLogResponse, ReadLogResponse } from "@saas/contracts/state";
import { STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import { createStateRepository } from "@saas/db/state";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { asUuid, type Uuid } from "@saas/db/ids";
import { errorResponse, successResponse, validationError } from "../http.js";
import { authorizeRun } from "../authz.js";
import { generateUuid, orgPublicId, projectPublicId } from "../ids.js";
import { LOG_CHUNK_MAX_BYTES, LOG_READ_MAX_CHUNKS } from "../constants.js";
import { logChunkKey, requireBucket } from "../object-store.js";
import { emitUsage, STATE_METRICS } from "../metering.js";

export interface LogHandlerDeps {
  executor?: SqlExecutor;
}

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "timed_out", "canceled"]);

// ── POST …/runs/{runId}/logs/{jobId} — append a chunk ───────

export async function handleAppendLog(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  jobId: string,
  deps?: LogHandlerDeps,
): Promise<Response> {
  // Append is a write; gate on state.run.write (per §6 "log append").
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!authz.ok) return authz.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const runnerId = typeof body.runnerId === "string" && body.runnerId.length > 0 ? body.runnerId : null;
  const content = typeof body.content === "string" ? body.content : null;
  const fields: Record<string, string[]> = {};
  if (!runnerId) fields.runnerId = ["Required; non-empty string"];
  if (content === null) fields.content = ["Required; string chunk"];
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  // Chunks ≤ 1 MiB (measured in UTF-8 bytes).
  const bytes = new TextEncoder().encode(content!);
  if (bytes.byteLength > LOG_CHUNK_MAX_BYTES) {
    return errorResponse(
      "payload_too_large",
      `Log chunk exceeds the ${LOG_CHUNK_MAX_BYTES}-byte (1 MiB) per-chunk budget`,
      413,
      requestId,
      { maxBytes: LOG_CHUNK_MAX_BYTES },
    );
  }

  const bucketResult = requireBucket(env);
  if (!bucketResult.ok) {
    return errorResponse(bucketResult.code, bucketResult.message, bucketResult.status, requestId);
  }
  const bucket = bucketResult.bucket;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const run = await repo.getRunByUlid(orgId, projectId, runUlid);
    if (!run.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const runRowId = asUuid(run.value.id);

    // ── Live-lease check: the runner must currently own the job's lease. ──
    // A chunk from a runner whose lease lapsed or was reassigned is rejected
    // 409 lease_lost — the job already re-queued, the runner must stop. We read
    // the job row and assert runner ownership + an unexpired, non-terminal lease.
    const job = await repo.getRunJob(orgId, projectId, runRowId, jobId);
    if (!job.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const j = job.value;
    const leaseLive =
      j.runnerId === runnerId &&
      !TERMINAL_JOB_STATUSES.has(j.status) &&
      j.leaseExpiresAt !== null &&
      j.leaseExpiresAt.getTime() > Date.now();
    if (!leaseLive) {
      return errorResponse(
        "lease_lost",
        "No live lease for this runner on this job; stop appending logs",
        409,
        requestId,
      );
    }

    // ── Allocate the next seq from the index, then store the chunk. ──
    // listLogChunks(fromSeq=0) returns all chunks for the job ordered by seq; the
    // next seq is the count (seqs are 0-based monotonic). The unique (run, job,
    // seq) index makes a concurrent double-append for the same seq a conflict we
    // retry once at the next seq.
    const existing = await repo.listLogChunks(orgId, projectId, runRowId, jobId, 0);
    if (!existing.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    let seq = existing.value.length;

    let appended = await repo.appendLogChunk({
      id: generateUuid(),
      orgId,
      projectId,
      runId: runRowId,
      jobId,
      seq,
      byteLength: bytes.byteLength,
    });
    if (!appended.ok && appended.error.kind === "conflict") {
      // Lost a race for this seq — recompute and retry once at the new tail.
      const retryList = await repo.listLogChunks(orgId, projectId, runRowId, jobId, 0);
      if (!retryList.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
      seq = retryList.value.length;
      appended = await repo.appendLogChunk({
        id: generateUuid(),
        orgId,
        projectId,
        runId: runRowId,
        jobId,
        seq,
        byteLength: bytes.byteLength,
      });
    }
    if (!appended.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    // Store the chunk bytes in R2 keyed by (run, job, seq).
    await bucket.put(
      logChunkKey(orgPublicId(orgId), projectPublicId(projectId), runUlid, jobId, seq),
      bytes,
    );

    // Metering: log bytes (best-effort, idempotent on (run, job, seq)).
    await emitUsage({
      executor,
      orgPublicId: orgPublicId(orgId),
      projectPublicId: projectPublicId(projectId),
      metric: STATE_METRICS.LOG_BYTES,
      quantity: bytes.byteLength,
      idempotencySeed: `${runUlid}:${jobId}:${seq}`,
      metadata: { runId: runUlid, jobId },
    });

    const payload: AppendLogResponse = { seq };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── GET …/runs/{runId}/logs/{jobId}?fromSeq= — assembled read ─

export async function handleReadLog(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  jobId: string,
  deps?: LogHandlerDeps,
): Promise<Response> {
  // Read is gated on state.run.read (per §6 "logs read").
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_READ);
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const fromSeqRaw = url.searchParams.get("fromSeq");
  let fromSeq = 0;
  if (fromSeqRaw !== null && fromSeqRaw !== "") {
    const parsed = Number.parseInt(fromSeqRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return validationError(requestId, { fromSeq: ["Must be a non-negative integer"] });
    }
    fromSeq = parsed;
  }

  const bucketResult = requireBucket(env);
  if (!bucketResult.ok) {
    return errorResponse(bucketResult.code, bucketResult.message, bucketResult.status, requestId);
  }
  const bucket = bucketResult.bucket;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const run = await repo.getRunByUlid(orgId, projectId, runUlid);
    if (!run.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const runRowId = asUuid(run.value.id);

    // Index drives the read: chunks from fromSeq onward, ordered by seq. We
    // assemble bounded pages so a huge log never blows the response budget; the
    // returned nextSeq lets the client resume (live-tail by polling).
    const chunks = await repo.listLogChunks(orgId, projectId, runRowId, jobId, fromSeq);
    if (!chunks.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const page = chunks.value.slice(0, LOG_READ_MAX_CHUNKS);
    const decoder = new TextDecoder();
    let content = "";
    for (const chunk of page) {
      const r2 = await bucket.get(
        logChunkKey(orgPublicId(orgId), projectPublicId(projectId), runUlid, jobId, chunk.seq),
      );
      if (r2) content += decoder.decode(await r2.arrayBuffer());
    }

    const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : fromSeq - 1;
    const nextSeq = page.length > 0 ? lastSeq + 1 : fromSeq;
    // `complete` is true when the job reached a terminal status AND no chunks
    // remain past this page — i.e. the live tail has nothing more coming.
    const job = await repo.getRunJob(orgId, projectId, runRowId, jobId);
    const jobTerminal = job.ok && TERMINAL_JOB_STATUSES.has(job.value.status);
    const morePages = chunks.value.length > page.length;
    const complete = jobTerminal && !morePages;

    const payload: ReadLogResponse = { content, nextSeq, complete };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}
