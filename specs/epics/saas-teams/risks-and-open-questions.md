# saas-teams — Risks & Open Questions

Live register for the Stage-1 Teams epic. Teams are additive principals over the
existing RBAC, so the risks are about **authorization correctness** (fact expansion +
cache staleness) and the **WID6 dependency**, not data safety. Confirm the ⛔ items
before the corresponding milestone lands.

## ⛔ Still open — confirm before building

| # | Question | Default lean |
|---|----------|--------------|
| **T1** | **Team id format** — `team_<base32>` (match the `ws_` direction) vs `team_<hex>` (match the legacy `usr_`/`org_` hex)? | **`team_<base32>`** — align with the new durable-id direction in `saas-workspace-id`. |
| **T2** | **Members** — users only, or also service principals? | **Both** — `subject_type` already supports `service_principal`; allowing SPs in teams covers CI/automation grouping. |
| **T5** | **Cache invalidation** — explicit bust on `team_members`/team-grant change vs short TTL for team-derived authz contexts? | **Short TTL now, explicit bust if needed** — simplest correct default; tighten if offboarding SLAs demand sub-TTL revocation. |
| **T6** | **Grantable scopes** — allow team grants at all of account/workspace/project, or restrict to account+workspace initially? | **All three** — `role_assignments` already models project scope; no reason to special-case it out. |

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
| **WID6 dependency** — account-scope team grants need `scope_kind='account'` + the policy cascade | Hard-sequence: WID6 lands before TM3. Workspace/project-scope team grants work without WID6, but the headline account-inheritance story does not — do not ship TM3 as "done" until WID6 is in. |
| **Cache staleness on offboarding** — PERF2 caches authz; a removed team member keeps access until expiry | T5: short TTL or explicit bust; document the revocation window; never let it exceed the offboarding SLA. |
| **Over-broad inheritance** — an account-scope team grant silently covers every (incl. future) workspace | This is the intended power; make it legible — show "granted via Team X at Account scope" provenance in the console; gate account-scope grants behind account admins only. |
| **Permission sprawl** — many teams × many grants becomes hard to reason about | Provide an "effective access" view (who can do what here, and via which team/grant); keep union semantics simple; no deny rules to invert reasoning. |
| **Parallel ACL temptation** — building team-specific permissions | Forbidden by T-C: reuse `role_assignments` + the existing role catalog; a team is a subject, nothing more. |
| **Subject-id ambiguity** — `subject_id` is shared TEXT across `usr_`/`sp_`/`team_` | The `subject_type` column disambiguates; expansion queries always filter `subject_type='team'`; ids are prefix-distinct anyway. |

## Non-blocking notes

- **No engine rewrite:** TM3 is expected to be code-change-free in
  `packages/policy-engine` (tests only) — the union already handles team-derived facts.
- **Subset, not superset, of effort vs WID:** Teams reuse WID6's authority model; this
  epic adds grouping + expansion, not a new tenancy primitive.
- **Stage-2 hooks:** if/when `saas-workspace-id` Stage 2 lands the `accounts` entity,
  `teams.account_org_id` repoints to `accounts.id` with no semantic change; nesting and
  teams-as-level become tractable there, not here.
