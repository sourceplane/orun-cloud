// Edge org-ref → canonical `org_<hex>` resolution cache (saas-workspace-id WID3).
//
// The org-ref resolver (org-ref-facade.ts) rewrites a `ws_`/slug URL segment to
// the canonical `org_<hex>` at the edge, which costs one membership-worker hop.
// That mapping is stable enough to cache:
//
//  - `ws_…` (public_ref) and `org_…` are IMMUTABLE → cache for a long TTL with
//    no invalidation concern (the design's "trivially cacheable, no
//    invalidation" property, §4);
//  - `slug` is MUTABLE (renamable) → cache for a short TTL so a rename
//    propagates quickly.
//
// Mirrors actor-cache.ts: backed by the Workers Cache API (`caches.default`,
// colo-local, no new infra), with a `noopStore` fallback for unit tests. Unlike
// the actor cache, the key material is the raw ref string — it is a public,
// non-secret identifier (`ws_…`/slug), so there is nothing to hash.

export interface OrgRefCacheStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, orgId: string, ttlSeconds: number): Promise<void>;
}

/** Immutable refs (`ws_`/`org_`) — safe to cache for a long time, no invalidation. */
export const ORG_REF_CACHE_TTL_IMMUTABLE_SECONDS = 3600;
/** Mutable slug — short TTL so a rename propagates quickly. */
export const ORG_REF_CACHE_TTL_SLUG_SECONDS = 60;

function keyUrl(ref: string): string {
  return `https://org-ref-cache.internal/v1/${encodeURIComponent(ref)}`;
}

/** No-op store: every get misses, set does nothing. */
export function noopStore(): OrgRefCacheStore {
  return {
    async get() {
      return null;
    },
    async set() {
      /* no-op */
    },
  };
}

type CacheLike = {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
};

/** Cache-API-backed store. Falls back to a no-op store when unavailable. */
export function cacheApiStore(): OrgRefCacheStore {
  const c =
    typeof caches !== "undefined" && (caches as unknown as { default?: CacheLike }).default
      ? (caches as unknown as { default: CacheLike }).default
      : null;
  if (!c) return noopStore();
  return {
    async get(ref) {
      try {
        const res = await c.match(keyUrl(ref));
        if (!res) return null;
        const text = await res.text();
        return text.length > 0 ? text : null;
      } catch {
        return null;
      }
    },
    async set(ref, orgId, ttlSeconds) {
      try {
        const res = new Response(orgId, {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "cache-control": `max-age=${ttlSeconds}`,
          },
        });
        await c.put(keyUrl(ref), res);
      } catch {
        /* best-effort */
      }
    },
  };
}
