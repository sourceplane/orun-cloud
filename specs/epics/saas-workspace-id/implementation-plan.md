# saas-workspace-id — Implementation Plan (WID1–WID8)

Each milestone is a candidate scope for one coherent PR-sized task. The epic is
**additive and back-compatible** — nothing removes `org_<hex>`, the UUID PKs,
`/v1/organizations/*`, or the `org.*` taxonomy; `ws_…` is layered on and led-with.
WID1–WID5 deliver the durable id; WID6–WID8 are the Stage-gated Account layer.

## WID1 — ID design + glossary — ✅ Shipped (`specs/core/vocabulary.md`)

Lock the id before minting it.

- Record in `specs/core/vocabulary.md` (extending the Account/Workspace section): the
  `ws_`+Crockford-base32 format, the **immutability** rule, and the three-identifier
  model (Workspace ID `ws_…` / `slug` / `org_<hex>`+UUID; optional `acct_`).
- Note why prefixed (id-kind discrimination + convention) over a bare AWS number.
- Owner: `specs/core` + `docs`.
- **Done when:** the glossary records the format + the three-id table; no code/schema
  has changed; WID2–WID5 reference it.

## WID2 — Schema + mint — ✅ Shipped (`410_membership_org_public_ref`)

Give every org an immutable `ws_…` at birth and backfill the rest.

- `packages/db`: migration adding `membership.organizations.public_ref TEXT` + a unique
  index; a backfill step generating a `ws_` for every existing row; mark `NOT NULL`
  once backfilled.
- `packages/db/src/ids`: add `generateWorkspaceRef()` (generate-and-check vs the unique
  index, retry on collision) + `isWorkspaceRef()`; expose via the shared module so all
  workers reuse it.
- `apps/membership-worker`: generate `public_ref` inside the existing
  `create-organization` transaction (the single creation path).
- Owner: `packages/db` + `apps/membership-worker`.
- **Done when:** every org row has a unique, immutable `ws_…`; new orgs get one in the
  creation transaction; the column is `NOT NULL`; repository tests cover generation +
  collision retry.

## WID3 — Resolver — ✅ Shipped (`apps/api-edge/src/org-ref-facade.ts`)

Make `ws_…` work anywhere `org_…`/slug works, at one chokepoint.

- Generalize the org-id resolver (the `parseOrgPublicId` decode point used by the edge
  + the `auth.ts` "slug or `org_…`" claim path) into `resolveOrgRef(ref)` accepting
  `ws_ | slug | org_`; cache the `ws_ → uuid` map (immutable, no invalidation).
- No handler forks — downstream still receives the canonical UUID/`org_`.
- Owner: `apps/api-edge` + `packages/db`/`packages/contracts` + `apps/identity-worker`.
- **Done when:** every org-scoped route + the CLI claim resolve a `ws_…` to the right
  tenant with results byte-identical to the `org_…` spelling; resolver tests cover all
  three spellings + miss/invalid cases.

## WID4 — Public surface (contracts + edge) + docs amendment — ✅ Shipped (W2=Option B)

Lead with `ws_…`; expose role; keep `org_<hex>` an alias.

- `packages/contracts` + `apps/api-edge`: per the **W2** decision, either repoint
  `workspaceId` to the `ws_` value (lead choice) or add `workspaceRef`; project
  `accountId` (= `effectiveBillingOrgId`) + derived `kind`/`isAccountRoot` on workspace
  shapes; accept `ws_` (and the legacy spellings) on requests.
- Add `tenant.workspaceId` alongside `tenant.orgId` in the event/webhook envelope
  (keep `tenant.orgId`); leave the `org.*` taxonomy unforked.
- `specs/core/contracts/api-guidelines.md`: amend § Public vocabulary + § Deprecation
  to name `ws_…` as the led id and `org_<hex>` as the retained indefinite alias.
