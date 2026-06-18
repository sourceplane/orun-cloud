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
}

/**
 * Walk the transitive closure of `roots`, returning the set of reachable
 * digests. A blob (or absent object) is a leaf; a tree enqueues its children.
 * Stops at MAX_VISIT, reporting whether it was capped.
 */
async function reachableClosure(
  fetch: ObjectFetcher,
  roots: string[],
): Promise<{ visited: Set<string>; capped: boolean }> {
  const visited = new Set<string>();
  const queue: string[] = [...roots];
  let capped = false;
  while (queue.length > 0) {
    if (visited.size >= MAX_VISIT) {
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
  try {
    const repo = createStateRepository(executor);

    const rootsResult = await repo.listStorageGcRoots(scope.orgId, scope.projectId);
    if (!rootsResult.ok) return null;
    const objectsResult = await repo.listObjectDigestsWithSize(scope.orgId, scope.projectId, MAX_VISIT);
    if (!objectsResult.ok) return null;
    const objects = objectsResult.value;

    const { visited, capped } = await reachableClosure(fetcher, rootsResult.value);

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
      capped,
    };
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
