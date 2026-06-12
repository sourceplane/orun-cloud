# Implementation Status — saas-baseline

As-built record for the Baseline (B) cluster. The design intent is in
`implementation-plan.md`; this is what shipped. Trust code over this doc — re-derive
from `git`/PRs on boot.

## Summary

| ID | Status | Evidence / notes |
|----|--------|------------------|
| B2 | ✅ Shipped | `apps/notifications-worker` live with template set, preferences API, delivery events. Real provider gated on `notifications-provider-swap`. |
| B3 | ✅ Shipped | api-edge idempotency for unsafe POSTs + per-org/per-identity rate limits, shared envelope, `Idempotency-Key` in contracts. |
| B4 | ✅ Shipped | `packages/sdk` (typed, from `contracts`) + `packages/cli` on top; console consumes `@saas/sdk` (U10). |
| B5 | ✅ Shipped | webhooks operability surfaces; `@sourceplane/webhook-verifier`; manual delivery replay end-to-end (PR #181). |
| B7 | ✅ Shipped | searchable audit history per org with filters + NDJSON export over events-worker. |
| B8 | ✅ Shipped | `apps/admin-worker` with audited support actions, impersonation trail, plan overrides, entitlement inspection (internal-only). |
| B9 | ✅ Shipped | entitlement-decision counts by caller × key from billing-worker (PR #179). **Console surface deferred** (no internal-operator console/auth). |
| B1 | ⛔ Blocked | GitHub OAuth scaffolding landed (task 0129); full magic-link + OAuth needs human creds + verified sender. |
| B6 | ⛔ Blocked | needs Stripe creds + receipts decision; U7 (`precondition_failed` UX) precondition is met. |
| B10 | ⛔ Blocked | sequenced after B1 + B8 stable; needs IdP creds/decisions. |

## Open / deferred

- **Notifications provider swap** — choose Resend / Postmark / SES (adapter seam ready).
- **B9 console surface** — needs an internal-operator console + auth-model decision.
- See `risks-and-open-questions.md` for the full unblock signals.
