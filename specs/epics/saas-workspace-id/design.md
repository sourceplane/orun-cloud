# saas-workspace-id — Design

Status: Draft (normative once WID1 lands)

The durable public **Workspace ID** (`ws_…`), the role-discovery fields that sit
beside it, and the **Account-layer evolution** it unlocks. Written against repo
reality as of 2026-06-30: `saas-workspaces` shipped the Account/Workspace vocabulary
and the `workspaceId`/`orgId` alias (`apps/api-edge/src/workspace-facade.ts`,
`packages/contracts/src/workspace.ts`); `saas-multi-org-billing` shipped
`parent_org_id` + `effectiveBillingOrgId(org) = parentOrgId ?? id`
(`packages/db/src/membership/billing-scope.ts`); the id codec lives at
`packages/db/src/ids/index.ts` (+ per-worker `apps/*/src/ids.ts`); `org_<hex>` is a
UUID with the dashes stripped (`orgPublicId`/`parseOrgPublicId`).

## 1. The gap (WID1)

There are three identity needs; only two are met:

| Need | Today | Adequate? |
|------|-------|-----------|
| Internal primary key | UUID / `org_<hex>` | ✅ |
| Vanity URL label | `slug` (mutable, unique on `slug_lower`) | ✅ (URLs) |
| **Durable public handle** (quote to support, paste in CLI, commit in `intent.yaml`) | *overloaded onto `org_<hex>`* | ❌ |

`org_<hex>` is stable but a 36-char hex blob; the slug is friendly but **mutable**,
so it is unsafe as a durable reference (a rename breaks committed CI claims, support
tickets, and stored links). The missing handle is the **AWS Account ID**: short,
immutable, non-vanity, non-secret. WID mints it as `ws_…`.

## 2. The identifier (WID1)

- **Format:** `ws_` + **Crockford base32** body (uppercase A–Z/2–9, excluding
  `I L O U`), e.g. `ws_3KF9TQ2P`. 8 body chars ≈ 40 bits (~1.1e12 space); 10 chars
  ≈ 50 bits if more headroom is wanted. Optionally append a check character.
- **Why prefixed, not a bare AWS-style number:** the platform is a textbook
  Stripe-style prefixed-id system (`usr_`, `prj_`, `org_`, `req_`); a bare number
  would be the one id that looks unlike every other and would break **id-kind
  discrimination** (audit envelopes, webhook payloads, and `parseSubjectUuid` key off
  the prefix). Self-identification + typo-resistance beat literal AWS mimicry here.
- **Immutable.** Generated once at creation, never reissued. This is the whole point
  — unlike `slug`, it is safe to commit and to quote forever.
- **Storage:** a dedicated column, **not** a re-encoding of the UUID and **not** the
  slug:

```sql
ALTER TABLE membership.organizations ADD COLUMN public_ref TEXT;
CREATE UNIQUE INDEX organizations_public_ref_idx ON membership.organizations (public_ref);
-- backfilled NOT NULL once every row carries a value (WID2)
```

- **Codec:** add `generateWorkspaceRef()` (generate-and-check against the unique
  index, retry on collision) and `isWorkspaceRef()` to the shared id module
  (`packages/db/src/ids/index.ts`), so all ~10 workers share one implementation
  rather than each carrying a copy (the existing pattern for `uuidToHex`/`hexToUuid`).

## 3. Mint point — one transaction (WID2)

Orgs are created in exactly one place: the `create-organization` handler in
`apps/membership-worker` (a single transaction that inserts the org + owner member +
owner role + creation event). `public_ref` is generated **there and only there**, in
the same transaction, so there is no second creation path to keep in sync and the id
exists from the first moment the row does. Existing rows are backfilled by the WID2
migration before the column is marked `NOT NULL`.

## 4. Resolver — one chokepoint (WID3)

Every org-scoped route already decodes the id from the URL via `parseOrgPublicId`
(hex → UUID). Generalize **that one resolver** to accept any of the three spellings:

