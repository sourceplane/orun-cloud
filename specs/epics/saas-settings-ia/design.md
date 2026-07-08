# saas-settings-ia (SI) — Design

Status: Draft. Written against repo reality as of 2026-07-08.

This epic is **information architecture**, not new capability. Every backend fact
it needs is already shipped; the work is in the console shell's navigation models
and route tree. Where a symbol is named below it exists in the tree today unless
marked *(new)*.

## 0. Code reality it builds on

- **Settings nav model** — `apps/web-console-next/src/components/shell/settings-nav.ts`:
  `buildSettingsNav(orgSlug)` returns five `SettingsNavGroup`s — `organization`
  (labelled "Workspace"), `account`, `billing`, `notifications`, `developer` —
  plus `flattenSettingsNav` and `isSettingsLinkActive`. Rendered by
  `settings/layout.tsx` (rail on desktop, pill bar on mobile).
- **Sidebar nav model** — `nav-items.ts`: `buildNavSections(scope)` +
  `isLinkActive`. Product surfaces on top, a pinned `org-manage` footer with
  Usage + a `subPanel` Settings entry. `isLinkActive` already special-cases the
  personal `/account` route.
- **Scope switcher** — `scope-switcher.tsx` (`ScopeSwitcher`): URL-driven,
  reads `orgSlug/projectSlug/envSlug`, lists orgs via
  `client.organizations.list()`. It is the single control that expresses scope.
- **Account/Workspace badge** — `workspace-kind.ts`: `workspaceKindBadge(org)`
  returns `"Account" | "Workspace" | null` from the server-derived `org.kind`
  / `org.isAccountRoot` (WID4/WID5); `accountNameFor(org, allOrgs)` resolves a
  child's account name client-side from `accountId`/`workspaceRef`.
- **Personal area** — routes `/(app)/account/page.tsx` (Profile) and
  `/(app)/account/security/page.tsx` (Security activity), tabbed by
  `components/account/account-tabs.tsx`. Actor-scoped, no org in the URL.
- **Account hub (nested)** — `settings/account/{page,workspaces/,members/,roles/}`.
  `list-account-members` + WID6 `grant-account-role` back these.
- **Teams** — first-class product surface at `/orgs/:slug/teams` +
  `teams/[teamId]`; the `settings/teams*` routes are legacy redirects into it.
- **RBAC catalogs** — `packages/policy-engine/src/index.ts`:
  `ORG_ROLE_PERMISSIONS`, `PROJECT_ROLE_PERMISSIONS`, `ACCOUNT_ROLE_PERMISSIONS`;
  `authorize()`, `listEffectivePermissions()` (powers the Access page),
  `validateRoleAssignment()`. Account-scoped grants are remapped onto the target
  org so they cascade; team grants expand into actor facts (TM3).
- **Member management API** — `apps/membership-worker/src/router.ts`:
  `GET/PATCH/DELETE …/members[/:id]` (`list-members`, `update-member-role`,
  `remove-member`); invitations at `…/invitations` + `/v1/me/invitations`. The
  `PATCH` role edit is **shipped but unused by the UI**.

## 1. The model the IA must mirror

```
You (actor) ─ orthogonal ─┐
                          │
        Account ──────────┴──────────  tenant · billing · governance  (parent_org_id ?? id)
          ├── Workspace  (org)  ── Project ── Environment
          ├── Workspace  (org)  ── Project ── Environment
          └── Team  (account-owned principal; spans every workspace; a group, not a level)
```

Three scopes carry settings: **You** (the human, constant across every
account/workspace), **Account** (the tenant/billing/governance boundary), and
**Workspace** (the operational org). `Project`/`Environment` are work units, not
settings scopes. `Team` is a principal, surfaced under Account.

## 2. Three doorways (SI2) — settings follow the switcher

The rule: **settings apply to whatever the switcher is pointed at, plus a
constant personal home on the identity chip.** One mental model instead of one
`/settings` bucket that mixes scopes.

| Doorway | Entry point | Scope | Route base |
|---------|-------------|-------|------------|
| **You** | identity chip (bottom of sidebar) → "Your settings" | actor | `/you/*` *(renamed from `/account/*`, SI5)* |
| **Account** | switcher · Account chip → ⚙ (or the Account badge) | tenant | `/orgs/:slug/account/*` (lifts `settings/account/*`) |
| **Workspace** | switcher · Workspace chip → ⚙ / the `org-manage` Settings entry | org | `/orgs/:slug/settings/*` |

`workspaceKindBadge` already tells the switcher whether the current org is an
Account root or a Workspace; SI2 wires that badge to the correct settings
doorway. When the current org **is** the account root, the Account and Workspace
doorways address the same org id (correct — a root org is both), differing only
in which nav model renders.

### Nav-model changes

- **`buildSettingsNav`** loses the `account` group (moves to the Account
  doorway) and the mis-scoped links (SI1). It keeps only genuinely
  workspace-scoped groups: General, People & Access, Integrations, Notifications
  (event routing), Developer (API keys, Webhooks, Audit).
- **`buildAccountNav(orgSlug)`** *(new, `account-nav.ts`)* — Overview,
  Workspaces, People & Access, Billing & plan, Usage, Security & governance.
  Same `SettingsNavGroup` shape so `settings/layout.tsx` renders it unchanged.
