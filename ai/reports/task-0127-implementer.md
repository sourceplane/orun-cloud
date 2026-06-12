# Task 0127 — U11 Vercel-standard console completion — Implementer Report

Milestone `U11-console-vercel-standard`. Delivered as a sequence of reviewable
PRs (per the task's suggested split). This report is updated per slice.

## Verification environment

Browser verification runs against the **live stage** `api-edge`
(`https://api-edge-stage.rahulvarghesepullely.workers.dev`) using a real
magic-link token (stage returns `local_debug` codes) pasted via the console's
bearer-token path. A throwaway org `U11 Verify Co` (`u11-verify`) was seeded for
verification. Playwright (chromium) drives `next dev` on `:3001`.

Two environment notes (not product bugs):
- Chromium rejects the workers.dev cert in this sandbox
  (`ERR_CERT_AUTHORITY_INVALID`, TLS interception) → Playwright contexts use
  `ignoreHTTPSErrors`.
- Project creation on the seeded org returns `412 precondition_failed /
  not_configured` (entitlement gate), so project/environment-scoped data is
  verified against the designed empty/upgrade states rather than live rows.

Pre-existing latent bug noted (not in this task's scope): `useRequireAuth`
redirects to `/login` on a hard load of a deep link before `SessionProvider`
hydrates the token from `localStorage` (child effects fire before the parent's).
Real users don't hit it (post-login navigation is client-side). Flagged for a
future polish slice.

---

## Slice A — design-system primitives + mobile nav + extensible Cmd-K registry

PR: `claude/u11-a-primitives`.

### What shipped
- **New primitives** (`apps/web-console-next/src/components/ui/`):
  - `select.tsx`, `tooltip.tsx` — Radix-backed (deps `@radix-ui/react-select` /
    `react-tooltip` were already present; no lockfile change).
  - `sheet.tsx` — slide-out panel on Radix Dialog (no new dep).
  - `switch.tsx`, `checkbox.tsx` — dependency-free, accessible
    (`role="switch"`/`"checkbox"`, `aria-checked`, keyboard) to avoid a new
    Radix dep + React-19-RC peer churn. **Decision:** Popover was *not* added —
    the named U11 surfaces are covered by Select + DropdownMenu + Tooltip, and
    the task forbids dead primitives.
  - `TooltipProvider` mounted once in `app/providers.tsx`.
- **Extensible Cmd-K registry** — `command-registry.ts` (pure, testable) builds
  scope-aware command descriptors; `command-palette.tsx` resolves icons, runs
  effects, and exposes `useRegisterCommands(...)` so each product area / slice
  contributes commands without editing the palette. Behavior parity with the
  old hardcoded palette, plus a visually-hidden `DialogTitle`/`DialogDescription`
  (fixes the Radix a11y warning the old palette emitted).
- **Shared nav model** — `nav-items.ts` (pure, testable) drives both the desktop
  `Sidebar` and the new mobile drawer; `sidebar.tsx` exports `NavContent`.
- **Mobile navigation** — `mobile-nav.tsx`: a hamburger in the topbar (md:hidden)
  opens the sidebar in a left `Sheet`, closing on navigation. Fixes the dead-end
  where the sidebar was `hidden md:flex` with no small-screen replacement.

To keep every PR independently non-broken on `main`, the nav/registry in this
slice link only to **routes that already exist**. Usage, account-profile,
notification-preferences, and org-settings entries are added by their own slices
alongside the routes they point at.

### Tests
- `tests/web-console-next/src/command-registry.test.ts` (scope-gating, compose
  override, stable group ordering, empty-group drop).
- `tests/web-console-next/src/nav-items.test.ts` (section gating, active-link
  longest-prefix matching incl. `/orgs` and `/account` exact-match cases).
- Full suite: **104 passing** (21 new).

### Gates
- `web-console-next` typecheck ✓, lint ✓; tests typecheck ✓, lint ✓.
- `next build` ✓ (all routes compile).
- Browser: login page, orgs list, global + org-scoped command palette
  (registry-driven, correct scope gating), desktop sidebar, and the mobile Sheet
  drawer all render correctly with **zero console errors**.

Merged: PR #204 (squash `d165578`).

---

## Slice B — Usage & quota surface

PR: `claude/u11-b-usage`.

### What shipped
- **New route** `app/(app)/orgs/[orgSlug]/usage/page.tsx` (org-scoped via
  `OrgScope`), with two sections:
  - **Consumption** — metric input (with `datalist` suggestions; no
    list-metrics API exists), `bucketType` + range `Select`s, over
    `metering.getUsageSummary`. Totals + a dependency-free CSS bar chart of
    per-bucket quantity. Prompts to choose a metric before fetching (metric is
    a required API param), and shows a designed empty state when no usage was
    recorded.
  - **Quota violations** — over `metering.listQuotaViolations` with an optional
    metric filter and cursor "Load more"; open/resolved + enforcement badges,
    overage %. Loads immediately (no metric required).
- **Nav + Cmd-K** — added the "Usage & quota" sidebar link and `nav.usage`
  command alongside the route (so the entries that were intentionally deferred
  in Slice A now point at a real page).
- Pure helper `components/usage/usage.ts`: preset→ISO window math (injectable
  `now`), bar normalization, compact number formatting, violations pagination
  accumulation, and view shapers.

### Tests & gates
- `usage.test.ts` (17 cases: query window math, bar normalization incl.
  divide-by-zero guard, compact formatting, violations append/de-dupe/cursor,
  overage guard). Full suite **121 passing**.
- typecheck ✓, lint ✓, `next build` ✓.
- Browser: Consumption + Quota-violations render; Select primitives work; a
  metric query resolves to the designed "No usage recorded" / "No quota
  violations" empty states against live stage; **zero console errors**.

Merged: PR #205 (squash `edd1308`).

---

## Slice C — Account profile, org settings, optimistic archive

PR: `claude/u11-c-account-settings`. (Final slice; combines the planned C + D
to reduce CI cycles.)

### Code-reality correction (important)
The planned **notification-preferences** surface was **dropped from the
console**: although `@saas/sdk` exposes `notifications.getPreferences/
updatePreferences`, **api-edge has no notifications facade** — the facade set is
audit, auth, billing, config, metering, org, project, webhooks (verified in
`apps/api-edge/src/*-facade.ts`; a live `GET /v1/notifications/preferences`
returns `not_found`). The console may only consume api-edge, so shipping that
page would be a broken (404) feature. It is recorded as backend-blocked in
`ai/deferred.md` and the roadmap U11 entry; the dependency-free `Switch`
primitive from Slice A is retained for when the edge facade lands.

### What shipped
- **Account profile** `app/(app)/account/page.tsx` over `auth.getProfile/
  updateProfile/logout`: editable display name (dirty-gated Save, discard),
  read-only email, user id, avatar initials, and an explicit **Sign out**. A
  shared `AccountTabs` (Profile / Security activity) sub-nav added to both
  account routes. Pure helper `components/account/profile.ts`.
- **Org settings** `app/(app)/orgs/[orgSlug]/settings/page.tsx`: read-only
  name/slug/id (copy buttons) with an honest "renaming isn't available from the
  console yet" note (no org `update` API), and a **Danger zone** whose delete is
  a disabled, tooltip-explained "handled by support" control (no org `delete`
  API — does not fake an action).
- **Optimistic archive** on the projects and environments lists: a shared
  `ArchiveMenu` (⋯ → confirm dialog) + `components/settings/archive.ts`; the
  parent removes the row optimistically and rolls back on error. Uses the
  existing `projects.archive` / `environments.archive`.
- **Nav + Cmd-K**: Profile (account section), org Settings, and `nav.account` /
  `nav.org-settings` commands added alongside their routes.

### Tests & gates
- `profile.test.ts`, `archive.test.ts` (+ Slice-A/B suites). Full suite
  **135 passing**.
- typecheck ✓, lint ✓, `next build` ✓.
- Browser (live stage): account profile loads, **a display-name edit persists to
  the backend** (confirmed via `GET /v1/auth/profile`), sign-out present; org
  settings renders metadata + danger zone; sidebar shows Profile + Settings and
  correctly omits Notifications; **zero console errors**. Project/environment
  archive is code-complete + unit-tested but not browser-verified end-to-end —
  the verification org's entitlement gate blocks project creation
  (`precondition_failed / not_configured`), so there were no projects/envs to
  archive; the optimistic logic and confirm UI are covered by unit tests and
  render correctly.

## U11 outcome
Shipped: U2 primitive completion (Select/Tooltip/Sheet + Switch/Checkbox),
mobile nav, extensible Cmd-K (Slice A); usage & quota (Slice B); account profile
+ org/project settings + optimistic archive (Slice C). Deferred (backend-blocked,
not a console gap): notification preferences, pending an api-edge notifications
facade. Rename/update of org/project/env remains out (no API), as scoped.
