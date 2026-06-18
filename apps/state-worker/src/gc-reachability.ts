// Object GC reachability (OV9, REPORT-ONLY — design-v2 §9 retention/GC).
//
// Computes how much of a project's object store is no longer reachable from any
// live pointer, so an operator can see reclaimable storage BEFORE any deletion
// exists. This module DELETES NOTHING — it reads the roots, walks their closure
// with the OV6.2a object-model reader, and diffs against the stored objects.
//
// Roots (state.listStorageGcRoots): current ref targets + retained catalog-head
// digests + run plan digests. Reachable = the transitive closure of those root
// trees. Conservative by construction — retained history keeps its objects
// reachable, so the report never over-claims reclaimable storage. The walk is
// bounded by a visit cap; if hit, `capped` is set and the reclaimable figure is
// an UPPER bound (an incomplete reachable set can only mark more as unreachable),
// which any future delete path must treat as "do not delete".
//
// Best-effort + dormant: needs the ORUN_STATE R2 bucket (absent on dev) and the
// DB; returns null when storage is unavailable.

import type { Env } from "./env.js";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { createStateRepository } from "@saas/db/state";
import { requireBucket, objectKey } from "./object-store.js";
import { readTree, type ObjectFetcher } from "./object-model.js";

/** Bound the walk so one report does bounded R2 work; see `capped`. */
const MAX_VISIT = 20_000;

export interface StorageGcReportScope {
  orgId: Uuid;
  projectId: Uuid;
  /** Public ids — the R2 key layout (object-store.ts) addresses by these. */
  orgPublic: string;
  projectPublic: string;
}

export interface StorageGcReport {
  totalObjects: number;
  totalBytes: number;
  reachableObjects: number;
  unreachableObjects: number;
  /** Bytes held by objects no live pointer reaches — what GC could reclaim. */
  reclaimableBytes: number;
  /** The walk hit the visit cap: reclaimable is an upper bound, do not delete. */
  capped: boolean;
}

export interface StorageGcReportDeps {
  executor?: SqlExecutor;
  /** Override the object byte-fetch (tests inject a synthetic store). */
  fetcher?: ObjectFetcher;
  /** Override the walk/object-list bound (tests exercise the capped path). */
  maxVisit?: number;
}

/**
 * Walk the transitive closure of `roots`, returning the set of reachable
 * digests. A blob (or absent object) is a leaf; a tree enqueues its children.
 * Stops at MAX_VISIT, reporting whether it was capped.
 */
async function reachableClosure(
  fetch: ObjectFetcher,
  roots: string[],
  maxVisit: number,
): Promise<{ visited: Set<string>; capped: boolean }> {
  const visited = new Set<string>();
  const queue: string[] = [...roots];
  let capped = false;
  while (queue.length > 0) {
    if (visited.size >= maxVisit) {
      capped = true;
      break;
    }
    const digest = queue.pop()!;
    if (visited.has(digest)) continue;
    visited.add(digest);
    // A tree yields children; a blob / absent object yields null (a leaf).
    const entries = await readTree(fetch, digest);
    if (entries) {
      for (const e of entries) {
        if (!visited.has(e.id)) queue.push(e.id);
      }
    }
  }
  return { visited, capped };
}

/**
 * Compute the project's storage GC report. Best-effort: returns null when R2 or
 * the DB is unavailable. Never deletes.
 */