- **`buildPersonalNav()`** *(new)* — Profile, Security, Sessions & devices,
  Notification preferences, Invitations received. Replaces the two-item
  `account-tabs.tsx`.
- **`buildNavSections`** — the `org-manage` footer Settings entry stays for the
  Workspace doorway; the identity chip renderer gains a "Your settings" item; the
  switcher's Account row gains an ⚙ affordance to the Account doorway.

## 3. People & Access (SI3) — one surface, five tabs

Members, Invitations, and Access collapse into a single route `…/people` per
scope, with tabs. This is the consolidation the epic centers on.

| Tab | Workspace scope | Account scope | Backed by |
|-----|-----------------|---------------|-----------|
| **Members** | workspace roster + inline role edit + provenance | account-member derived roster (WID6 holders ∪ root members) | `list-members` / `update-member-role`; `list-account-members` |
| **Pending** | pending workspace invites + "Add people" | pending account-level invites | `…/invitations` |
| **Teams** | teams **granted** here (read) | the team roster (TF entities, `@handle`) → Team Page | teams API (TM/TF) |
| **Roles** | workspace role matrix (SI4) | account role matrix (SI4) | policy-engine catalogs |
| **Access** | effective-access viewer | account effective-access | `listEffectivePermissions` |

Three concrete upgrades land here:

1. **Inline role editing** — the `Members` tab wires the shipped `PATCH
   …/members/:id` role change (a `Select` per row), closing the "API supports it,
   UI only removes" gap. Optimistic per U8, deny-safe on 403.
2. **Invitations become Pending** — one "Add people" action opens the invite
   dialog; an accepted invite graduates from the Pending tab to a Members row.
   `settings/invitations` and `settings/members` both redirect to
   `…/people(?tab=pending)`.
3. **Provenance column** — each member row shows how they got access —
   `direct`, `via team <name>`, or `account-cascaded` — derived from the same
   membership facts `listEffectivePermissions` already assembles. This finally
   surfaces the account-cascade admins who appear in **no** workspace member list
   today (the legibility gap TF4's provenance also names).

## 4. Roles as a destination (SI4)

Today "roles" is only a dropdown value. SI4 renders a **permission matrix** — role
× capability — read straight from the shipped catalogs (`ORG_ROLE_PERMISSIONS`,
`ACCOUNT_ROLE_PERMISSIONS`, `PROJECT_ROLE_PERMISSIONS`). Product labels apply
(`builder` → **Developer**, per `tenancy-and-rbac.md`). Read-only first; it is the
seam **custom roles** (teams-governance **TG**) plug into later. No engine change;
the matrix reads a static contract mirror of the catalogs (or a thin
`GET …/roles` read facade) so the console keeps consuming api-edge only.

## 5. The re-filing map (SI1)

Pure nav + redirect; no screen is rewritten. Every legacy route keeps working via
a `redirect()` shim (the codebase already uses this pattern for the old
top-level `members`/`invitations`/`webhooks`/`audit`/`teams` routes).

| Today | → | New home | Why |
|-------|---|----------|-----|
| `settings/billing` (+ `change-plan`) | → | Account · `…/account/billing` | Bills at `effectiveBillingOrgId` (the account) |
| `settings/cli-sessions` | → | You · `/you/sessions` | The human's CLI logins, not the org's |
| `settings/notifications` (email prefs) | → | You · `/you/notifications` | Personal `subjectKind='user'` prefs |
| `settings/notifications/{rules,channels,dead-letters}` | → | Workspace · `settings/notifications` | Org **event routing** keeps its home |
| `settings/account/*` | → | Account · `…/account/*` | Un-nest the parent from its child |
| `settings/members` · `settings/invitations` · `settings/access` | → | Workspace · `…/people(?tab=…)` | People & Access consolidation (SI3) |
| `teams` · `teams/[id]` | → | Account · `…/account/people?tab=teams` (+ Team Page) | Teams are account-owned principals |
| `/account` · `/account/security` | → | `/you` · `/you/security` | End the tenant/person "account" collision (SI5) |
| `settings/config` (orphan) | → | Workspace · `secrets` | Already folded to Secrets; remove the dead nav link |

## 6. Alternatives considered

- **A per-scope duplicated "Settings" tab** — rejected. Three parallel tabs
  invite drift and force the user to know which one they're in. A single routing
  rule keyed on the switcher (D2) is fewer moving parts and self-consistent.
- **Make `accounts` a first-class entity to justify the Account doorway** —
  rejected; that is WID Stage 2 and a tenancy change. The doorway is a *surface*
  over the existing `parent_org_id` reference (same stance as **TH**).
- **Keep Invitations as its own page** — rejected. It doubles the trip for the
  most common admin task ("add someone") and diverges from every modern peer.
- **A new members/roles backend** — rejected and unnecessary; `update-member-role`,
  `list-account-members`, and `listEffectivePermissions` already back every SI
  interaction. SI adds console IA, not domain surface.

## 7. Extraction seam

SI touches only `apps/web-console-next` shell + routes (and an optional read-only
roles facade). It invents no field or workflow absent from the public API
(`components/12-web-console.md` acceptance criterion). The console stays a
replaceable client of the platform; nothing here changes a domain contract.