- Owner: `packages/contracts` + `apps/api-edge` + `docs`.
- **Done when:** public responses lead with `ws_…` and carry `accountId`/`kind`; both
  spellings accepted on input; `org_<hex>`/`/v1/organizations/*` unchanged; contract
  tests assert both spellings + the role fields; the guidelines amendment is published.

## WID5 — SDK / CLI / console / tokens / intent.yaml — ✅ Shipped (orun-cloud surfaces; Go CLI deferred to OP/DV5)

Make `ws_…` the id customers see and commit.

- `packages/sdk` + `packages/cli`: lead with `ws_…` in params + output; accept either.
- `apps/web-console-next`: show `ws_…` prominently (header/settings) with a copy
  button; keep `slug` in the URL; badge `kind` (Account vs Workspace).
- `apps/identity-worker`: include the `ws_` id in CLI/workflow token claims **alongside**
  the existing `orgIds[]`/`orgId` (kept until in-flight tokens age out).
- **`sourceplane/orun`** (Go CLI): accept `ws_…` for `execution.state.workspace` /
  `--workspace` / `ORUN_WORKSPACE` (read either, prefer `ws_`); a *coordination* item
  with `saas-orun-platform` (DV5), not unilateral.
- Owner: `packages/sdk`/`cli` + `apps/web-console-next` + `apps/identity-worker` +
  `sourceplane/orun` (via OP).
- **Done when:** SDK/CLI/console lead with `ws_…`, tokens carry it, `intent.yaml`
  accepts it; all legacy spellings still work; the console shows account-vs-workspace.

## WID6 — Account layer Stage 1a: account-scoped RBAC — ✅ Shipped (`420_membership_account_rbac`)

Authority to administer workspaces from the Account (admin-portal prerequisite).

- `packages/db` + `apps/membership-worker`: add `scope_kind='account'` to
  `role_assignments`; roles `account_owner`/`account_admin`/account `billing_admin`.
- `packages/policy-engine` + `apps/membership-worker` (context assembly): cascade —
  when authorizing on workspace `X`, also honor account-scoped facts where
  `X.accountId` matches.
- Owner: `packages/db` + `apps/membership-worker` + `packages/policy-engine`.
- **Done when:** an `account_admin` can act on every workspace in the account with no
  per-workspace role row; policy tests cover the cascade + the still-deny default.

## WID7 — Account layer Stage 1b: resolution chain + account-wide config

Inheritance with override-vs-locked semantics.

- Generalize config resolution into env→project→workspace→**account**→default, with an
  `overridable: true|false` flag on account-scope values (default vs guardrail).
- Prefer resolve-up-at-read for config/policy; new workspaces inherit with no backfill.
- Owner: `apps/config-worker` + `packages/contracts` + `apps/api-edge` (+ console).
- **Done when:** an account-wide setting is inherited by all workspaces; an overridable
  value can be overridden per-workspace; a locked value cannot; tests cover the chain
  + both modes.

## WID8 — Account layer Stage 2 (deferred)

Promote Account to a first-class entity — **only** when state/depth demands it.

- `accounts` table + `account_id` FK on every org; `acct_` becomes the `accounts`
  row's real id (graduating from the W3 alias); migrate `accountId` to point at it.
- Enables guardrail-owning Accounts, teams-as-hierarchy-level, and >2-level depth.
- Owner: `packages/db` + `apps/membership-worker` + `apps/api-edge`.
- **Done when:** scoped + sequenced as its own program once a concrete Stage-2 driver
  (nested depth, account-owned policy home, or teams-as-level) is confirmed.

## Sequencing note

WID1 (format) gates the rest. WID2→WID3→WID4 are the critical path (mint → resolve →
surface) and should land in order. WID5 follows WID4 so surfaces and contracts agree.
WID6 (account RBAC) is independent of WID2–WID5 and is the gate for `saas-teams`; WID7
follows WID6. WID8 is deferred until a Stage-2 driver exists. The whole id track
(WID1–WID5) is additive and can land before or after the account-layer milestones.
