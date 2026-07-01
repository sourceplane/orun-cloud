# teams-foundation (TF) — Risks & Open Questions

Additive over `saas-teams` (**TM**); the risks are about entity ergonomics and the
two-authority-plane separation, not data safety.

## ⛔ Still open — confirm before building

| # | Question | Default lean |
|---|----------|--------------|
| **TF-A** | **Handle namespace & format** — charset/length (`^[a-z0-9][a-z0-9-]{1,38}$`?), and account-unique vs account+workspace-unique? | Account-unique, lower-kebab, immutable-preferred (rename allowed but discouraged) — teams span workspaces, so the account is the namespace. |
| **TF-B** | **Create authority** — account-admin only, or delegable (any workspace admin can create a team)? | **Account-admin only at v1** (teams are account-owned); delegation is a later toggle. Keeps the namespace governable. |
| **TF-C** | **Open teams** — Datadog-style self-service *join* for teams marked "open", or closed-only (admin-added) at v1? | **Closed-only at v1**; add an `open`/`joinable` flag + self-join in a follow-up. Avoids membership sprawl before the audit/attestation story (TG) exists. |
| **TF-D** | **Avatar** — uploaded asset vs deterministic initials/colour (the catalog-portal already renders initials+colour for owners)? | **Initials + colour at v1** (reuse the portal's owner-avatar renderer); uploads later. Zero new storage surface. |

## ✅ Decisions made

| # | Decision | Resolution |
|---|----------|------------|
| TF-1 | **Entity, not just a subject** | A Team gains a public id + handle + profile so ownership/hub/collaboration can bind to it. |
| TF-2 | **Two authority planes** | Team-management (`team_admin`) is separate from platform-grant authority (grantor's scope). A team admin curates the roster; it cannot escalate the team's power. |
| TF-3 | **Id-bound references** | Grants, owner maps, and routing rules bind to the immutable `team_` id; the handle is a mutable alias. |
| TF-4 | **Provenance is foundational** | `grantedVia` + effective-access ships in TF (promoted from TM6) because every later plane renders it. |

## Risks

| Risk | Mitigation |
|------|------------|
| **Privilege escalation via roster edits** — a `team_admin` adds themselves to a powerful team | By design, a team's *power* comes only from scope-authorized grants; a `team_admin` changes membership, never grants. Every add is audited (TF5); TG adds membership review. |
| **Handle churn breaks references** — renaming a team | All references are `team_`-id-bound (TF3); the handle is an alias resolved at read time. Renames are audited. |
| **Two-role-plane confusion in the UI** — users conflate "manage team" with "what the team can do" | The console separates "Members" (team_admin) from "Access / Grants" (scope admin) into distinct panels with distinct permission copy. |
| **Account-admin bottleneck** if TF-B stays closed | Team-management roles (TF2) already remove the per-roster-edit bottleneck; only *team creation* stays account-gated, which is low-frequency. |
