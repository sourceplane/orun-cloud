# saas-teams — Risks & Open Questions

Live register for the Stage-1 Teams epic. Teams are additive principals over the
existing RBAC, so the risks are about **authorization correctness** (fact expansion) and
**legibility of union access**, not data safety. The **WID6 dependency is cleared** (it
shipped). Confirm the ⛔ items before the corresponding milestone lands.

## ⛔ Still open — confirm before building

| # | Question | Default lean |
|---|----------|--------------|
| **T1** | **Team id format** — `team_<base32>` (match the `ws_` direction) vs `team_<hex>` (match the legacy `usr_`/`org_` hex)? | **`team_<base32>`** — align with the new durable-id direction in `saas-workspace-id`. |
| **T2** | **Members** — users only, or also service principals? | **Both** — `subject_type` already supports `service_principal`; allowing SPs in teams covers CI/automation grouping. |
| **T6** | **Grantable scopes** — allow team grants at all of account/workspace/project, or restrict to account+workspace initially? | **All three** — `role_assignments` already models project scope; no reason to special-case it out. |

## ✅ Resolved by repo reality (were open; the code answers them)

| # | Question | Resolution |
|---|----------|------------|
| **T5** | **Cache invalidation** — bust vs short-TTL for team-derived authz contexts? | **Neither is needed at Stage 1.** The PERF2 "authz cache" doesn't exist as assumed: `apps/api-edge/src/actor-cache.ts` caches only token→identity (30s TTL), and `authorization-context.ts` re-assembles role facts **per request**. So a removed team member loses access on the next request with no bust. T5 becomes a PERF note (expansion query budget) + a trigger condition: explicit team-keyed busting is required **only if** a future task caches the assembled authz context. |
| **T-WID6** | **Is the account-RBAC prerequisite available?** | **Yes — shipped.** Migration `420_membership_account_rbac` + `ACCOUNT_ROLE_PERMISSIONS` + the live cascade in `authorization-context.ts`. The epic is un-gated on its hard dependency; status moved Draft → Ready. |

## ✅ Decisions made

| # | Decision | Resolution |
|---|----------|------------|
| T-A | **Principal, not level** | A Team is an account-owned **principal**, not a tenancy level and not a resource container. Hierarchy-level teams (Account→Team→Workspace) are deferred to `saas-workspace-id` Stage 2. |
| T-B | **Ownership** | Teams are **account-owned** (grantable across all workspaces in the account), which subsumes workspace-local teams (grant on a single workspace when wanted). |
| T-C | **Reuse `role_assignments`** | A new `subject_type='team'` makes a team an assignable principal — **no** separate team-grants table; the policy engine stays agnostic. |
| T-D | **Expand at assembly, not in the engine** | Team membership is expanded into facts in `membership-worker`'s context builder; `packages/policy-engine` is unchanged. |
| T-E | **Union semantics** | Effective permission is the **union** over direct + team + account-cascade facts (allow-only engine; no deny rules). |
| T-F | **Flat teams** | No nesting (teams-in-teams) at Stage 1. |

## Risks

| Risk | Mitigation |
|------|------------|
| **R-LR — account-role list/revoke gap** — WID6 shipped the account-role *grant* path but **deferred list/revoke** to the admin-portal follow-up. TM4's team grant-management UI needs list/revoke of grants to be usable (grant-only is a write-only trap). | Sequence TM4's grant-management behind the account-role list/revoke follow-up, or land team list/revoke as the generalization that also closes the account-role gap. Track as a soft dependency, not a hard blocker for TM1–TM3. |
| **Hot-path expansion cost** — every authorize re-assembles context; team expansion adds a `team_members` lookup + a team-grants lookup (target + account scope) to the PERF2-sensitive path | Batch with `listRoleAssignmentsForSubjects` (no N+1); short-circuit both queries when the account owns no teams (cheap cached count) so non-adopters pay ~zero; fold team-id load into the account-cascade round trip where practical. |
| **Team-lifecycle orphans** — deleting a team, or a member leaving the account, can leave dangling grant/membership rows that corrupt the effective-access view and audit trail | TM2 cascade-revokes a team's `subject_type='team'` grants on delete; `remove-member` also strips the subject from the account's teams; expansion filters on active team + membership so access stops regardless, but rows are cleaned for legibility. |
| **Over-broad inheritance** — an account-scope team grant silently covers every (incl. future) workspace | This is the intended power; make it legible via **TM6** — show "granted via Team X at Account scope" provenance in the console; gate account-scope grants behind account admins only. |
| **Permission sprawl / un-debuggable union** — many teams × many grants becomes hard to reason about | **TM6** ships the "effective access" view (who can do what here, and via which team/grant); keep union semantics simple; no deny rules to invert reasoning. Elevated from a note to a first-class milestone. |
| **Missing audit trail** — `grant-account-role` emits no audit/event (unlike every other membership mutation); teams would inherit that gap | TM4 emits `team.*` events + audit on every mutation and backfills the account-role grant audit in the same pass — authority changes must be attributable. |
| **Parallel ACL temptation** — building team-specific permissions | Forbidden by T-C: reuse `role_assignments` + the existing role catalog; a team is a subject, nothing more. |
| **Subject-id ambiguity** — `subject_id` is shared TEXT across `usr_`/`sp_`/`team_` | The `subject_type` column disambiguates; expansion queries always filter `subject_type='team'`; ids are prefix-distinct anyway. Grants bind to the immutable `team_` id, never the mutable slug. |

## Non-blocking notes

- **No engine rewrite:** TM3 is expected to be code-change-free in
  `packages/policy-engine` (tests only) — the engine's first-allow-wins scan over the
  fact list is already a union for the allow-only case, and it never inspects
  `subject_type`, so team-derived facts resolve identically to direct facts.
- **Subset, not superset, of effort vs WID:** Teams reuse WID6's authority model; this
  epic adds grouping + expansion, not a new tenancy primitive.
- **Stage-2 hooks:** if/when `saas-workspace-id` Stage 2 lands the `accounts` entity,
  `teams.account_org_id` repoints to `accounts.id` with no semantic change; nesting and
  teams-as-level become tractable there, not here.
