# saas-workspaces — Implementation Plan (WS1–WS5)

Each milestone is a candidate scope for one coherent PR-sized task. The whole
epic is additive and back-compatible — nothing here removes `organization`
surfaces; it layers Account/Workspace vocabulary over the shipped
`saas-multi-org-billing` parent/child model. Status markers reflect that nothing
here is built yet.

## WS1 — Glossary + vocabulary decision — ✅ Shipped (`specs/core/vocabulary.md`)

Lock the words before touching any surface.

- Record the Account/Workspace glossary in `core/` (domain-model glossary or a
  short `core/vocabulary.md`): Account = tenant/parent; Workspace = any org in the
  account incl. the parent's own; Project = unchanged.
- Note the rejected names and why (**Product** = Polar SKU collision; **Project** =
  existing sub-unit).
- Owner: `specs/core` + `docs`.
- **Done when:** the glossary is merged and referenced by WS2–WS5; no code or API
  has changed yet.

## WS2 — Public API aliasing — ✅ Shipped (`apps/api-edge/src/workspace-facade.ts`)

Serve `/v1/workspaces/*` as aliases without forking handlers.

- `apps/api-edge`: add `/v1/workspaces/{workspaceId}/…` as a path-rewrite alias
  into the existing org facade (`org-facade.ts`); `workspaceId` is the same opaque
  `org_*` id. Optionally add `/v1/accounts/{accountId}/…` for parent-scoped reads
  that already resolve to `effectiveBillingOrg`.
- `packages/contracts`: project a `workspaceId` field alongside `orgId` (same
  value) on responses; accept either on requests; keep `orgId` documented as the
  durable id.
- Owner: `apps/api-edge` + `packages/contracts`.
- **Done when:** every `/v1/organizations/*` route has a working `/v1/workspaces/*`
  alias returning identical results; old routes/fields are unchanged; contract
  tests cover both spellings.

## WS3 — SDK / CLI vocabulary — ✅ Shipped

> SDK `workspaces` namespace + `@saas/cli` `workspace` commands (this repo); the
> customer-facing Go `orun` CLI shipped in `sourceplane/orun#429`.


- `packages/sdk`: add a `workspaces` namespace aliasing `organizations` (same ids,
  same client); retain `organizations` with a deprecation note.
- `packages/cli` (`@saas/cli`, internal control-plane CLI): add `workspace`
  subcommands aliasing `org`; accept `--workspace` alongside `--org`; lead help
  text with Workspace.
- **`sourceplane/orun` (the customer-facing Go CLI)**: this is where the `org`
  vocabulary is most visible — `--org`, `ORUN_ORG`, and the committed
  `intent.yaml` field `execution.state.org` (+ `requireOrg`), shipped by
  `oidc-ci-tenancy` (orun #420). Add `--workspace` (and `ORUN_WORKSPACE`) aliases
  and lead help with Workspace; per **A4**, lead with `execution.state.workspace`
  and retain `execution.state.org` as an accepted alias (read either, prefer
  `workspace`). This is a cross-repo change owned by `saas-orun-platform` (DV5) —
  plan it there, do not fork the org-tenancy precedence chain. The declared value
  is always the **Workspace** org, never the Account.
- Owner: `packages/sdk` + `packages/cli` + **`sourceplane/orun`** (via
  `saas-orun-platform`).
- **Done when:** the SDK and both CLIs expose Workspace surfaces that pass through
  to the org endpoints; existing `organizations`/`org`/`--org`/`execution.state.org`
  usage still compiles and works; the `intent.yaml` spelling decision (D5) is
  recorded and implemented.

## WS4 — Console rebrand + parent-as-workspace — 🗓️ Planned

- Relabel the scope-switcher as the **Workspace switcher** grouped under the
  **Account**; update copy, empty states, Cmd-K ("Switch/Create workspace"),
  reusing `use-effective-org.ts` + the existing chrome.
- Surface the **parent as a selectable Workspace** (its own direct org) in
  addition to the Account header — a synthetic list affordance, no schema change.
- "Create organization" → "Create workspace" (MO2 gate + U7 upgrade UX unchanged).
- Account-level surfaces (billing, shared GitHub connection, usage Overall-vs-
  Individual) render on the Account; per-Workspace surfaces on the selected
  Workspace.
- Owner: `apps/web-console-next` (+ `packages/sdk` if a read shape is missing).
- **Done when:** the console reads as "one Account, many Workspaces"; the parent is
  usable both as the Account and as a Workspace; no billing/gating behavior
  changed.

## WS5 — Docs + deprecation policy — 🗓️ Planned

- Public docs adopt Account/Workspace; map them to the legacy `organization` term.
- Decide + record the coexistence window for `/v1/organizations/*` and the
  `orgId` field, and whether audit-event/analytics names stay `org.*` (internal,
  default) or also emit `workspace.*` aliases (see risks D3).
- Owner: `docs` + `packages/contracts` (if event aliases are chosen).
- **Done when:** docs are consistent; the deprecation policy is published; the
  event-taxonomy decision is recorded and implemented.

## Sequencing note

WS1 (words) gates the rest. WS2 (API alias) and WS3 (SDK/CLI) are independent and
can land in parallel once the glossary is locked. WS4 (console) is the
buyer-visible payoff and should follow WS2 so the UI and API speak the same name.
WS5 closes the loop on docs + deprecation. The whole epic is additive — it can
land before or after `saas-integration-tenancy`.
