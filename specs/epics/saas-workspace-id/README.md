# Epic: saas-workspace-id

**Give every Workspace a short, immutable, public id (`ws_…`) — the durable handle
the platform is missing — and lay the Account layer's evolution path on top of it.**
`saas-workspaces` (WS) shipped the *vocabulary* (a Workspace is an `organizations`
row; an Account is the parent), but it deliberately kept `workspaceId` equal to the
opaque `org_<hex>` value and made "Account" a *derived role*, not an entity. This
epic adds the one thing that vocabulary layer left out: a **stable, human-quotable
identifier** (the AWS-account-id analog), and it sequences how the **Account layer**
grows from a derived role (Stage 0) to an owner of state and authority (Stage 1) to
a first-class entity (Stage 2) — **without** an id rewrite at any step.

This is **additive, not a remodel**. `org_<hex>`, the UUID primary keys,
`/v1/organizations/*`, and the `org.*` audit taxonomy are all retained; `ws_…` is a
new durable handle layered over the unchanged model and led with on public surfaces.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — authored, not yet ready to build; open decisions in `risks-and-open-questions.md` |
| Cluster | **WID** (workspace identity — durable id + account-layer seam over **WS** `saas-workspaces` / **MO** `saas-multi-org-billing`) |
| Owner(s) | `packages/db` (schema + id codec) · `apps/membership-worker` (mint + account RBAC) · `apps/api-edge` (resolver + facades) · `packages/contracts`/`sdk`/`cli` · `apps/web-console-next` · `apps/identity-worker` (token claims) · cross-repo `sourceplane/orun` (`intent.yaml`) |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `saas-workspaces/design.md` (the Account/Workspace vocabulary + `workspaceId`/`orgId` alias pattern, `apps/api-edge/src/workspace-facade.ts`); `saas-multi-org-billing` (`parent_org_id`, `effectiveBillingOrgId(org) = parentOrgId ?? id` in `packages/db/src/membership/billing-scope.ts`); the id codec `packages/db/src/ids/index.ts` + `apps/*/src/ids.ts` (`orgPublicId`/`parseOrgPublicId`); `membership.organizations` (`packages/db/src/migrations/020_membership_core/up.sql`, `slug`/`slug_lower`) |
| Decisions locked | (1) Format = **`ws_` + Crockford base32** (uppercase, excludes I/L/O/U), self-identifying and typo-resistant — chosen over a bare AWS-style number to stay consistent with the platform's `usr_`/`prj_`/`org_` prefix convention and to keep id-kind discrimination working; (2) the id is **immutable** and stored in a dedicated `public_ref` column — *not* a repurposed slug (slug is mutable) and *not* a re-encoded UUID; (3) **no role is encoded in the id** — account-vs-workspace is *discoverable* via an `accountId` field + a derived `kind`/`isAccountRoot`, never by parsing the id; (4) **`org_<hex>` is retained indefinitely** as an accepted/returned alias (extends WS decision D4) — `ws_…` is led-with, `org_…` is never removed. |
| Gate | **Human-dependent.** Needs product sign-off on the open items in `risks-and-open-questions.md`: whether `workspaceId` is *repointed* to the `ws_` value or a new field is added (W2); whether the short id also sits on the **Account** as `acct_…` (W3); and the Account-layer **Stage 1** decisions (resolution direction, override-vs-locked, account-scoped RBAC). |

## Thesis

The platform has exactly three identity needs and today only two are met cleanly:

1. an **internal primary key** — the UUID / `org_<hex>` (stable, opaque, machine);
2. a **vanity URL label** — the `slug` (human, **mutable**, already in console URLs);
3. a **durable public handle** a human can quote to support, paste into the CLI, and
   **commit into `intent.yaml`** — *missing*.

`org_<hex>` is forced to play both (1) and (3): it is stable but a 36-char hex blob,
hostile in a CLI flag or a version-controlled file. The slug *looks* like the handle
but is mutable, so a rename silently breaks committed CI claims, support references,
and stored links. The gap is precisely the **AWS Account ID**: short, immutable,
non-vanity, non-secret. This epic mints it.

The AWS comparison also disentangles the layers AWS keeps separate and we currently
fuse: the **Account ID** (`123456789012`) is the *tenant/billing* entity — our
**Account** (parent) — while a **Workspace** (unit) is closer to a **GCP project**.
So the durable handle belongs on the Workspace as `ws_…`, and — if/when the Account
needs its own loud identity — on the Account as `acct_…` (W3), the two reading as the
same value until the Account becomes a first-class entity (Stage 2).

## How it maps to the references

