# saas-product-experience — Implementation Plan (PX1–PX6)

Milestone bodies for the PX cluster. Status markers reflect code reality; trust
code over this doc. Each milestone is one orchestrator task, lands as one PR or
a short implementer-managed sequence, and is verified live on stage before the
epic status flips.

Recommended order: **PX1 → PX2 → PX3 → PX4 → PX5 → PX6.** PX1 first because it
is pure console and de-risks the visual bar for everything after it; PX2/PX3
next because their backends are already live; PX4 unlocks inline-edit patterns
PX5 reuses; PX6 is independent polish that benefits from PX2/PX4 data being
searchable.

## PX1 — Console truth & papercuts pass — Ready

The "zero broken promises" milestone. Console-only; no contract changes.

- **Designed 404 + error pages.** `not-found.tsx` and `error.tsx` (global +
  `(app)` segment) using the design system: scope-aware "back to safety" CTA,
  requestId disclosure on errors. The unbranded Next.js 404 must be
  unreachable.
- **Designed destructive confirms.** Replace every native `confirm()` (member
  remove, key revoke, webhook delete, archive flows) with a design-system
  confirm dialog: consequence sentence, resource name echo, destructive-styled
  action, focus trap + restore.
- **Loading states everywhere.** Every async action button renders its
  in-flight state (`<Button loading>`); no double-submit windows. Org create
  must not strand the dialog (observed live: spinner with no progress feedback
  on a slow cold path).
- **Wayfinding header.** Persistent breadcrumb header (`org / project / page`)
  on every page as a real `<nav>`; fix the duplicated `slug-chip + name` echo
  observed on page headers.
- **Unsaved-changes guard** on dirty forms (account profile, settings forms).
- **Stub honesty.** Any nav destination that renders a placeholder is either
  implemented in this epic (Config → PX2) or removed from nav/palette.

Acceptance: a stage walkthrough finds no native browser chrome (confirm/alert),
no unbranded error surface, no dead nav item, and every mutation button shows
in-flight state. Unit tests for the confirm-dialog and dirty-guard primitives.

## PX2 — Config surface: settings, feature flags, secrets — Ready

The console face of config-worker, whose api-edge facade
(`/v1/organizations/:orgId/config/{settings,feature-flags,secrets}` + project/
environment scopes) is **already live** (probed 2026-06-11, well-formed empty
envelopes). Spec contract: `components/07-config-secrets-flags.md`.

- **Settings editor** per scope (org / project / environment): list, create,
  edit, delete key-value settings with contract-driven forms.
- **Feature flags** per scope: list + create + designed toggle (optimistic,
  Switch primitive), flag description, scope badge.
- **Secrets** per scope: list (names + metadata only), create with reveal-once
  modal (reuse API-key pattern), rotate with confirm, never render stored
  secret material.
- **Scope navigation:** org Config page gains scope tabs or the project/env
  pages gain Config sections — implementer's call; URL stays the source of
  truth.
- SDK already covers config; add only missing CLI verbs if parity requires.

Acceptance: create/edit/toggle/rotate each verified live on stage through the
UI; secrets never appear in list/read responses; empty states designed; the
PX1 "stub honesty" rule is satisfied by this page becoming real.

## PX3 — Notification preferences end to end — Ready

Unparks the deferred U11 slice (`ai/deferred.md` → "Console
notification-preferences surface"). Spec: `components/14-notifications.md`.

- **api-edge facade:** `GET` + `PUT /v1/organizations/:orgId/notifications/preferences`
  routed to notifications-worker with the same org-scoped actor auth as the
  other facades; contracts additive in `@saas/contracts`.
- **Console page:** org-scoped preferences page with optimistic per-category
  toggles (`invitation | billing | security | support | product`), using the
  existing `Switch` primitive; security category surfaces its "always
  delivered" rule if the contract marks it non-suppressible.
- SDK methods exist; CLI gains `notifications preferences get/set` for parity.

Acceptance: toggle on stage persists across reload and is visible via SDK/CLI;
the `ai/deferred.md` entry is removed in the same PR.

## PX4 — Rename/update lifecycle — Ready

Closes the "can't fix a typo" gap. Additive PATCH, full parity.

- **Contracts + workers:** `PATCH /v1/organizations/:orgId` (name),
  `PATCH .../projects/:projectId` (name, description),
  `PATCH .../environments/:envId` (name) — membership-worker and
  projects-worker handlers, deny-by-default authz (owner/admin), domain events
  (`organization.updated`, `project.updated`, `environment.updated`) feeding
  audit. Slugs stay immutable (URL identity); renaming changes display name
  only — if reality demands slug changes, that is a spec proposal, not this
  milestone.
- **Edge + SDK + CLI:** facade routes, idempotency on PATCH, SDK update
  methods, `org update` / `project update` / `environment update` CLI verbs.
- **Console:** inline edit on the settings/general pages (pencil → input →
  save with loading state → toast), dirty-guard from PX1.

Acceptance: rename verified live on stage via UI and CLI; audit log shows the
update events with actor; non-owner gets a designed 403, not a crash.

## PX5 — First-run onboarding: guided path to the first API call — Ready

Vercel-grade first-run. Console-only (reads existing state; no new backend).

- **Getting-started panel** for fresh scopes: a dismissible checklist —
  create org → create project → create environment → create API key → make
  your first API call — with live completion state derived from real data
  (not localStorage flags), each step deep-linking to the existing creation
  flow.
- **First-API-call moment:** copyable `curl` + SDK snippet pre-filled with the
  org id and the just-created key prefix (never the secret post-reveal),
  pointing at the active target (stage/prod) base URL.
- Empty states on projects/environments link into the checklist rather than
  dead-ending.

Acceptance: a brand-new stage user reaches a copyable, working first API call
without leaving the console; checklist state survives reload because it is
derived from real resources; dismiss is persistent per org.

## PX6 — Resource search in Cmd-K — Ready

Extend the palette from actions/pages to **resources**: projects,
environments, members (by name/email), API keys (by label/prefix), webhook
endpoints (by URL) within the active org scope. Debounced SDK reads through
the existing list endpoints (server-side filtering only where the API already
supports it; otherwise client-side over the cached first page), grouped
results, keyboard-first, selecting navigates to the owning page. No new
backend routes; if list endpoints lack needed filters, record the gap as a
spec proposal instead of widening this milestone.

Acceptance: typing a member email or project name in Cmd-K on stage finds and
navigates to it; palette stays responsive (no spinner-locked UI) on cold cache.
