# Implementation Status — saas-performance

As-built record for the PERF cluster. Design intent + measurement record are in
`design.md`; the milestone list is in `implementation-plan.md`. Trust the live
prod numbers (re-measure) over this doc.

## Summary

**PERF1–PERF5 + the PERF6 core shipped and verified; PERF6b + PERF7–9 planned.** The headline
result: the 2026-06-08 prod re-measurement found the edge rate limiter (a KV
read-modify-write before auth, twice for org-scoped routes) was ~80% of warm
server time; PERF5 moved it to an in-isolate limiter + a `RateLimiterDO` Durable
Object, taking org-scoped reads/writes to ~55–65ms p50 (edge floor, beating the
<150ms target).

| ID | Status | PR(s) / task |
|----|--------|--------------|
| PERF1 | ✅ Shipped | #216 / 0130 |
| PERF2 | ✅ Shipped | #220 / 0131 |
| PERF3 | ✅ Shipped (reuse leg reverted) | #221 / 0132; reverted #227; #228 IN-list fix |
| PERF4 | ✅ Shipped | #230 / 0133 |
| PERF5 | ✅ Shipped + verified | #245 (Stage A), #246 (Stage B), #247 (verify) |
| PERF6 (core) | ✅ Shipped + verified | #248 (edge-gate measurability) |
| Idempotency L1 | ✅ Shipped + verified | #256 (Cache API replay L1, tiered over KV) |
| PERF6b | 🗓️ Planned | AE dataset + dashboards + synthetic prober |
| PERF7 | 🗓️ Planned | — (re-measured: console SSR spikes 1.0–2.6s; edge cold ~0.7s) |
| PERF8 | 🗓️ Planned | — |
| PERF9 | 🗓️ Planned | — |
| PERF10 | ✅ Shipped + verified | #305 (immutable `_next/static` headers; live cache-control confirmed) |
| PERF11 | ✅ Shipped (shell + profile) | #306 (sidebar/scope switchers + account profile → react-query) |
| PERF11b | 🗓️ Planned | paginated console surfaces (account/security, usage, webhook deliveries) |
| PERF12 | ✅ Shipped (a/b/c); 12d remaining | #308 billing · #310 config · #312 webhooks (authz∥read, deny-by-default) |
| PERF12d | 🗓️ Planned | identity resolve: fold session→user (and api-key→principal) into one JOIN |
| PERF13 | 🗓️ Planned (needs TTL decision) | authz-context + near-static micro-caches — revocation latency = TTL |
| PERF14 | 🗓️ Planned | second audit: Server-Timing coverage + timing-log sampling |

## Verified prod numbers (2026-06-08, warm p50)

- Edge floor (preflight / 404): ~56ms.
- `/health` Hyperdrive DB ping: ~62ms (DB is no longer the bottleneck — Hyperdrive
  pooling carries it, ~6ms over floor).
- Org-scoped read: ~320ms → **~55ms** after PERF5.
- Org-scoped write: ~320ms → **~65ms** after PERF5.
- Idempotency same-colo replay: `edge_idem` **~79ms → ~3–4ms** after the Cache API
  L1 (PR #256); first request unchanged (KV stays authoritative).

PERF6 made the gate measurable in `Server-Timing` (PR #248) and surfaced:
- reads `edge_ratelimit;dur=0` (in-isolate limiter proven zero-cost);
- warm-DO writes `edge_ratelimit;dur=10–12` (Stage B win); a **DO cold/cross-colo
  tail ~300–360ms** on the first write to an idle bucket;
- idempotency replay `edge_idem;dur=40–96` (KV `get`) on keyed writes → **addressed
  for same-colo replays** by a colo-local Cache API L1 in front of KV (PR #256):
  replays drop to ~3–4ms; first request still consults KV (global correctness).

A **second full-surface audit (2026-06-08, post-PERF5/6)** probed every edge
route family + console delivery on stage and prod and audited client + worker
code: edge is uniformly at floor (~50–65ms, all families, `edge_ratelimit=0`;
service-binding hops ≈ free), but found five new improvement clusters —
scheduled as **PERF10–PERF14** (see `design.md` § "Second full-surface audit").
Headlines: `_next/static` chunks served `max-age=0` (revalidated every repeat
visit), console SSR cold spikes 1.0–2.6s, 6 console surfaces bypass the query
cache, 10 worker read handlers still serialize authz→db, and the per-request
timing logs are a ~$50–80/mo Workers-Logs exposure at 50M req/mo (sample them).

## Open

- **PERF6 tail:** Analytics Engine sink + per-route p50/p95 dashboards + synthetic
  prober.
- **PERF9 leftovers:** reverse-lookup index migration; Hyperdrive cache-eligibility
  audit; read replica at scale.
- See `risks-and-open-questions.md` for the connection-reuse lesson.