| Identifier (here) | Role | Mutable? | AWS / GCP analog | Surfaced |
|-------------------|------|----------|------------------|----------|
| **`ws_…`** (new `public_ref`) | durable public Workspace handle | **no** | GCP project id/number | API paths+bodies (lead), CLI, tokens, console "copy id", **`intent.yaml`** |
| **`slug`** | vanity / URL label | yes | AWS account *alias* / GCP project id (chosen) | console URL, sign-in |
| **`org_<hex>` / UUID** | internal PK + legacy public id | no | ARN internals / Cloudflare account hex | DB, internal svc-to-svc, legacy `/v1/organizations/*`, `org.*` audit, in-flight tokens |
| **`acct_…`** (optional, W3) | Account handle (= parent's `ws_` value until Stage 2) | no | **AWS Account ID** | account-scoped billing/admin surfaces |

## Read order

1. `README.md` (this file) — status + thesis + the three-identifier model + milestones.
2. `design.md` — the id (format/codec/mint/resolver), role discovery (`accountId`,
   `kind`), the back-compat surface map, and the **Account-layer evolution
   (Stage 0 → 1 → 2)** including the scope-resolution chain and account RBAC.
3. `implementation-plan.md` — WID1–WID8, each with "done when"; the account-layer
   milestones are explicitly Stage-gated.
4. `risks-and-open-questions.md` — the W-decisions, the contract-amendment risk, and
   the migration/back-compat risks.

## Milestones at a glance

| ID | Milestone | Stage | Status |
|----|-----------|-------|--------|
| WID1 | ID design + glossary: lock `ws_`+base32, immutability, the three-id model; record in `core/vocabulary.md` | — | ✅ Shipped |
| WID2 | Schema + mint: `public_ref` column + unique index + backfill; `ws_` generator in the id codec; mint in the one `create-organization` transaction | — | ✅ Shipped |
| WID3 | Resolver: extend the org-id resolver (`parseOrgPublicId` chokepoint) to accept `ws_ \| slug \| org_`, cached (immutable map) | — | ✅ Shipped |
| WID4 | Public surface: lead with `ws_` in contracts/edge; add `accountId` + `kind`/`isAccountRoot`; accept `ws_` in requests; amend `api-guidelines` D2/D4 | — | ✅ Shipped |
| WID5 | SDK / CLI / console / tokens: lead with `ws_`; `intent.yaml` accepts `ws_`; identity tokens carry `ws_` alongside the org claim | — | ✅ Shipped (orun-cloud; Go CLI `intent.yaml` → OP/DV5) |
| WID6 | Account layer **Stage 1a** — account-scoped RBAC: `scope_kind='account'` + the policy-engine cascade (admin-portal authority) | 1 | ✅ Shipped |
| WID7 | Account layer **Stage 1b** — the scope-resolution chain (env→project→workspace→account→default) + override-vs-locked account-wide config | 1 | ✅ Shipped |
| WID8 | Account layer **Stage 2 (deferred)** — promote Account to a first-class `accounts` entity; `acct_` becomes its real id | 2 | Draft (deferred) |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The `ws_`/`public_ref` durable id (format, codec, mint, resolver); leading with it across API/SDK/CLI/console/tokens/`intent.yaml`; `accountId`+`kind` role discovery; the `api-guidelines` D2/D4 amendment; the Account-layer **design** (Stage 0→2) and the **Stage 1** account-RBAC + resolution-chain milestones | Removing `org_<hex>`, the UUID PKs, `/v1/organizations/*`, or the `org.*` taxonomy (all retained); the **Teams** model (→ `saas-teams`, which depends on WID6); deepening the tenancy tree beyond parent/child (Stage 2 / future); changing billing behavior or the `effectiveBillingOrg` primitive (→ `saas-multi-org-billing`); renaming `project`/`environment` |

## Relationship to existing work

- **`saas-workspaces` (WS)**: supplies the words (Account/Workspace) and the
  `workspaceId`/`orgId` alias + `/v1/workspaces/*` facade pattern this epic reuses.
  WS made `workspaceId == org_<hex>`; WID gives `ws_…` its own durable value (W2).
- **`saas-multi-org-billing` (MO)**: supplies `parent_org_id` and
  `effectiveBillingOrgId` — the upward-resolution seam the `accountId` field and the
  Stage-1 resolution chain generalize. No billing behavior changes.
- **`saas-teams` (TM)**: a downstream consumer — Teams are account-owned principals
  that need the **Stage 1** account-scoped RBAC (`scope_kind='account'`, WID6).
- **`saas-orun-platform` (OP/DV5)**: owns the customer-facing Go `orun` CLI and the
  committed `intent.yaml execution.state.workspace` field; WID5's `intent.yaml`
  change is a *coordination* item with that epic (as WS3 was), not unilateral.
