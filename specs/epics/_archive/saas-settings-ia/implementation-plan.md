# saas-settings-ia (SI) — Implementation Plan

Status: Draft. Milestones are independently shippable; SI1 lands value with zero
new screens. Sequence: **SI1 → SI2 → SI3 → SI4 → SI5**, though SI4 and SI5 can
trail. Each milestone is a console-only PR unless noted.

Ground rules honored: URL is the source of truth for scope; the console consumes
`apps/api-edge` only; nav composition stays in dependency-free, unit-tested pure
models (`settings-nav.ts` shape); every moved route ships a `redirect()` shim so
nothing 404s.

---

## SI1 — Re-file the four mis-scoped surfaces

Regroup the nav so each surface sits at the scope it actually belongs to. No page
is rewritten; pages move by reference + redirect.

**Work**
- In `settings-nav.ts`: remove the `billing` group and the `account` group from
  `buildSettingsNav`; move `cli-sessions` and the personal `notifications`
  (email prefs) link out of the Workspace/Developer groups; keep the
  event-routing `notifications/{rules,channels,dead-letters}` group at workspace
  scope; drop the orphaned `config` reference.
- Add redirect stubs: `settings/billing → …/account/billing`,
  `settings/cli-sessions → /you/sessions`, `settings/notifications →
  /you/notifications`, `settings/config → secrets`.
- Update `settings-nav` unit tests to the new group set.

**Done when**
- `buildSettingsNav` contains only genuinely workspace-scoped groups.
- Billing, personal Sessions, and personal Notifications no longer appear under a
  Workspace-scoped group; their old routes 301/redirect to the new homes.
- No screen component was rewritten; nav tests pass; no api-edge change.

---

## SI2 — Scope doorways: settings follow the switcher

Give You / Account / Workspace three distinct settings homes selected by the
switcher, and lift the Account hub out of the child workspace.

**Work**
- Add `account-nav.ts` (`buildAccountNav(orgSlug)`) and a `buildPersonalNav()`
  model (replacing `account-tabs.tsx`), both returning the `SettingsNavGroup`
  shape so `settings/layout.tsx` renders them unchanged.
- Route: introduce `/orgs/:slug/account/*` hosting the lifted `settings/account/*`
  pages (and the **TH1** Account Hub pages where they exist); `settings/account/*`
  redirects up. Rename the personal area to `/you/*` (see SI5) hosting the
  Profile/Security pages + the SI1 arrivals (Sessions, Notification prefs) +
  "Invitations received".
- Wire entry points: the switcher's Account row gains a ⚙ affordance to the
  Account doorway (gated on `workspaceKindBadge` / `org.kind`); the identity chip
  gains "Your settings"; the `org-manage` Settings entry opens the Workspace
  doorway.

**Done when**
- From an Account-kind org the switcher opens Account settings; from a Workspace
  it opens Workspace settings; personal settings are reachable from the identity
  chip independent of any org.
- `settings/account/*` and `/account/*` redirect to the new doorways.
- Coordinated with `teams-hub` TH1 (shared Account surface); no tenancy change.

---

## SI3 — People & Access: one tabbed surface per scope

Collapse Members + Invitations + Access into `…/people` with tabs (Members ·
Pending · Teams · Roles · Access), at both Workspace and Account scope.

**Work**
- Build the `PeopleAndAccess` surface (tabs via the shipped `Tabs` primitive);
  route `…/people` + `…/account/people`, `?tab=` deep-linkable.
- **Members**: add inline role editing bound to `PATCH …/members/:id`
  (optimistic per U8, deny-safe on 403); add the provenance column
  (`direct` / `via team` / `account-cascaded`) from the membership facts
  `listEffectivePermissions` already returns.
- **Pending**: host the existing invitations list + "Add people" invite dialog;
  redirect `settings/invitations`, `settings/members`, `settings/access` →
  `…/people(?tab=…)`.
- **Teams**: at account scope render the TF team roster (→ Team Page); at
  workspace scope render teams **granted** here.

**Done when**
- One People & Access entry per scope replaces the Members/Invitations/Access
  items; invite + member management happen on one surface.
- Inline role edit works and is audited (server already emits
  `membership.updated`); provenance is shown; legacy routes redirect.

---

## SI4 — Roles as a destination

Render a role × permission matrix from the shipped policy-engine catalogs.

**Work**
- Read `ORG_ROLE_PERMISSIONS` / `ACCOUNT_ROLE_PERMISSIONS` /
  `PROJECT_ROLE_PERMISSIONS` via a static contract mirror in `packages/contracts`
  (or a thin `GET …/roles` read facade on api-edge) — never a direct engine
  import from the console.
- Render the **Roles** tab per scope with product labels (`builder` →
  **Developer**); mark it the extension seam for custom roles (**TG**).

**Done when**
- The Roles tab lists each role and its capability set, per scope, read-only.
- Labels match `tenancy-and-rbac.md` product names; console still consumes
  api-edge/contracts only.

---

## SI5 — Naming & copy cleanup

End the "account" word-collision and make scope framing consistent.

**Work**
- Rename personal `/account` → `/you` (+ `/account/security` → `/you/security`);
  redirect the old paths; update `isLinkActive`'s `/account` special-case.
- Copy pass: page titles/descriptions consistently name their scope ("Workspace
  settings", "Account settings", "Your settings"); no surface uses "account" for
  both the person and the tenant.
- Register Cmd-K actions: "Your settings", "Account settings", "Workspace
  settings", "Switch account".

**Done when**
- No surface calls the person and the tenant both "account".
- `/account*` redirects to `/you*`; Cmd-K actions resolve; copy is scope-consistent.

---

## Verification

- **Unit**: nav models (`buildSettingsNav`, `buildAccountNav`, `buildPersonalNav`,
  `isSettingsLinkActive`) — group membership, active-state, and no-dead-link
  assertions.
- **Redirects**: a table test that every legacy route in `design.md` §5 resolves
  to its new home (no 404).
- **E2E (Playwright, pre-installed Chromium)**: invite → appears in Pending →
  accept → graduates to Members; inline role change persists and re-renders;
  switcher Account chip opens Account settings, Workspace chip opens Workspace
  settings, identity chip opens Your settings.
- **A11y**: tab list is keyboard-navigable; focus-visible on the new controls
  (U-track baseline).
