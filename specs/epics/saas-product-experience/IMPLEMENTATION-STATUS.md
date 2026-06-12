# Implementation Status — saas-product-experience

As-built record for the PX cluster. Trust code over this doc.

## Summary

Epic opened 2026-06-11 from a verified-live audit.

| ID | Status |
|----|--------|
| PX1 | ✅ Shipped (#299) — verified live on stage (designed 404, confirm dialogs, breadcrumbs) + prod 404 smoke |
| PX2 | ✅ Shipped (#300 + #303 tail + #304 id-addressing fix) — full lifecycle verified live on stage 2026-06-11: setting create/edit, flag create + optimistic toggle, secret create → rotate (v2) → revoke, no secret material leaked; encryption key provisioned for stage AND prod by the deploy lane |
| PX3 | ✅ Shipped (#303 + #304) — verified live on stage 2026-06-11: preference toggle persists across reload via the actor-pinned edge facade; prod smoke: route deployed (401 unauth, designed 404 on console) |
| PX4 | Ready (next) |
| PX5 | Ready |
| PX6 | Ready |

## Convergence note (2026-06-11)

Live PX2 verification exposed that the backend had not converged since the
failed `#280` main-push run (a few real failures cascaded into
dependency-wait timeouts for nearly all worker deploy jobs; CI plans
`--changed`, so subsequent console-only merges never re-deployed the
backend). The PX3 PR re-touches config-worker and notifications-worker and
redeploys api-edge by source change; full-fleet convergence for the other
workers is a named follow-up. config-worker's deploy lane now provisions
`SECRET_ENCRYPTION_KEY` (generate-if-missing via `wrangler secret`),
unblocking the secrets surface.

## Audit record (2026-06-11)

Method: authenticated Playwright walkthrough of `stage.sourceplane.ai`
(fresh user via the stage `DEBUG_DELIVERY` email-code flow → new org
`claude-audit-co` → project `demo-app` → every org surface, plus light-mode and
390px-mobile passes) and direct edge-API probes with the same session.

Confirmed working at bar: login page, org/project creation with toast
feedback, designed empty states across lists, billing page (plan card,
entitlements table, invoices empty state), audit log with real events and
NDJSON export, usage & quota page, Cmd-K palette, mobile bottom-tab layout,
light/dark theming.

Gaps that seeded PX1–PX6:

1. Console Config page is a stub while
   `GET /v1/organizations/:id/config/{settings,feature-flags,secrets}` is live
   and returns well-formed envelopes (PX2).
2. Unknown routes (e.g. a guessed `/settings/billing/plans`) render the
   unbranded Next.js 404 (PX1).
3. Destructive actions use native `confirm()`; org-create dialog can strand on
   a slow path with only a spinner (PX1).
4. Notification preferences dark end to end for want of one edge facade —
   SDK + worker handlers exist (PX3, unparks the `ai/deferred.md` U11 slice).
5. No rename for org/project/environment anywhere in the stack (PX4).
6. New-user first run dead-ends at empty states; no guided path to a first
   API call (PX5).
7. Cmd-K searches actions/pages only, not resources (PX6).
8. Page headers echo `slug-chip + name` redundantly; no persistent breadcrumb
   `<nav>` (PX1).

Performance note for the PERF epic (not PX scope): authenticated first paint
on a cold path was visibly slow during the walkthrough; consistent with the
known rate-limiter/cold-start ladder in `saas-performance/design.md`.
