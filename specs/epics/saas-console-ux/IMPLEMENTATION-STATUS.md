# Implementation Status — saas-console-ux

As-built record for the U cluster. Design intent is in `implementation-plan.md` +
`design.md`. Trust code over this doc.

## Summary

**U1–U11 shipped.** The console is App Router on Workers, with a `packages/ui`
design system, URL-driven 3-level scope, Cmd-K, designed empty/skeleton/upgrade
states, dark-mode token theming, and an `@saas/sdk` client. U11 (Task 0127) closed
the Vercel-bar gaps over API-backed surfaces.

| ID | Status |
|----|--------|
| U1–U7, U10 | ✅ Shipped (Task 0082 family + B4) |
| U8 | ✅ Skeletons shipped; optimistic mutations ongoing |
| U9 | ✅ Foundation shipped (white-label kit = follow-up) |
| U11 | ✅ Shipped (Task 0127); **notification-preferences deferred** |

## Active polish (post-U11)

Ongoing incremental PRs (sidebar/mobile drawer, dialog a11y, copy feedback,
spinners, auth-guard hardening, error boundaries). This is why the epic is **In
progress**, not Closed — it is not yet archived.

## Deferred / blocked

- **Notification preferences page** — needs a `/v1/notifications/preferences`
  (GET+PUT) facade on api-edge. Console foundation (the `Switch` primitive +
  org-scoped page pattern) is ready. Keyed by
  `(orgId, subjectKind:"user", subjectId, channel:"email")` → org-scoped route
  `/orgs/:slug/notifications`. (See `ai/deferred.md` + `saas-baseline` risks.)
- **Rename/update of org/project/env** — out until a backend slice adds the routes.