export async function computeStorageGcReport(
  env: Env,
  scope: StorageGcReportScope,
  deps?: StorageGcReportDeps,
): Promise<StorageGcReport | null> {
  let fetcher = deps?.fetcher;
  if (!fetcher) {
    const bucket = requireBucket(env);
    if (!bucket.ok) return null; // no R2 binding (dev) — dormant
    fetcher = (digest: string) =>
      bucket.bucket
        .get(objectKey(scope.orgPublic, scope.projectPublic, digest))
        .then(async (o) => (o ? new Uint8Array(await o.arrayBuffer()) : null));
  }

  if (!deps?.executor && !env.PLATFORM_DB) return null;
  const executor = deps?.executor ?? (await import("@saas/db/hyperdrive")).createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  const maxVisit = deps?.maxVisit ?? MAX_VISIT;
  try {
    const repo = createStateRepository(executor);

    const rootsResult = await repo.listStorageGcRoots(scope.orgId, scope.projectId);
    if (!rootsResult.ok) return null;
    const objectsResult = await repo.listObjectDigestsWithSize(scope.orgId, scope.projectId, maxVisit);
    if (!objectsResult.ok) return null;
    const objects = objectsResult.value;

    const { visited, capped } = await reachableClosure(fetcher, rootsResult.value, maxVisit);

    // The object list is also bounded by maxVisit; if it filled the cap the
    // project has more objects than we enumerated, so the report is incomplete —
    // fold that into `capped` (a future delete path must refuse when capped).
    const objectsTruncated = objects.length >= maxVisit;

    let totalBytes = 0;
    let reachableObjects = 0;
    let reclaimableBytes = 0;
    for (const o of objects) {
      totalBytes += o.sizeBytes;
      if (visited.has(o.digest)) reachableObjects += 1;
      else reclaimableBytes += o.sizeBytes;
    }
    return {
      totalObjects: objects.length,
      totalBytes,
      reachableObjects,
      unreachableObjects: objects.length - reachableObjects,
      reclaimableBytes,
      capped: capped || objectsTruncated,
    };
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}

// ── Reclamation (OV9 GC-delete) — the dangerous direction, fenced. ──

export interface StorageGcCollectOptions {
  /** When true (the default), compute candidates but delete nothing. */
  dryRun: boolean;
  /** Only objects older than now-graceMs are eligible (recently-uploaded ones
   *  may be referenced by an in-flight head/ref not yet advanced). */
  graceMs: number;
  /** Upper bound on deletions per call. */
  limit: number;
}

export interface StorageGcCollectResult {
  totalObjects: number;
  reachableObjects: number;
  unreachableObjects: number;
  /** Unreachable AND older than the grace window AND within `limit`. */
  candidateObjects: number;
  candidateBytes: number;
  deletedObjects: number;
  deletedBytes: number;
  /** Effective dry-run: true if requested, or forced because capped. */
  dryRun: boolean;
  /** The reachable set was incomplete — deletion is REFUSED (never deletes). */
  capped: boolean;
}

export interface StorageGcCollectDeps {
  executor?: SqlExecutor;
  fetcher?: ObjectFetcher;
  /** Delete one object's R2 blob by digest (tests inject a spy). */
  deleter?: (digest: string) => Promise<void>;
  /** Override the walk/object-list bound (tests exercise the capped refusal). */
  maxVisit?: number;
}

/**
 * Reclaim a project's unreachable objects — the only deleting path in the GC.
 * Layered safety: it deletes ONLY when `dryRun` is false AND the reachable walk
 * was complete (never when `capped` — an incomplete closure can only over-count
 * unreachable), and ONLY objects older than the grace window, bounded by `limit`.
 * R2 blob is deleted first, then the index row (a crash leaves at most an
 * already-unreachable index row a re-run collects). Best-effort/dormant: returns
 * null without R2 or DB.
 */
export async function collectStorageGc(
  env: Env,
  scope: StorageGcReportScope,
  opts: StorageGcCollectOptions,
  deps?: StorageGcCollectDeps,
): Promise<StorageGcCollectResult | null> {
  let fetcher = deps?.fetcher;
  let deleter = deps?.deleter;
  if (!fetcher || !deleter) {
    const bucket = requireBucket(env);
    if (!bucket.ok) return null; // no R2 binding (dev) — dormant
    fetcher ??= (digest: string) =>
      bucket.bucket
        .get(objectKey(scope.orgPublic, scope.projectPublic, digest))
        .then(async (o) => (o ? new Uint8Array(await o.arrayBuffer()) : null));
    deleter ??= (digest: string) => bucket.bucket.delete(objectKey(scope.orgPublic, scope.projectPublic, digest));
  }

  if (!deps?.executor && !env.PLATFORM_DB) return null;
  const executor = deps?.executor ?? (await import("@saas/db/hyperdrive")).createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  const maxVisit = deps?.maxVisit ?? MAX_VISIT;
  try {
    const repo = createStateRepository(executor);

    const rootsResult = await repo.listStorageGcRoots(scope.orgId, scope.projectId);
    if (!rootsResult.ok) return null;
    const objectsResult = await repo.listObjectDigestsWithSize(scope.orgId, scope.projectId, maxVisit);
    if (!objectsResult.ok) return null;
    const objects = objectsResult.value;

    const walk = await reachableClosure(fetcher, rootsResult.value, maxVisit);
    const capped = walk.capped || objects.length >= maxVisit;

    const reachableObjects = objects.filter((o) => walk.visited.has(o.digest)).length;
    const graceCutoff = Date.now() - opts.graceMs;
    const candidates = objects
      .filter((o) => !walk.visited.has(o.digest))
      .filter((o) => {
        const t = Date.parse(o.createdAt);
        return Number.isFinite(t) && t < graceCutoff; // unparseable → ineligible (safe)
      })
      .slice(0, Math.max(0, opts.limit));
    const candidateBytes = candidates.reduce((n, o) => n + o.sizeBytes, 0);

    // Delete only on an explicit, non-capped, non-dry-run request.
    const willDelete = !opts.dryRun && !capped;
    let deletedObjects = 0;
    let deletedBytes = 0;
    if (willDelete) {
      for (const o of candidates) {
        try {
          await deleter(o.digest); // R2 blob first
          const dropped = await repo.deleteObject(scope.orgId, scope.projectId, o.digest);
          if (dropped.ok && dropped.value) {
            deletedObjects += 1;
            deletedBytes += o.sizeBytes;
          }
        } catch {
          // Best-effort per object: a failure leaves an unreachable object a
          // later collect retries; never abort the batch.
        }
      }
    }

    return {
      totalObjects: objects.length,
      reachableObjects,
      unreachableObjects: objects.length - reachableObjects,
      candidateObjects: candidates.length,
      candidateBytes,
      deletedObjects,
      deletedBytes,
      dryRun: opts.dryRun || capped, // capped forces a no-delete result
      capped,
    };
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
