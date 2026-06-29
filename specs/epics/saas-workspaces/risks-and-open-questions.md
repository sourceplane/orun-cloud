# saas-workspaces — Risks & Open Questions

Live register of the vocabulary/aliasing decisions for the epic. The epic is
additive and back-compatible, so the risks are about **terminology stickiness**
and **dual-surface maintenance**, not data safety. Defaults are recorded; confirm
the open items before the corresponding milestone lands.

## ⛔ Still open — confirm before building

None — all decisions below are locked and the epic (WS1–WS5) has shipped.

## ✅ Decisions made

| # | Decision | Resolution |
|---|----------|------------|
| D1 | **Final nouns** | **Account** (tenant/parent) + **Workspace** (unit). Locked in WS1; recorded in `specs/core/vocabulary.md`. |
| D2 | **Aliasing depth** | **Label + public API aliasing** — not label-only, not a full model rename. Shipped: `/v1/workspaces/*` edge alias + `workspaceId` projection (WS2). |
| D3 | **Audit / analytics event terminology** | **Keep `org.*`** internally and on the wire; document the mapping; do **not** fork the taxonomy. Published in `contracts/api-guidelines.md` (WS5). |
| D4 | **`/v1/organizations/*` deprecation window** | **Indefinite coexistence; no removal date.** Removing the legacy surface is a breaking change requiring a separate announced migration. Published in `contracts/api-guidelines.md` (WS5). |
| A1 | Relabel vs remodel | **Relabel.** No new entity; a Workspace is an `organizations` row; `org_id`-everywhere is untouched. |
| A2 | Parent representation | The parent is **both** the Account and one selectable Workspace (its own direct org) — a synthetic UI affordance, no schema change. |
| A3 | "Product" as the unit name | **Rejected** — collides with the Polar *product* (billing SKU). |
| A4 | **`intent.yaml` tenancy field spelling** (the Go `orun` CLI) | **Alias `execution.state.workspace`** as the leading/preferred spelling; retain `execution.state.org` (shipped by `oidc-ci-tenancy`, orun #420) as an accepted alias — read either, prefer `workspace`. Same for `--workspace`/`--org` and `ORUN_WORKSPACE`/`ORUN_ORG`. The declared **value** is always the **Workspace** org, never the Account. Implement **with `saas-orun-platform` (DV5)**; back-compat keeps existing `execution.state.org` configs working unchanged. |

## Risks

| Risk | Mitigation |
|------|------------|
| **Brand/impl drift** — UI says Workspace, API docs say organization | The chosen depth (label + API alias) keeps both surfaces in sync; WS2 lands the alias before WS4 ships the UI name. |
| **Dual-route maintenance** — `/v1/workspaces/*` and `/v1/organizations/*` to keep in lockstep | Implement the alias as a pure path-rewrite into the **same** facade/handlers (no fork); contract tests assert byte-identical results for both spellings. |
| **Term sprawl** — "Workspace" leaking into internal code where `org` is the model | Keep the rename strictly at the public surface (edge alias, contracts projection, console copy, SDK/CLI). Internal services, DB, policy, audit stay `org`. |
| **Reverse collision** — `state.workspace_links` already uses "workspace" internally for the CLI/CI allow-list, unrelated to the new Workspace noun | Glossary (WS1) flags `workspace_links` as a legacy internal name, left as-is (relabel-not-remodel); docs disambiguate it from the Workspace unit, the `integrations.repo_links`, and the `…/cli/links` endpoint. Do not rename the table. |
| **Confusion with `project`** | Glossary (WS1) fixes `Workspace → Project → Environment` as three distinct levels; docs lead with the hierarchy diagram. |

## Non-blocking notes

- **No data migration, no billing change:** every `organizations` row and all
  billing behavior are untouched; this is vocabulary + aliases only.
- **Orthogonal to `saas-integration-tenancy`:** that epic supplies the integration
  *mechanism*; this one supplies the *words*. Either can land first.
- **Reuses shipped chrome:** the Workspace switcher is the existing scope-switcher
  + `use-effective-org.ts` re-labelled, not a new tenancy UI primitive.
