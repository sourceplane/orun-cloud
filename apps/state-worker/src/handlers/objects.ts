// CAS object plane (OP3 — state-api-contract §3, design §4.1).
//
// Content-addressed blobs keyed by `sha256:<hex>`, org/project-scoped. Bytes
// live in R2 (`state/{orgId}/{projectId}/objects/{digest}`); a Postgres index
// row (org/project denormalized) is the queryable metadata. The PUT is digest-
// verified (the server hashes the body and rejects a mismatch) and idempotent
// (a re-push of an existing digest is a 200 no-op). Blobs over the single-
// request budget use the R2 multipart sub-protocol (start/part/complete).
//
// Policy: reads gate on `state.object.read`, writes on `state.object.write`
// (§6). Cross-tenant access 404s via authorizeRun's resource-hiding.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  ObjectsMissingResponse,
  PutObjectResponse,
  ListObjectsResponse,
  StateObjectRef,
} from "@saas/contracts/state";
import { STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import {
  createStateRepository,
  type StateObject,
  type StateObjectKind,
} from "@saas/db/state";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, successResponse, listResponse, validationError } from "../http.js";
import { authorizeRun, requireWorkflowRepoAllowed } from "../authz.js";
import { generateUuid, orgPublicId, projectPublicId } from "../ids.js";
import { DEFAULT_PAGE_LIMIT } from "../constants.js";
import {
  OBJECT_MULTIPART_PART_MAX_BYTES,
  OBJECT_MULTIPART_MAX_PARTS,
  OBJECT_SINGLE_REQUEST_MAX_BYTES,
} from "../constants.js";
import {
  computeDigest,
  isValidDigest,
  isValidObjectKind,
  objectKey,
  requireBucket,
  uploadManifestKey,
  uploadPartKey,
  uploadPartsPrefix,
  DEFAULT_PART_SIZE,
  type UploadManifest,
} from "../object-store.js";
import { emitUsage, STATE_METRICS } from "../metering.js";

export interface ObjectHandlerDeps {
  executor?: SqlExecutor;
}

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

function actorKindOf(subjectType: string): "user" | "service_principal" | "workflow" | "system" {
  switch (subjectType) {
    case "user":
    case "service_principal":
    case "workflow":
    case "system":
      return subjectType;
    default:
      return "system";
  }
}

function actorRef(o: StateObject): StateObjectRef["createdBy"] {
  const kind = o.createdBy.kind;
  const safeKind: StateObjectRef["createdBy"]["kind"] =
    kind === "user" || kind === "service_principal" || kind === "workflow" || kind === "system"
      ? kind
      : "system";
  return { id: o.createdBy.id ?? "", kind: safeKind };
}

function toPublicObject(o: StateObject): StateObjectRef {
  return {
    orgId: orgPublicId(o.orgId),
    projectId: projectPublicId(o.projectId),
    digest: o.digest,
    kind: o.kind,
    sizeBytes: o.sizeBytes,
    createdBy: actorRef(o),
    createdAt: o.createdAt.toISOString(),
  };
}

// ── POST …/state/objects/missing — digest negotiation ───────

