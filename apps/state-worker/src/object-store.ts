// R2 object/log blob store (OP3 — design §4.1 / §4.3).
//
// All blob bytes (CAS objects, log chunks) live in the `ORUN_STATE` R2 bucket;
// Postgres holds only the index rows. This module is the single place that
// knows the R2 key layout, verifies content digests, and brokers the R2
// multipart sub-protocol for blobs over the single-request budget.
//
// The `dev` environment has NO R2 binding (wrangler.template.jsonc binds
// ORUN_STATE only on stage/prod) so the dormant dev deploy stays green. Every
// entry point guards the binding with `requireBucket` and returns a clear,
// actionable error when it is unbound rather than throwing — exactly like the
// other optional-binding guards in this worker.

import type { Env } from "./env.js";
import {
  OBJECT_MULTIPART_PART_SIZE_BYTES,
} from "./constants.js";

// ── Binding guard ───────────────────────────────────────────

export type BucketResult =
  | { ok: true; bucket: R2Bucket }
  | { ok: false; code: string; message: string; status: number };

/**
 * Resolve the R2 bucket or return a structured error. The dev environment has
 * no binding by design; callers surface this as a `503 storage_unavailable` so
 * the no-R2 dev deploy is well-behaved (the route exists; the store is absent).
 */
export function requireBucket(env: Env): BucketResult {
  if (!env.ORUN_STATE) {
    return {
      ok: false,
      code: "storage_unavailable",
      message:
        "Object/log storage (ORUN_STATE R2 bucket) is not bound in this environment.",
      status: 503,
    };
  }
  return { ok: true, bucket: env.ORUN_STATE };
}

// ── Key layout (design §4.1 / §4.3) ─────────────────────────
// orgId/projectId here are the public ids (org_…, prj_…) so keys are stable,
// human-greppable, and never leak internal UUIDs.

/** `state/{orgId}/{projectId}/objects/{digest}` — a CAS blob. */
export function objectKey(orgPublic: string, projectPublic: string, digest: string): string {
  return `state/${orgPublic}/${projectPublic}/objects/${digest}`;
}

/** `state/{org}/{project}/runs/{runId}/logs/{jobId}/{seq}` — one log chunk. */
export function logChunkKey(
  orgPublic: string,
  projectPublic: string,
  runUlid: string,
  jobId: string,
  seq: number,
): string {
  return `state/${orgPublic}/${projectPublic}/runs/${runUlid}/logs/${encodeURIComponent(jobId)}/${seq}`;
}

/** Marker object holding a pending multipart upload's metadata (digest+kind). */
export function uploadManifestKey(
  orgPublic: string,
  projectPublic: string,
  digest: string,
  uploadId: string,
): string {
  return `state/${orgPublic}/${projectPublic}/uploads/${digest}/${uploadId}/manifest`;
}

/** Marker object recording one uploaded part's etag for later assembly. */
export function uploadPartKey(
  orgPublic: string,
  projectPublic: string,
  digest: string,
  uploadId: string,
  partNumber: number,
): string {
  return `state/${orgPublic}/${projectPublic}/uploads/${digest}/${uploadId}/parts/${partNumber}`;
}

/** Prefix for all part markers of one upload (used to list/assemble on complete). */
export function uploadPartsPrefix(
  orgPublic: string,
  projectPublic: string,
  digest: string,
  uploadId: string,
): string {
  return `state/${orgPublic}/${projectPublic}/uploads/${digest}/${uploadId}/parts/`;
}

// ── Digest verification ─────────────────────────────────────

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Whether a string is a well-formed `sha256:<64 hex>` content address. */
export function isValidDigest(value: string): boolean {
  return DIGEST_RE.test(value);
}

/** Compute the `sha256:<hex>` content address of a byte buffer (Web Crypto). */
export async function computeDigest(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // Pass a fresh, non-shared ArrayBuffer to crypto.subtle.digest so the type is
  // a plain ArrayBuffer (never SharedArrayBuffer) and we never digest a view's
  // backing buffer beyond its bounds.
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer);
  const hex = bytesToHex(new Uint8Array(hash));
  return `sha256:${hex}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

// ── Object kinds ────────────────────────────────────────────

const OBJECT_KINDS = new Set([
  "plan",
  "catalog-snapshot",
  "composition-lock",
  "artifact-manifest",
]);

export function isValidObjectKind(value: string): boolean {
  return OBJECT_KINDS.has(value);
}

// ── Multipart upload manifest (persisted in R2 as a JSON marker) ──
// R2's resumeMultipartUpload(key, uploadId) reconstructs the upload, but the
// per-part etags must survive between PART requests and COMPLETE. We persist
// both the upload manifest (digest+kind+partSize) and each part's etag as tiny
// R2 marker objects under …/uploads/{digest}/{uploadId}/, so no DB schema or
// in-memory state is needed and the protocol is fully stateless across requests.

export interface UploadManifest {
  digest: string;
  kind: string;
  partSize: number;
  /** R2 object key the multipart upload targets (the final blob key). */
  targetKey: string;
  createdAt: string;
}

export const DEFAULT_PART_SIZE = OBJECT_MULTIPART_PART_SIZE_BYTES;
