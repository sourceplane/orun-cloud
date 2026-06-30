# saas-integration-tenancy — Risks & Open Questions

Live register of the architecture/product decisions for the epic. IT1 (the
dormant resolution seam) is safe to build now; the live multi-org paths (IT2+) are
gated on `saas-integrations` IG1/IG2/IG4 landing and on the open product decisions
below. Defaults are chosen to be least-surprising and reversible; **do not
silently flip a default without recording it here**. The two capabilities the first
draft left implicit — **workspace-private connections** and **parent admission
control / share mode** — are now scoped, decided with back-compatible defaults
(A5/A6), and designed in `design.md` §10–§11; their finer knobs stay open as D5.

## ⛔ Still open — product decision (do NOT auto-pick the non-default)

| # | Decision | Default | Notes |
|---|----------|---------|-------|
| D1 | **Sibling isolation: soft vs hard** | **Soft** (recommended) | Soft: workspaces under one account share the connection; what each sees is scoped by repo-link ownership + project/policy, mirroring how children already share a billing customer and pooled usage. Hard: a workspace's repos/events must be invisible to sibling workspaces even within the account — re-introduces per-workspace claim walls and stricter fan-out, and partially negates the easing this epic buys. Build hard **only** on explicit customer demand. |
| D7 | **Granted-mode visibility of inherited connections** (ITX, IT10) | **Hide** (recommended) | Under `share_mode = 'granted'`, does a *non-admitted* child see the account's shared connection? **Hide**: it appears only once admitted (cleanest, least confusing). **Show-as-requestable**: greyed "available on request" with a request affordance (discoverable, but adds a request/approve loop not yet designed). Hide by default; revisit if customers want self-serve discovery. Under `auto` all children see it regardless. |

## ⛔ Still open — lifecycle behavior (pick before IT6)

| # | Decision | Options | Leaning |
|---|----------|---------|---------|
| D2 | **Detach** (`clear parent_org_id`) effect on the workspace's repo links against the account connection | (a) **revoke** the workspace's active links on detach; (b) **block** detach while active links exist (force unlink first) | (b) block-then-unlink — least destructive, symmetric with billing's reversible detach; surface the blocker in the console. |

**Wiring status (IT6b):** the integrations-side data primitive is shipped and
tested — `IntegrationsRepository.countActiveSharedRepoLinks(orgId)` returns the
count of a workspace's active links against a connection it does not own (an
account-shared connection); it is zero for every standalone org. The detach
*guard itself* cannot be wired yet: **the platform has no detach operation** —
`membership.organizations.parent_org_id` is only ever *set* (at org creation /
`sync-account-children`), never cleared, so there is no clear-parent flow to gate.
When `saas-multi-org-billing` (or membership) introduces detach, the guard is a
one-call check against this primitive, gated by the D2 decision above. Until then
D2 stays open and the guard is intentionally unbuilt (no detach ⇒ nothing to
block).
| D5 | **Grant granularity & scope-change** (IT8/IT7 follow-ups) | (a) admission grant is whole-connection only vs per-repo; (b) whether an existing connection may **change scope** (account↔workspace) as an explicit audited op, or scope is fixed at connect time | (a) **whole-connection grant** first — per-repo admission is repo-link ownership's job already; add per-repo only on demand. (b) **scope fixed at connect** for v1 — a scope change is a disconnect+reconnect; revisit if customers hit it. |

## ✅ Decisions made

