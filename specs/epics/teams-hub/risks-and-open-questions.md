# teams-hub (TH) — Risks & Open Questions

TH is mostly surface + read-aggregation over existing data; the risks are IA, fan-out
cost, and cross-workspace visibility — not tenancy safety (the tree is untouched).

## ⛔ Still open — confirm before building

| # | Question | Default lean |
|---|----------|--------------|
| **TH-A** | **Account Hub IA / route** — where does the account area live (`/account/{accountRef}/…` vs a mode of the existing shell)? | A dedicated account route keyed by the account `ws_…` (the account root's workspaceRef), reached from the WID5 Account chip. Keeps workspace vs account surfaces cleanly separated. |
| **TH-B** | **Fan-out budget** — how many workspaces can a team-page read fan out over before it must paginate/precompute? | Bound concurrency + cap workspaces per page; paginate by workspace beyond the cap. Precompute (a rollup cache) only if measured latency demands it — do not build the denormalized store pre-emptively. |
| **TH-C** | **Cross-workspace visibility** — does a team page show services in workspaces the *viewer* cannot access? | Show the team's owned services the **viewer is authorized to see**; count-but-redact the rest ("+3 in workspaces you can't access"). Never leak names/details across an authorization boundary. |
| **TH-D** | **Account-member roster semantics** — include a rollup of all child-workspace members, or only account-scoped + root members? | Account-scoped + root by default; child-workspace rollup behind a toggle, labeled per workspace. Avoids an overwhelming, misleading "everyone" list. |

## ✅ Decisions made

| # | Decision | Resolution |
|---|----------|------------|
| TH-1 | **Surface, not tree** | An Account Hub *surface* over the `parent_org_id` reference; no `Account → Team → Workspace` level (stays WID Stage 2). |
| TH-2 | **Fan-out, not a new store** | Cross-workspace reads fan out over the per-org indexes (same pattern as the WID6 cascade); no denormalized cross-workspace catalog. |
| TH-3 | **Derived account-member roster** | No `account_members` table; the hub derives the roster from account-scoped grants + root membership. |
| TH-4 | **Teams anchors the account surface** | The long-deferred account-member + account-role (WID6 list/revoke) UI lands *with* Teams, not as separate work. |

## Risks

| Risk | Mitigation |
|------|------------|
| **Fan-out latency at large accounts** — a team page reads across many workspaces | Bounded concurrency + pagination (TH-B); the working set is the team's **owned** entities (TO), not all services; add a rollup cache only if measured. |
| **Cross-workspace data leak** — team page exposes services the viewer can't access | TH-C: authorize each item against the viewer; count-and-redact the rest. |
| **Scope creep into WID Stage 2** — "since we're building an account surface, let's make `accounts` real" | Explicitly out of scope (TH-1); TH is UI + read-aggregation only, zero tenancy change. |
| **Account surface half-built** — Teams lands but account-members/roles UI slips | TH1 bundles the WID6 list/revoke + member roster deliberately, so the account surface ships coherent rather than teams-only. |
