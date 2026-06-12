# Task 0137 — PX3 notification preferences e2e (+ PX2 completion tail) — Implementer Report

## Summary

- api-edge `notifications-facade`: `GET`/`PUT /v1/notifications/preferences` →
  notifications-worker service binding (stage+prod), **subject pinned to the
  resolved session actor** (forged `subjectKind`/`subjectId` discarded);
  `notifications` rate-limit family; additive `"api-edge"` internal-actor
  contract entry.
- Console `/orgs/:slug/settings/notifications`: five category toggles,
  optimistic with rollback, opt-out semantics; settings-nav + breadcrumb
  entries; pure preference model unit-tested.
- CLI: `notifications preferences` (get) + `notifications preferences set
  --category --enabled` with fake-SDK tests (5 cases).
- **PX2 completion tail:** live verification found stage backend drift (no
  successful worker convergence since the failed #280 run — cascade
  dependency-wait timeouts; `--changed` planning never re-deployed). This PR
  redeploys api-edge (source change), re-touches config-worker +
  notifications-worker, and adds a config-worker deploy-lane
  `preDeployCommand` that provisions `SECRET_ENCRYPTION_KEY`
  (generate-if-missing via `wrangler secret list/put`, deploy profile only) —
  fixing the live "Encryption is not configured" and flag-PATCH 404s.
- `ai/deferred.md`: notification-preferences entry unparked/removed.

## Checks Run

- tests: api-edge 345 (6 new facade tests incl. subject-pinning proofs),
  web-console-next 207 (4 new), cli 208 (5 new), contracts 203,
  notifications-worker 23 — all green.
- typecheck + lint green on api-edge, web-console-next, cli.
- `kiox` unavailable here; Orun plan/dry-run exercised via PR CI.

## Assumptions

- Org-subject (organization-level) preferences stay internal-only — no public
  route; recorded in the facade doc comment.
- Encryption-key escrow to AWS Secrets Manager is a named follow-up (BF
  deploy-time wiring); the key currently lives only in Cloudflare.

## Spec Proposals

None — additive contract entry within PX3 latitude.

## Remaining Gaps

- Full-fleet backend convergence (membership/events/webhooks/metering/
  projects/policy workers still on pre-#280 deploys) — follow-up task.
- `api-edge-tests · dev` and `policy-worker · dev` real failures from the
  #280 run need re-checking against current main (api-edge tests pass
  locally; PR CI will confirm).

## PR Number

#303.
