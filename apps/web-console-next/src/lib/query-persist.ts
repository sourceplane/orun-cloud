"use client";

/**
 * Persisted query cache (IC3, decision D3).
 *
 * Revisits and warm navigations paint real data instantly from IndexedDB and
 * revalidate in the background, instead of re-serializing
 * `mount → fetch → skeleton` on every full load. Retention and safety:
 *
 * - **Keyed to target + token epoch**: the persister `buster` is a
 *   non-reversible hash of `${target}|${token}` — a restore only applies when
 *   both match, so a new identity (login/logout/token swap/target switch)
 *   never reads the previous identity's cache. The raw token is never stored.
 * - **24h cap** (`PERSIST_MAX_AGE_MS`), and `gcTime` is respected by
 *   dehydration as usual.
 * - **Secrets-adjacent metadata is exempt**: any query whose key mentions
 *   secrets (`configSecrets`, `secretsCapabilities`, …) is never written to
 *   disk. Errors and in-flight queries are not persisted either.
 * - Storage is IndexedDB (async, larger quota, off the main thread) with an
 *   inline ~30-line kv wrapper rather than a new dependency.
 */

import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";
import type { QueryClient } from "@tanstack/react-query";
import { STORAGE_PREFIX } from "./app-config";

export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const DB_NAME = `${STORAGE_PREFIX}.query-cache`;
const STORE = "kv";

// ── Minimal promise-based IndexedDB key-value store ─────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbOp<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const idbStorage = {
  getItem: (key: string) => idbOp<string | undefined>("readonly", (s) => s.get(key)).then((v) => v ?? null),
  setItem: (key: string, value: string) => idbOp("readwrite", (s) => s.put(value, key)).then(() => undefined),
  removeItem: (key: string) => idbOp("readwrite", (s) => s.delete(key)).then(() => undefined),
};

// ── Persister + options ─────────────────────────────────────

/**
 * Non-cryptographic FNV-1a hash. The buster only needs to (a) change when the
 * token or target changes and (b) not disclose the token; a 32-bit digest of a
 * high-entropy bearer satisfies both.
 */
export function epochBuster(targetName: string, token: string | null): string {
  const input = `${targetName}|${token ?? ""}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Secrets-adjacent cache entries never touch disk (D3). */
export function isPersistableQueryKey(key: readonly unknown[]): boolean {
  return !key.some((part) => typeof part === "string" && /secret/i.test(part));
}

export function createPersistOptions(
  targetName: string,
  token: string | null,
): Omit<PersistQueryClientOptions, "queryClient"> {
  const persister = createAsyncStoragePersister({
    storage: typeof indexedDB === "undefined" ? undefined : idbStorage,
    key: `${STORAGE_PREFIX}.query-cache.v1`,
    // Batch bursts of cache updates into one IDB write.
    throttleTime: 1_000,
  });
  return {
    persister,
    maxAge: PERSIST_MAX_AGE_MS,
    buster: epochBuster(targetName, token),
    dehydrateOptions: {
      shouldDehydrateQuery: (query) =>
        query.state.status === "success" && isPersistableQueryKey(query.queryKey),
    },
  };
}

/** Wipe the persisted cache (logout / token swap — extends CacheResetOnAuthChange). */
export function clearPersistedQueryCache(): void {
  if (typeof indexedDB === "undefined") return;
  void idbStorage.removeItem(`${STORAGE_PREFIX}.query-cache.v1`).catch(() => {
    /* best-effort */
  });
}

/** Test seam kept out of the component tree: dehydrate filtering + busting are
 *  pure and covered by unit tests; the provider wiring lives in providers.tsx. */
export type { QueryClient };
