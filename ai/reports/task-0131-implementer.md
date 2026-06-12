# Task 0131 — PERF2: Edge bearer-resolution cache — Implementer Report

Milestone `PERF2-edge-bearer-cache`. Branch `impl/task-0131-edge-bearer-cache`.
Backend (api-edge + auth-facade logout hook). No contract change.

## Why

Bearer→actor resolution runs on every authenticated request (api-edge →
identity-worker → 2 DB queries; ~0.45s measured: bad-token 401 ≈ 0.7s vs
unauthenticated 401 ≈ 0.25s). For a stable session/key it's identical
request-to-request → cacheable on the hot path.

## What shipped

- **`apps/api-edge/src/actor-cache.ts`** — an `ActorCacheStore` interface +
  a Workers **Cache API** implementation (`caches.default`) and a `noopStore`
  fallback. Keyed on a **SHA-256 hash of the token** (`hashToken`); stores only
  the minimal non-secret `ActorInfo`; TTL `ACTOR_CACHE_TTL_SECONDS = 30` via
  `Cache-Control: max-age`. All operations best-effort (errors fall through).
  Chose the Cache API over KV deliberately: **no new resource/infra**,
  colo-local is fine for a 30s auth cache, and `cache.delete` gives prompt
  logout eviction.
- **`resolveActor`** (shared by all 7 facades) now: checks the cache first
  (hit → skip the identity hop entirely), and on a successful live resolve,
  writes to the cache. **Denials and missing-auth are never cached.** A
  `deps.cache` param makes it unit-testable; production defaults to the
  Cache-API store (which no-ops where `caches` is unavailable).
- **Logout eviction** — `auth-facade` evicts the token's cache entry after a
  successful `POST /v1/auth/logout`, so a revoked session can't be served from
  the edge cache for the rest of its TTL.

## Security

- Raw token never stored/logged (hash-keyed); cached value is `ActorInfo` only
  (subjectId/Type, email, orgId) — no token, no secrets.
- Only `allowed` resolutions cached; a 401/denial re-resolves live (fail-closed
  preserved by the resolver).
- Revocation latency bounded by the 30s TTL; logout is immediate (eviction).

## Tests & gates

- `tests/api-edge/src/resolve-actor.test.ts` (8 cases): cold miss resolves +
  caches; warm hit skips identity; denial not cached (re-hits); evict
  re-resolves; token isolation; missing-auth short-circuits with no identity
  call/cache write; noopStore never caches; `hashToken` is a deterministic
  64-hex digest that never embeds the raw token.
- Full api-edge suite **313 passing**; typecheck ✓, lint ✓. Existing facade
  tests unaffected (Cache API no-ops in jest → live resolve as before).

## Live verification

Pending stage deploy on merge: measure TTFB of a repeated authed endpoint
(same token, within 30s) before vs after — expect ~0.3–0.45s reduction on the
cache-hit requests, and a logout then immediate re-request re-resolving live.

## Follow-ups / notes

- Cache API is colo-local; a cross-colo/global cache (Workers KV) is a later
  option if hit-rate across regions matters. API-key resolutions (longer-lived)
  use the same 30s TTL here; a longer key-specific TTL is a possible refinement.