| # | Decision | Resolution |
|---|----------|------------|
| A1 | Integration tenant boundary | **The parent (account) org**, via `effectiveIntegrationOrg(org) = parentOrgId ?? org.id` — twin of `effectiveBillingOrg`. |
| A2 | Credential direction | **Resolve up, never fan out.** One connection per installation, owned by the account; entitlements still fan down (MO3, unchanged). |
| A3 | Keystone | **Preserved.** `installation_id` stays globally `UNIQUE`; no constraint relaxed. |
| A4 | Authorization model | **Resolution, not hierarchical RBAC.** Exact-match policy (`scope.orgId === orgId`) is untouched; only integration *resource addressing* resolves to the account, gated by the workspace's own repo-link ownership. |
| A5 | **Connection ownership scope** (workspace-private integrations, IT7) | A connection carries `scope ∈ {account, workspace}`, default `account`. The seam resolves **up only for `account` scope**; a `workspace`-scoped (private) connection is owned at the workspace and never resolved — it reuses the pre-tenancy single-org paths. Scope is set by the connect surface (account vs workspace Integrations page). Keystone unchanged: a given GitHub account still backs exactly one connection of either scope. Answers *"can a workspace bring its own integration?"* — **yes**. |
| A6 | **Share mode + admission** (parent governance, IT8) | Account-shared connections carry `share_mode ∈ {auto, granted}`, default **`auto`** (= today's soft, ungoverned sharing — back-compatible). `granted` requires an active row in `integrations.connection_grants (connection_id, org_id)`. Admission is a **resolution-layer allow-list**, stacked *before* repo-link ownership at link-create/broker/projection — **not** hierarchical RBAC (A4 holds). Orthogonal to D1 (admission = *who may consume*; D1 = *what siblings see*); all four combinations are schema-supported. Answers *"can the account govern who shares?"* — **yes**. |
| A7 | **Sharing is account-only; inherited visibility is read-only** (ITX, IT9–IT12) — *reconciled with `saas-workspace-id` (WID), 2026-06-30* | Identity is **WID4's**, not home-grown: `kind`/`isAccountRoot`/`accountId`/`workspaceRef` are already projected on `PublicOrganization` (consumed, not derived here). Account-only sharing has **two distinct gates**: (1) a **structural** gate — only an **Account root** (`isAccountRoot`) may *own* an `account`-scoped connection; a child connect is forced to `workspace` scope; (2) a **permission** gate — *managing* `share_mode`/grants requires a **WID6 account-scoped role** (`account_admin`/`account_owner` at `scope_kind='account'`, cascading). This **refines A4**: the *consumption* path (workspace mints via repo-link ownership + admission) stays pure resolution (A4 holds); *governance* rides on account RBAC (WID6), the platform's primitive for "manage across all your workspaces." A grant is still an allow-list row, not a role — the account role only gates *who edits the list*. A child **sees** the account's `account`-scoped connection **read-only**, attributed *"Shared by «Account» (`ws_…`)"* (soft-visibility default D1 made concrete); it never gains write, siblings' links stay invisible. **Depends on WID4 (#246) + WID6 (#248), both shipped.** |

## Security / correctness risks

| Risk | Mitigation |
|------|------------|
| **Cross-workspace token leak** if the broker ever returns a full-installation token | "Never mint unscoped" becomes a hard invariant with tests (IT4); scope-down (`repository_ids` + permissions subset) is already enforced by GitHub. The blast radius of a regression rises from intra-org to intra-account — hence the dedicated suite. |
| **Repo double-claim** under a shared connection (two workspaces both receive a repo's events/tokens) | Single-claim partial unique `uq_integrations_repo_claim (connection_id, repo_external_id)` (IT2); attribution resolves ≤1 active link (IT3). |
| **Split-brain tenancy** — some handlers address the connection at the account, others at the raw workspace org | The IT6 invariant suite asserts every read/write resolves through `effectiveIntegrationOrg`; mirror billing's discipline of routing *all* reads through one seam. |
| **Uninstall blast radius** — a parent-side uninstall removes GitHub for every workspace | Disclosed in the console danger-zone + connection detail; reconciled through the existing lifecycle path with per-org audit. |
| **Unsolicited / orphaned installs** unchanged | Still recorded as orphaned and surfaced to admin-worker; never auto-bound (fail closed, `saas-integrations` §4). |
| **Mis-scoped resolution** — a handler resolves a `workspace`-private connection up to the account (leaking a private integration), or fails to resolve an `account`-shared one (misrouting) | The IT6 split-brain suite is **scope-aware**: it asserts shared connections always resolve through `effectiveIntegrationOrg` and private ones never do (design §2/§9, IT7). |
| **Admission bypass** — a non-admitted workspace claims a repo / mints a token / receives events under `granted` mode | The admission gate is enforced **before** repo-link ownership at all three touchpoints (link-create, broker, projection) and fails closed; grants may only name a child of the owning account; mid-flight revocation block-then-unlinks (design §8/§11, IT8). |
| **Keystone-collision dead-end** — a workspace tries to privately connect a GitHub account the account already holds (or vice-versa) | The UNIQUE keystone refuses (correct), but the console reads the existing connection's scope and returns a **helpful redirect** ("already connected at the account; link from your Git tab"), not the bare "Already connected" (design §10, IT7). |

## Dependencies

| Dependency | State | Notes |
|------------|-------|-------|
| `saas-multi-org-billing` MO1 (`parent_org_id`, `effectiveBillingOrgId`) | ✅ Shipped | The substrate this epic mirrors. |
| `saas-integrations` IG1 (connect), IG2 (inbound), IG4 (token broker) | 🗓️ Planned | The live mechanics this epic re-points; IT2+ cannot land before them. |
| GitHub App registered per env | Human-gated | Same gate as `saas-integrations` D1/D2. |

## Non-blocking notes

- **No live-data migration risk:** every existing org is standalone
  (`parent_org_id NULL`) and resolves to itself; the seam is dormant until a
  customer owns an account with workspaces. The IT7/IT8 columns default to today's
  behavior — `connections.scope = 'account'` and `share_mode = 'auto'` — so the
  backfill is a no-op and every existing connection behaves exactly as before;
  workspace-private and `granted` are net-new opt-ins.
- **Isolation invariant holds:** the exact-match policy boundary is unchanged;
  this epic changes *which org owns the connection*, not how membership is checked.
- **Orthogonal to `saas-workspaces`:** the mechanism here is independent of what
  the units are *named*; WS can land before or after.
- **`saas-workspace-id` (WID) is the ITX substrate (shipped):** Extended scope
  consumes WID4 identity + WID6 account RBAC + the `ws_…` handle; IT1–IT8 (shipped)
  predate WID and are unaffected. See A7 and design §12 (top note).
- **`saas-teams` (TM) grantee — deferred, additive:** a `connection_grants` row
  currently names a **workspace** org. If admitting a **team** principal is ever
  wanted, the grantee column generalizes to a subject ref (team or workspace) — no
  tenancy change, no policy rewrite (TM is principal-groups, not a tenancy level).
  Out of ITX scope; revisit on demand.
