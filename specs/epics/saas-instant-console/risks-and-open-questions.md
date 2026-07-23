# saas-instant-console — Risks & Open Questions

## Decisions needed (human)

- **D1 — IC3 mechanism: RSC data streaming vs. pre-hydration primer.** RSC
  server fetch is the platform-native answer but couples first paint to
  OpenNext SSR behavior (PERF7 measured 1.0–2.6s SSR spikes; HTML is
  `no-store`). A pre-hydration primer script that fires the boot fetches and
  seeds the query cache is a far smaller diff and keeps the all-client model.
  Recommendation: primer first (IC3 ships value immediately), revisit RSC
  after PERF7's SSR/ISR decision (D4 there) lands.
- **D2 — IC6 transport.** If Pages can't hold SSE legs, choosing the DO-relay
  WebSocket path pulls AN groundwork forward; long-poll is cheaper but a
  dead end. Decide when the passthrough verification lands.
- **D3 — Query-cache persistence & tokens (IC3).** Persisted cache must be
  keyed to token epoch and cleared on logout/org-switch (extend
  `CacheResetOnAuthChange`). Decide retention (suggest: session-scoped IDB,
  24h cap) and whether secrets-adjacent metadata is exempt from persistence.

## Risks

- **Deny-after-cache flashes.** Painting from a persisted cache can briefly
  show data the user no longer has access to before revalidation. Mitigation:
  revalidate-on-focus for org-scoped keys + the D3 epoch keying; same
  trade-off PERF2 documented for the bearer cache (TTL-bounded).
- **Aggregate-query regression risk (IC1).** The grouped-counts rewrite must
  match `getRunJobCounts` semantics per run (including zero-count runs).
  Guard: fixture parity test against the loop implementation before deletion.
- **Animation removal is taste-sensitive (IC4).** The fade is part of the
  Northwind feel; the change is "run once, not per nav", not "delete the
  brand". Screenshot review with the U-track owner before merge.
- **CI flake (IC9).** Timing assertions in shared CI runners flake; budgets
  use medians over ≥3 runs with a tolerance band, and fetch-count assertions
  (deterministic) carry the regression-catching weight.
- **Parallel work.** The console is under active development (WV/DX/AF
  surfaces). IC2–IC4 touch shell files (`layout.tsx`, `org-scope.tsx`,
  `northwind.tsx`); land as small, single-purpose PRs and rebase eagerly.