```
resolveOrgRef(ref):
  ref starts "ws_"  → look up public_ref → uuid     (NEW; cache, immutable map)
  ref starts "org_" → hexToUuid                       (existing; legacy, retained)
  else              → slug_lower lookup               (existing; URL/claim path)
```

Because `public_ref` is immutable, the `ws_ → uuid` map is trivially cacheable (no
invalidation). This mirrors `auth.ts`'s existing "slug or `org_…`" claim acceptance
and the `workspace-facade.ts` path-rewrite discipline — **handlers are not forked**;
they keep receiving the canonical UUID/`org_` they already handle.

## 5. Role discovery — never in the id (WID4)

Account-vs-Workspace is **mutable, relational state** (`saas-multi-org-billing §8`:
an org *becomes* a parent on its first child with no row rewrite), and the parent is
*both* an Account and a Workspace (`saas-workspaces` A2). Encoding role in the id
would therefore force the id to change when an org gains a child — fatal for an
immutable handle — and could never be truthful for the dual-role parent. AWS/GCP/Stripe
all agree: role lives in the graph, never in the node's id.

Surface it as **fields** instead, reusing `effectiveBillingOrgId`:

```jsonc
// child workspace
{ "workspaceId": "ws_3KF9TQ2P", "accountId": "ws_9QM2X7BD",
  "parentWorkspaceId": "ws_9QM2X7BD", "isAccountRoot": false, "kind": "workspace" }
// the parent — Account AND a workspace
{ "workspaceId": "ws_9QM2X7BD", "accountId": "ws_9QM2X7BD",
  "parentWorkspaceId": null, "isAccountRoot": true, "kind": "account" }
```

The invariant that answers "is this an account?" everywhere, without parsing the id:
**`accountId === workspaceId` ⟺ Account root.** `accountId` (= `parentOrgId ?? self`,
the existing billing-scope resolution surfaced as a field) is the genuinely useful
one — it is the AWS pattern of embedding the account id in every ARN: a Workspace
always knows its tenant.

> **Hard rule:** never branch security or routing logic on a parsed id prefix.
> Authority comes from the resolved record (`kind`/`accountId`), not the string.

## 6. Public-surface decision: repoint vs add (W2)

`saas-workspaces` published `workspaceId == org_<hex>` (decisions D2/D4). Leading with
`ws_…` changes that. Two options (locked in `risks-and-open-questions.md` W2):

- **(a) Repoint** `workspaceId` to the `ws_` value; expose `org_<hex>` as a separate
  retained legacy field. Cleanest long-term; amends D2/D4.
- **(b) Add** a new field (e.g. `workspaceRef`) for `ws_`; keep `workspaceId ==
  org_<hex>`. Lower contract churn; two "workspace" ids to explain.

Lean: **(a)** — make `ws_…` *the* Workspace ID going forward, `org_<hex>` the legacy
alias — but it is a published-contract change and must be recorded, with the
`api-guidelines` § Public vocabulary / § Deprecation amended accordingly.

## 7. Back-compat surface map (WID4–WID5)

Lead with `ws_…`; keep `org_<hex>` an accepted/returned alias **forever** (extends WS
D4). What can flip vs what must persist:

| Surface | Lead with `ws_…` | `org_<hex>` must persist as |
|---------|------------------|------------------------------|
| API paths + bodies | yes | legacy field + `/v1/organizations/*` route (D4) |
| SDK/CLI params + output | yes (accept either) | accepted input alias |
| `intent.yaml execution.state.workspace` | yes (accept either) | accepted alias (coordinate w/ OP/DV5) |
| Identity tokens (`orgIds[]`, workflow `orgId`) | add `ws_` claim | **kept** until all in-flight tokens age out |
| Webhook envelope `tenant.orgId` | add `tenant.workspaceId` | **kept** — external subscribers already store it; removing it is breaking |
| Audit/event taxonomy `org.*` | — | **kept** (WS D3) — do not fork to `workspace.*`; add the `ws_` id to envelopes for search |
| DB columns / internal svc-to-svc | — | **kept** — `org_id`-everywhere is untouched (no remodel) |

