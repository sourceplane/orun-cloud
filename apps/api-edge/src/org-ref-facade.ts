// Org-ref resolver at the api-edge chokepoint (saas-workspace-id WID3).
//
// The platform accepts three spellings of an org reference in a URL path:
//   - `org_<hex>` — the opaque, legacy id (a UUID with dashes stripped);
//   - `ws_<8>`    — the durable, immutable public Workspace ID (WID2);
//   - `slug`      — the mutable vanity label.
//
// Every bounded-context worker only knows how to decode `org_<hex>`
// (`parseOrgPublicId`) and MUST NOT query the membership schema. So, exactly as
// `workspace-facade.ts` rewrites `/v1/workspaces/*` → `/v1/organizations/*`, this
// resolver rewrites a `ws_`/slug org segment to the canonical `org_<hex>` BEFORE
// route dispatch — at the edge, the one place allowed to call membership. Workers
// stay byte-for-byte unchanged.
//
// Hot-path discipline (design §4): an already-canonical `org_<hex>` segment (the
// shape ~all existing traffic carries) is passed through with ZERO overhead — no
// membership call. Only a `ws_`/slug segment incurs the (cached) resolve hop.

import type { Env } from "./env";
import {
  cacheApiStore,
  ORG_REF_CACHE_TTL_IMMUTABLE_SECONDS,
  ORG_REF_CACHE_TTL_SLUG_SECONDS,
  type OrgRefCacheStore,
} from "./org-ref-cache";

const ORG_PREFIX = "/v1/organizations";

/** A resolution that could not be completed: the caller should reply 404. */
export const ORG_REF_NOT_FOUND = Symbol("org_ref_not_found");
export type OrgRefNotFound = typeof ORG_REF_NOT_FOUND;

export interface ResolveOrgRefDeps {
  /** Injectable cache store (tests). Defaults to the Cache-API store. */
  cache?: OrgRefCacheStore;
}

/**
 * True when the path targets a specific org under `/v1/organizations` — i.e.
 * there IS an id segment (`/v1/organizations/{seg}` or `…/{seg}/…`). The bare
 * collection `/v1/organizations` has no segment and is left untouched.
 */
export function isOrgScopedPath(pathname: string): boolean {
  if (!pathname.startsWith(ORG_PREFIX + "/")) return false;
  const seg = pathname.slice(ORG_PREFIX.length + 1).split("/", 1)[0] ?? "";
  return seg.length > 0;
}

/** Extract the `{seg}` org-reference segment of an org-scoped path. */
export function extractOrgSegment(pathname: string): string {
  return pathname.slice(ORG_PREFIX.length + 1).split("/", 1)[0] ?? "";
}

/** Replace only the org-reference segment of an org-scoped path. */
function replaceOrgSegment(pathname: string, canonical: string): string {
  const rest = pathname.slice(ORG_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  const tail = slash === -1 ? "" : rest.slice(slash);
  return `${ORG_PREFIX}/${canonical}${tail}`;
}

function rewriteRequestPath(request: Request, rewrittenPath: string): Request {
  const url = new URL(request.url);
  url.pathname = rewrittenPath;
  return new Request(url.toString(), request);
}

/** Call membership-worker to resolve a `ws_`/slug ref → canonical `org_<hex>`. */
async function resolveViaMembership(
  ref: string,
  env: Env,
  requestId: string,
): Promise<string | null> {
  if (!env.MEMBERSHIP_WORKER) return null;
  let response: Response;
  try {
    response = await env.MEMBERSHIP_WORKER.fetch(
      "http://membership-worker/v1/internal/membership/resolve-org-ref",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({ ref }),
      },
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  const data = (parsed as { data?: { orgId?: unknown } } | null)?.data;
  const orgId = data?.orgId;
  return typeof orgId === "string" && orgId.startsWith("org_") ? orgId : null;
}

/**
 * Resolve any org-reference segment in an org-scoped path to the canonical
 * `org_<hex>`, returning the (possibly rewritten) `{ pathname, request }`.
 *
 *  - non-org-scoped path, or a segment already `org_<hex>` → returned unchanged,
 *    with NO membership call (the zero-overhead hot path);
 *  - `ws_`/slug segment → resolved (cache-first) to `org_<hex>` and the segment
 *    rewritten in both the pathname and the routed request URL;
 *  - unresolvable `ws_`/slug → `ORG_REF_NOT_FOUND`, so the caller replies 404
 *    instead of forwarding an undecodable ref to a worker.
 */
export async function resolveOrgRefInPath(
  pathname: string,
  request: Request,
  env: Env,
  requestId: string,
  deps?: ResolveOrgRefDeps,
): Promise<{ pathname: string; request: Request } | OrgRefNotFound> {
  if (!isOrgScopedPath(pathname)) {
    return { pathname, request };
  }
  const ref = extractOrgSegment(pathname);
  // Already canonical → hot path: no membership call, no cache touch.
  if (ref.startsWith("org_")) {
    return { pathname, request };
  }

  const cache = deps?.cache ?? cacheApiStore();
  let canonical = await cache.get(ref);
  if (!canonical) {
    canonical = await resolveViaMembership(ref, env, requestId);
    if (!canonical) {
      return ORG_REF_NOT_FOUND;
    }
    const ttl = ref.startsWith("ws_")
      ? ORG_REF_CACHE_TTL_IMMUTABLE_SECONDS
      : ORG_REF_CACHE_TTL_SLUG_SECONDS;
    await cache.set(ref, canonical, ttl);
  }

  const rewritten = replaceOrgSegment(pathname, canonical);
  return { pathname: rewritten, request: rewriteRequestPath(request, rewritten) };
}
