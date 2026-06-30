# saas-workspace-id — Implementation Status (as-built)

As-built record, kept distinct from the design/plan. One row per milestone; updated
as each lands on `main`.

| Milestone | Status | As-built |
|-----------|--------|----------|
| WID1 — ID design + glossary | ✅ Shipped | `specs/core/vocabulary.md` § *Workspace ID — the durable public handle* — records the `ws_`+Crockford-base32 format, immutability, the three-identifier model, the `org_<hex>`-retained-indefinitely rule, and the no-role-in-id / `accountId === workspaceId` invariant. Docs-only; no code/schema changed. |
| WID2 — Schema + mint | ✅ Shipped | Migration `410_membership_org_public_ref` adds `membership.organizations.public_ref` (`ws_<8 Crockford-base32>`) — NOT NULL with a VOLATILE `membership.gen_workspace_ref()` default (backfills existing rows + deploy-safety backstop) + unique index. Codec `generateWorkspaceRef()`/`isWorkspaceRef()` in `packages/db/src/ids`. Minted in the single `apps/membership-worker` create-organization path; threaded through `Organization`/`CreateOrganizationInput` + the repository INSERT/bootstrap CTE. Tests: codec + repository + migrations-lock. |
| WID3 — Resolver | 🗓️ Planned | — |
| WID4 — Public surface + docs amendment | 🗓️ Planned | — |
| WID5 — SDK/CLI/console/tokens | 🗓️ Planned | — |
| WID6 — Account RBAC (Stage 1a) | 🗓️ Planned | — |
| WID7 — Resolution chain + account config (Stage 1b) | 🗓️ Planned | — |
| WID8 — First-class `accounts` entity (Stage 2) | Deferred | Scoped when a Stage-2 driver exists. |