export async function handleObjectsMissing(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: ObjectHandlerDeps,
): Promise<Response> {
  // Negotiation is part of a write flow (the client is about to push); gate on
  // state.object.write so a viewer cannot enumerate which digests exist.
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_WRITE);
  if (!authz.ok) return authz.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const raw = body.digests;
  if (!Array.isArray(raw) || !raw.every((d) => typeof d === "string")) {
    return validationError(requestId, { digests: ["Required; array of 'sha256:<hex>' strings"] });
  }
  const digests = raw as string[];
  for (const d of digests) {
    if (!isValidDigest(d)) {
      return validationError(requestId, { digests: [`Malformed digest: ${d}`] });
    }
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const result = await repo.listMissingObjects(orgId, projectId, digests);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const payload: ObjectsMissingResponse = { missing: result.value };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── PUT …/state/objects/{digest} — digest-verified idempotent ─

export async function handlePutObject(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  digest: string,
  deps?: ObjectHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_WRITE);
  if (!authz.ok) return authz.response;

  if (!isValidDigest(digest)) {
    return validationError(requestId, { digest: ["Path digest must be 'sha256:<64 hex>'"] });
  }
  const kind = request.headers.get("Orun-Object-Kind") ?? "";
  if (!isValidObjectKind(kind)) {
    return validationError(requestId, {
      "Orun-Object-Kind": ["Required header; one of plan|catalog-snapshot|composition-lock|artifact-manifest|job-result|log|run-record"],
    });
  }

  const bucketResult = requireBucket(env);
  if (!bucketResult.ok) {
    return errorResponse(bucketResult.code, bucketResult.message, bucketResult.status, requestId);
  }
  const bucket = bucketResult.bucket;

  // Read the body fully so we can verify the digest before storing anything.
  // Bodies over the single-request budget must use the chunked-upload protocol.
  const bodyBuf = await request.arrayBuffer();
  if (bodyBuf.byteLength > OBJECT_SINGLE_REQUEST_MAX_BYTES) {
    return errorResponse(
      "payload_too_large",
      `Object body exceeds the ${OBJECT_SINGLE_REQUEST_MAX_BYTES}-byte single-request budget; use the chunked-upload sub-protocol (POST …/objects/{digest}/uploads).`,
      413,
      requestId,
      { maxBytes: OBJECT_SINGLE_REQUEST_MAX_BYTES, partSize: DEFAULT_PART_SIZE },
    );
  }

  // ── Server-side digest verification: hash the body, reject a mismatch. ──
  const actual = await computeDigest(bodyBuf);
  if (actual !== digest) {
    return errorResponse(
      "digest_mismatch",
      "Body sha256 does not match the path digest",
      400,
      requestId,
      { expected: digest, actual },
    );
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);

    // Allow-list gate: an OIDC CI may commit objects only while its repo has an
    // active workspace link. No-op for human/CLI actors (governed by authz above).
    const allowed = await requireWorkflowRepoAllowed(repo, requestId, actor, orgId, projectId);
    if (!allowed.ok) return allowed.response;

    // Idempotent index upsert first: if the digest already exists, this is a
    // verified no-op (200). The content is immutable so we skip the R2 write.
    const upsert = await repo.upsertObject({
      id: generateUuid(),
      orgId,
      projectId,
      digest,
      kind: kind as StateObjectKind,
      sizeBytes: bodyBuf.byteLength,
      createdBy: { id: actor.subjectId, kind: actorKindOf(actor.subjectType) },
    });
    if (!upsert.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    if (!upsert.value.created) {
      // Already stored — idempotent no-op, no re-write, no re-meter.
      const payload: PutObjectResponse = { object: toPublicObject(upsert.value.object), created: false };
      return successResponse(payload, requestId, 200);
    }

    // Fresh object: store the verified bytes in R2 keyed by the digest.
    await bucket.put(objectKey(orgPublicId(orgId), projectPublicId(projectId), digest), bodyBuf, {
      customMetadata: { kind, digest },
    });

    // Metering: object bytes + count (best-effort, idempotent on the digest).
    await emitUsage({
      executor,
      orgPublicId: orgPublicId(orgId),
      projectPublicId: projectPublicId(projectId),
      metric: STATE_METRICS.OBJECT_BYTES,
      quantity: bodyBuf.byteLength,
      idempotencySeed: digest,
      metadata: { kind },
    });
    await emitUsage({
      executor,
      orgPublicId: orgPublicId(orgId),
      projectPublicId: projectPublicId(projectId),
      metric: STATE_METRICS.OBJECT_COUNT,
      quantity: 1,
      idempotencySeed: digest,
      metadata: { kind },
    });

    const payload: PutObjectResponse = { object: toPublicObject(upsert.value.object), created: true };
    return successResponse(payload, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── GET …/state/objects/{digest} — blob bytes ───────────────

export async function handleGetObject(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  digest: string,
  deps?: ObjectHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_READ);
  if (!authz.ok) return authz.response;

  if (!isValidDigest(digest)) return errorResponse("not_found", "Not found", 404, requestId);

  const bucketResult = requireBucket(env);
  if (!bucketResult.ok) {
    return errorResponse(bucketResult.code, bucketResult.message, bucketResult.status, requestId);
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    // Index lookup first scopes by (org, project) — a cross-tenant digest 404s
    // even though R2 keys are scoped, so the read can never escape the tenant.
    const obj = await repo.getObject(orgId, projectId, digest);
    if (!obj.ok) return errorResponse("not_found", "Not found", 404, requestId);

    const r2 = await bucketResult.bucket.get(
      objectKey(orgPublicId(orgId), projectPublicId(projectId), digest),
    );
    if (!r2) return errorResponse("not_found", "Not found", 404, requestId);

    return new Response(r2.body, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(obj.value.sizeBytes),
        "orun-object-kind": obj.value.kind,
        "x-request-id": requestId,
      },
    });
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── GET …/state/objects?kind=&cursor= — index listing ───────

export async function handleListObjects(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: ObjectHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_READ);
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");
  if (kindParam && !isValidObjectKind(kindParam)) {
    return validationError(requestId, { kind: ["Invalid object kind"] });
  }
  const cursorParam = url.searchParams.get("cursor");
  let cursor: { createdAt: string; id: string } | null = null;
  if (cursorParam) {
    const idx = cursorParam.indexOf("|");
    if (idx <= 0) return validationError(requestId, { cursor: ["Malformed cursor"] });
    cursor = { createdAt: cursorParam.slice(0, idx), id: cursorParam.slice(idx + 1) };
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const result = await repo.listObjects(
      orgId,
      projectId,
      { limit: DEFAULT_PAGE_LIMIT, cursor },
      kindParam ? { kind: kindParam as StateObjectKind } : undefined,
    );
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const nextCursor = result.value.nextCursor
      ? { createdAt: result.value.nextCursor.createdAt, id: result.value.nextCursor.id }
      : null;
    const payload: ListObjectsResponse = {
      objects: result.value.items.map(toPublicObject),
      nextCursor,
    };
    const cursorStr = nextCursor ? `${nextCursor.createdAt}|${nextCursor.id}` : null;
    return listResponse(payload, requestId, cursorStr);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── Chunked upload sub-protocol (R2 multipart; contract §3) ──
// Three steps, fully stateless across requests: the upload manifest and each
// part's etag are persisted as tiny R2 marker objects under …/uploads/, so
// complete() can resume the R2 multipart upload and assemble the part list with
// no DB schema and no in-memory state.

// POST …/objects/{digest}/uploads → { uploadId, partSize }

export async function handleStartUpload(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  digest: string,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_WRITE);
  if (!authz.ok) return authz.response;

  if (!isValidDigest(digest)) {
    return validationError(requestId, { digest: ["Path digest must be 'sha256:<64 hex>'"] });
  }

  const bucketResult = requireBucket(env);
  if (!bucketResult.ok) {
    return errorResponse(bucketResult.code, bucketResult.message, bucketResult.status, requestId);
  }
  const orgPub = orgPublicId(orgId);
  const projPub = projectPublicId(projectId);

  // The object kind is supplied at complete-time (Orun-Object-Kind header) so
  // start needs only the digest; it returns the uploadId + the part size the
  // client must chunk to.
  return startUploadInner(bucketResult.bucket, requestId, orgPub, projPub, digest);
}

async function startUploadInner(
  bucket: R2Bucket,
  requestId: string,
  orgPub: string,
  projPub: string,
  digest: string,
): Promise<Response> {
  try {
    const targetKey = objectKey(orgPub, projPub, digest);
    const upload = await bucket.createMultipartUpload(targetKey);
    const manifest: UploadManifest = {
      digest,
      kind: "", // kind is supplied on complete (header) — kept blank here
      partSize: DEFAULT_PART_SIZE,
      targetKey,
      createdAt: new Date().toISOString(),
    };
    await bucket.put(
      uploadManifestKey(orgPub, projPub, digest, upload.uploadId),
      JSON.stringify(manifest),
      { customMetadata: { digest } },
    );
    return successResponse({ uploadId: upload.uploadId, partSize: DEFAULT_PART_SIZE }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

// PUT …/objects/{digest}/uploads/{uploadId}/parts/{n}

export async function handleUploadPart(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  digest: string,
  uploadId: string,
  partNumber: number,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_WRITE);
  if (!authz.ok) return authz.response;

  if (!isValidDigest(digest)) {
    return validationError(requestId, { digest: ["Path digest must be 'sha256:<64 hex>'"] });
  }
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > OBJECT_MULTIPART_MAX_PARTS) {
    return validationError(requestId, { part: [`Part number must be 1..${OBJECT_MULTIPART_MAX_PARTS}`] });
  }

  const bucketResult = requireBucket(env);
  if (!bucketResult.ok) {
    return errorResponse(bucketResult.code, bucketResult.message, bucketResult.status, requestId);
  }
  const bucket = bucketResult.bucket;
  const orgPub = orgPublicId(orgId);
  const projPub = projectPublicId(projectId);

  // The upload must exist (manifest marker) — a stray uploadId 404s.
  const manifestObj = await bucket.get(uploadManifestKey(orgPub, projPub, digest, uploadId));
  if (!manifestObj) return errorResponse("not_found", "Unknown upload", 404, requestId);

  const partBuf = await request.arrayBuffer();
  if (partBuf.byteLength > OBJECT_MULTIPART_PART_MAX_BYTES) {
    return errorResponse(
      "payload_too_large",
      `Part exceeds the ${OBJECT_MULTIPART_PART_MAX_BYTES}-byte per-part budget`,
      413,
      requestId,
    );
  }

  try {
    const upload = bucket.resumeMultipartUpload(objectKey(orgPub, projPub, digest), uploadId);
    const uploaded = await upload.uploadPart(partNumber, partBuf);
    // Persist the part's etag for assembly at complete-time.
    await bucket.put(
      uploadPartKey(orgPub, projPub, digest, uploadId, partNumber),
      JSON.stringify({ partNumber, etag: uploaded.etag, size: partBuf.byteLength }),
    );
    return successResponse({ partNumber, etag: uploaded.etag }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

// POST …/objects/{digest}/uploads/{uploadId}/complete

export async function handleCompleteUpload(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  digest: string,
  uploadId: string,
  deps?: ObjectHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_WRITE);
  if (!authz.ok) return authz.response;

  if (!isValidDigest(digest)) {
    return validationError(requestId, { digest: ["Path digest must be 'sha256:<64 hex>'"] });
  }
  const kind = request.headers.get("Orun-Object-Kind") ?? "";
  if (!isValidObjectKind(kind)) {
    return validationError(requestId, {
      "Orun-Object-Kind": ["Required header; one of plan|catalog-snapshot|composition-lock|artifact-manifest|job-result|log|run-record"],
    });
  }

  const bucketResult = requireBucket(env);
  if (!bucketResult.ok) {
    return errorResponse(bucketResult.code, bucketResult.message, bucketResult.status, requestId);
  }
  const bucket = bucketResult.bucket;
  const orgPub = orgPublicId(orgId);
  const projPub = projectPublicId(projectId);

  const manifestObj = await bucket.get(uploadManifestKey(orgPub, projPub, digest, uploadId));
  if (!manifestObj) return errorResponse("not_found", "Unknown upload", 404, requestId);

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);

    // Allow-list gate (see handlePutObject): an OIDC CI may finalize an object
    // only while its repo has an active workspace link. Checked before the R2
    // assemble so an unlinked workflow is denied without doing the work. No-op
    // for human actors (governed by authz above).
    const allowed = await requireWorkflowRepoAllowed(repo, requestId, actor, orgId, projectId);
    if (!allowed.ok) return allowed.response;

    // Gather the recorded part etags (ordered by part number).
    const parts: { partNumber: number; etag: string }[] = [];
    let cursor: string | undefined;
    const prefix = uploadPartsPrefix(orgPub, projPub, digest, uploadId);
    do {
      const listOpts: R2ListOptions = cursor === undefined
        ? { prefix, limit: 1000 }
        : { prefix, cursor, limit: 1000 };
      const listed = await bucket.list(listOpts);
      for (const o of listed.objects) {
        const marker = await bucket.get(o.key);
        if (!marker) continue;
        const parsed = (await marker.json()) as { partNumber: number; etag: string };
        parts.push({ partNumber: parsed.partNumber, etag: parsed.etag });
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    if (parts.length === 0) {
      return errorResponse("bad_request", "No parts uploaded for this upload", 400, requestId);
    }
    parts.sort((a, b) => a.partNumber - b.partNumber);

    // Complete the R2 multipart upload, assembling the final object.
    const upload = bucket.resumeMultipartUpload(objectKey(orgPub, projPub, digest), uploadId);
    let assembled: R2Object;
    try {
      assembled = await upload.complete(parts);
    } catch {
      return errorResponse("bad_request", "Failed to assemble multipart upload", 400, requestId);
    }

    // ── Assembled-digest verification: hash the stored object and compare. ──
    const stored = await bucket.get(objectKey(orgPub, projPub, digest));
    if (!stored) return errorResponse("internal_error", "Assembled object missing", 503, requestId);
    const assembledBytes = await stored.arrayBuffer();
    const actual = await computeDigest(assembledBytes);
    if (actual !== digest) {
      // The assembled content does not match the claimed digest — delete it and
      // reject, so a corrupt/garbage upload never lands as a CAS object.
      await bucket.delete(objectKey(orgPub, projPub, digest));
      return errorResponse(
        "digest_mismatch",
        "Assembled object sha256 does not match the path digest",
        400,
        requestId,
        { expected: digest, actual },
      );
    }
    void assembled;

    const upsert = await repo.upsertObject({
      id: generateUuid(),
      orgId,
      projectId,
      digest,
      kind: kind as StateObjectKind,
      sizeBytes: assembledBytes.byteLength,
      createdBy: { id: actor.subjectId, kind: actorKindOf(actor.subjectType) },
    });
    if (!upsert.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    // Clean up the upload markers (best-effort).
    try {
      await bucket.delete(uploadManifestKey(orgPub, projPub, digest, uploadId));
      const keys = parts.map((p) => uploadPartKey(orgPub, projPub, digest, uploadId, p.partNumber));
      if (keys.length > 0) await bucket.delete(keys);
    } catch {
      // Best-effort cleanup.
    }

    if (upsert.value.created) {
      await emitUsage({
        executor,
        orgPublicId: orgPub,
        projectPublicId: projPub,
        metric: STATE_METRICS.OBJECT_BYTES,
        quantity: assembledBytes.byteLength,
        idempotencySeed: digest,
        metadata: { kind, multipart: true },
      });
      await emitUsage({
        executor,
        orgPublicId: orgPub,
        projectPublicId: projPub,
        metric: STATE_METRICS.OBJECT_COUNT,
        quantity: 1,
        idempotencySeed: digest,
        metadata: { kind, multipart: true },
      });
    }

    const payload: PutObjectResponse = {
      object: toPublicObject(upsert.value.object),
      created: upsert.value.created,
    };
    return successResponse(payload, requestId, upsert.value.created ? 201 : 200);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}
