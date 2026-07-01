# teams-ownership (TO) — Risks & Open Questions

The keystone epic. Risks center on the git-vs-console boundary and owner-string
ergonomics, not data safety.

## ⛔ Still open — confirm before building

| # | Question | Default lean |
|---|----------|--------------|
| **TO-A** | **Map authority & collision** — who edits `team_owner_handles`, and what if two teams claim the same owner handle? | Account-admin (or `team_admin` proposing, account-admin approving); **one handle → at most one team** per account (unique index enforces). Last-writer-wins with an audit trail. |
| **TO-B** | **Owner-string grammar** — accept a bare handle (`payments`) only, or also a typed form (`group:payments`, `team:payments`)? | Accept both: strip a known `group:`/`team:` prefix, then match on the remainder. Bare handle is the happy path; typed forms interoperate with Backstage-style `catalog-info.yaml`. |
| **TO-C** | **Resolution cache/TTL** — how fresh must owner→team resolution be? | Short TTL (≈60s) per `(account, handle)`, invalidated on map/team-handle change. Ownership is display, not authorization, so bounded staleness is harmless. |
| **TO-D** | **Unmapped owner handling** — silently Unowned, or surfaced as an action item? | **Surface it.** "owner declared but unmapped" ≠ "no owner"; the unmapped set is TO5's backlog and a scorecard remediation, so ownership coverage is honest. |

## ✅ Decisions made

| # | Decision | Resolution |
|---|----------|------------|
| TO-1 | **Bind via a map, never author the catalog** | An account-authored `owner_handle → team_id` map (org metadata) resolves ownership; the catalog projection is never written (`18-state` intact). |
| TO-2 | **Read-time resolution** | No denormalized `team_id` on `org_catalog_entities` (would drift on re-projection); resolve at read, batched + cached. |
| TO-3 | **Ownership ≠ authorization** | Resolving `owner → team` confers accountability + findability, **not** permissions; access stays in `role_assignments` (TM). |
| TO-4 | **Default is convention** | `owner == team.handle` resolves with no map row; the map captures aliases/legacy strings only. |

## Risks

| Risk | Mitigation |
|------|------------|
| **Invariant erosion** — pressure to "just add a `team_id` column" to the catalog | Forbidden by TO-2 + `18-state`; the map + read-time resolution is the sanctioned path. Call it out in review. |
| **Ownership mistaken for access** — someone assumes `owner: payments` grants the Payments team rights | README non-goal + TO-3; the console labels ownership as "accountable for" and never as a grant; access lives in a separate panel (TF two-plane split). |
| **Owner-string drift** — git owner strings diverge from team handles over time (renames, reorgs) | The alias map absorbs drift; TO5's unmapped-owner report keeps the backlog visible; renaming a team keeps its `team_` id so grants/pages are unaffected — only the alias may need adding. |
| **Cross-workspace owner ambiguity** — the same owner string in two workspaces under one account | Teams (and thus resolution) are account-scoped, so one handle resolves to one team account-wide — consistent across every workspace by construction. |