## 8. The Account layer (Stage 0 → 1 → 2)

Today "Account" is a **derived role** (the org at `parent_org_id IS NULL`) that owns
billing/integration/usage by *upward resolution*, with no entity, no account-owned
config, and no account-level role. The scenarios that pull on it — account-wide
settings, an admin portal, account-managed/inherited workspaces, teams — are the same
move: promoting the Account to own state and authority. The ladder:

| Stage | Account owns | New mechanism | Cost |
|-------|--------------|---------------|------|
| **0 (shipped)** | billing, GitHub conn, usage (by upward resolution) | — | — |
| **1 (this epic)** | + account-wide config/defaults, + account-scoped roles, + admin portal | resolution **chain** + `scope_kind='account'` + policy cascade | low, additive |
| **2 (deferred)** | + own identity/settings/policy guardrails/teams-as-level/>2 depth | `accounts` table, `account_id` FK on every org, real `acct_` id | migration |

### 8.1 The scope-resolution chain (Stage 1b — WID7)

Generalize the existing config nesting (`config.settings` keyed `(org_id, project_id?,
environment_id?)`) and the `effectiveBillingOrg` up-resolution into one chain:

```
environment → project → workspace → account → system default
(most specific wins; fall back upward until a value is found)
```

Account-wide config is a value set at the `account` rung that every workspace inherits.
Each concern declares its inheritance mode:

- **default (overridable):** account sets a value a workspace may override (settings,
  branding, defaults);
- **guardrail (locked):** account sets a ceiling a workspace **cannot** override (the
  AWS *SCP* model — security, compliance, allowed regions). Expressed as
  `overridable: true|false` on the account-scope value.

> Prefer **resolve-up at read time** over MO3-style **copy-down** for config/policy so
> the account stays the single source of truth and changes propagate instantly; new
> workspaces inherit with zero backfill. (MO3 entitlement fan-out remains copy-down;
> converging the two is a non-blocking follow-up.)

### 8.2 Account-scoped RBAC (Stage 1a — WID6)

An admin portal means "administer workspaces I am not a member of", which breaks
today's invariant (the policy engine denies unless the actor holds a role in the
*specific* org: `relevantFacts = memberships.filter(scope.orgId === orgId)`). Stage 1a:

1. add **`scope_kind = 'account'`** to `membership.role_assignments` (it already has
   `organization` and `project`), with roles `account_owner` / `account_admin` /
   account-scoped `billing_admin`;
2. **cascade** in the policy engine: when authorizing an action on workspace `X`, also
   honor account-scoped facts where `X.accountId` matches — so `account_admin` ⟹ admin
   on every workspace in the account without per-workspace rows.

This is the standard AWS/GCP "org admin inherits down" model and is the prerequisite
`saas-teams` (TM) builds on.

### 8.3 Stage 2 (deferred — WID8)

Promote Account to a first-class `accounts` table with `account_id` on every org and a
**real** `acct_` id. This is needed only when account-owned state outgrows "config on
the parent org", when guardrails need their own home, or when nested depth / teams-as-
hierarchy-level (Account→Team→Workspace, beyond today's 2-level `parent_org_id`) is
required. The earlier decisions make this smooth: `accountId` simply repoints from
"parent's id" to "the account row's id", and `acct_` graduates from an alias of the
parent's `ws_` (W3) to the `accounts` table's own id — no consumer churn, no id
rewrite (because role was never in the id).

## 9. What deliberately does NOT change

- No removal of `org_<hex>`, the UUID PKs, `/v1/organizations/*`, or `org.*` events.
- No `org_id` rename across the ~40 tables / 12 bounded contexts — there is no DB RLS;
  app-level `org_id` scoping in every query stays exactly as-is.
- No billing behavior change; `effectiveBillingOrg`/fan-out/plan catalog untouched.
- No tenancy-tree deepening at Stage 1 (parent/child only); Teams arrive as
  *principals* (→ `saas-teams`), not as a hierarchy level.
