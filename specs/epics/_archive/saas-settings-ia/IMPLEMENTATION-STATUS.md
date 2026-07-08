# Implementation Status — saas-settings-ia (SI)

As-built record for the **SI** cluster. Design intent is in `design.md` +
`implementation-plan.md`. **Trust code over this doc.**

## Summary

**SI1–SI5 shipped and merged to `main`.** The console IA now mirrors the
`You → Account → Workspace` scope model: settings follow the scope switcher
(three doorways), and members / invitations / roles / access are one **People &
Access** surface. Relabel & regroup only — no tables, no tenancy change,
`org_id` intact. The epic is fully closed and archived.

| ID | Milestone | Status | PR |
|----|-----------|--------|----|
| — | Epic spec (README/design/plan/risks) | ✅ Shipped | #362 |
| SI1 | Re-file mis-scoped settings surfaces | ✅ Shipped | #365 |
| SI2 | Scope doorways (Account settings promoted) | ✅ Shipped | #366 |
| SI3 | People & Access consolidation | ✅ Shipped | #367 |
| SI4 | Roles as a permission-matrix destination | ✅ Shipped | #368 |
| SI5 | Rename personal `/account` → `/you` | ✅ Shipped | #369 |

## What shipped, per milestone

### SI1 — re-file (#365)
- Billing folded into the Account nav group (route `/settings/billing` kept).
- Sessions & devices moved to the personal area (`/account/sessions`, later
  `/you/sessions`); CLI sessions are per-user. Old route redirects.
- The two "Notifications" disambiguated: event-routing group → **"Event
  routing"**; personal link → **"Email notifications"**.

### SI2 — doorways (#366)
- `buildAccountNav` + `isAccountSettingsPath` (`account-nav.ts`) and
  `buildPersonalNav` (`personal-nav.ts`) — pure, tested models.
- The settings rail is scope-aware: Account doorway under `/settings/account*`
  (+ the account-billed `/settings/billing`) with a Workspace back-link;
  Workspace rail elsewhere with an Account-settings doorway link.
- Entry points: desktop sidebar org-switcher + mobile scope-switcher crumb gain
  "Workspace settings" / "Account settings"; the identity chip gains "Sessions &
  devices". Account pages keep their URLs.

### SI3 — People & Access (#367)
- One tabbed surface `/settings/people` (`?tab=members|pending|access`) built
  from a pure `people-tabs` model; reusable `MembersPanel` / `InvitationsPanel` /
  `AccessPanel`.
- **Inline role editing** on Members wires the shipped `updateMemberRole`
  (deny-safe). Invitations became the Pending tab; Access keeps its
  direct/via-team/account-cascade provenance. Legacy routes redirect.

### SI4 — Roles (#368)
- A "Roles" tab: `ROLE_CATALOG` + `CAPABILITY_AREAS` + `ROLE_MATRIX` (role ×
  area → full/partial/none), rendered as a matrix + per-role summaries. Product
  labels (`builder` → **Developer**). The custom-roles (TG) seam.

### SI5 — rename (#369)
- Personal area `/account/*` → `/you/*` (Profile, Security, Sessions); old paths
  redirect. Every entry point + Cmd-K + `isLinkActive` updated. "Account" now
  means only the tenant scope.

## Deviations from the design (honest as-built)

- **SI1 — personal notification preferences stayed workspace-scoped.** The
  design proposed moving them to the global personal area, but in code they are
  per-`(user, org)` (`getPreferences({ orgId })` needs an org), so they cannot
  live at a global `/you` route. SI1 disambiguated them by label ("Email
  notifications") and left them under workspace settings. A genuinely personal
  notification home depends on the PX3/B2 backend and is deferred.
- **SI3 — provenance is the Access tab, not a Members column.** The design
  sketched a provenance column on the Members roster. The effective-access
  provenance (`direct` / `via team` / `account-cascade`) is already delivered
  comprehensively on the **Access** tab (from `listEffectivePermissions`), so
  Members stays focused on roster + inline role edit + remove. No new backend
  join was introduced.
- **SI3 — Teams stayed its own surface.** Per risks Q3, the first-class
  `/orgs/:slug/teams` product surface (account-scoped) was kept rather than
  forced into a workspace People tab; People & Access is Members/Pending/Roles/
  Access. Teams is reachable from the Account doorway.
- **SI4 — Roles is a display mirror, not a live facade.** Per risks Q2, the
  matrix mirrors `tenancy-and-rbac.md` in the console rather than reading a new
  `GET /roles` endpoint. The authoritative per-action catalog remains
  `packages/policy-engine`; promote to a facade when custom roles (TG) make the
  catalog dynamic.

## Verification notes

- Every milestone was verified with `web-console-next` **typecheck + lint** and
  the **Jest suite** (grew 482 → 502 as new pure-model specs landed), plus a
  local `next build` for the milestones that added/renamed routes (SI3–SI5).
- CI's `web-console-next · {dev,stage,prod} · Verify deploy` jobs are slow and
  frequently non-terminating in this environment; they are **not required
  checks** (merges succeeded with them pending). The reliable gates are `plan` +
  `web-console-next-tests`, both green on every milestone.

## Follow-ups (out of scope, tracked elsewhere)

- Personal notification-preferences home once PX3/B2 lands.
- The `teams-hub` (TH) Account Hub pages drop into the SI2 Account doorway.
- Custom roles + team-scoped grants (`teams-governance` TG) extend the SI4
  Roles seam.
