# saas-workspace-id — Risks & Open Questions

Live register for the durable-id + account-layer epic. The id track is additive and
back-compatible (no data is removed), so its risks are about a **published-contract
change** and **dual-id maintenance**; the account-layer risks are about **authority
cascade** and **inheritance semantics**. Confirm the ⛔ items before the corresponding
milestone lands.

## ⛔ Still open — confirm before building

| # | Question | Default lean |
|---|----------|--------------|
| **W2** | **Repoint vs add.** `saas-workspaces` published `workspaceId == org_<hex>` (D2/D4). Do we **repoint** `workspaceId` to the `ws_` value (exposing `org_<hex>` as a separate legacy field), or **add** a new field (`workspaceRef`) and leave `workspaceId` equal to `org_<hex>`? | **Repoint** — make `ws_…` *the* Workspace ID; amend `api-guidelines` D2/D4. Cleanest long-term; one published-contract change. |
| **W3** | **`acct_` for the Account.** Surface the Account's id with an `acct_` alias (= the parent's `ws_` value until Stage 2) on account-scoped billing/admin surfaces, or rely solely on the `accountId` field? | **Defer** — ship `accountId`+`kind` first; add `acct_` only if billing/support surfaces need the louder "Account" identity. Forward-compatible with Stage 2 either way. |
| **W4** | **`public_ref` body length / check char.** 8 base32 chars (~40 bits) vs 10 (~50 bits); append a check character? | **8 chars, no check char** to start; widen if collision-retry rate is ever non-trivial (it won't be at this scale). |
| **W5 (Stage 1)** | **Resolution direction** for config/policy: resolve-up-at-read vs copy-down (MO3-style fan-out)? | **Resolve-up** — single source of truth, instant propagation, zero backfill for new workspaces. |
| **W6 (Stage 1)** | **Account RBAC now or later?** Land `scope_kind='account'` + the policy cascade (WID6) as part of this epic, or split into its own program? | **In this epic (WID6)** — it is the admin-portal prerequisite and the gate `saas-teams` depends on. |

## ✅ Decisions made

| # | Decision | Resolution |
|---|----------|------------|
| W1a | **Prefix vs bare number** | **Prefixed `ws_`** (not a bare AWS-style number) — keeps the `usr_`/`prj_`/`org_` convention and preserves id-kind discrimination (audit envelopes, webhook payloads, `parseSubjectUuid`). |
| W1b | **Encoding** | **Crockford base32**, uppercase, excluding `I L O U` — typo-resistant and copy-safe. |
| W1c | **Immutability + storage** | **Immutable**, in a dedicated `public_ref` column — not a mutable slug, not a re-encoded UUID. |
| W1d | **No role in the id** | Account-vs-Workspace is **never** encoded in or parsed from the id; it is discoverable via `accountId` + derived `kind`/`isAccountRoot`. Rationale: role is mutable/relational and the parent is dual-role. |
| W1e | **`org_<hex>` retention** | **Kept indefinitely** as an accepted/returned alias (extends WS D4); `ws_…` is led-with, `org_<hex>` is never removed. |
| W1f | **Account-root invariant** | `accountId === workspaceId` ⟺ Account root. `accountId = effectiveBillingOrgId(org) = parentOrgId ?? id`. |

## Risks

| Risk | Mitigation |
|------|------------|
| **Published-contract change** — WS promised `workspaceId == org_<hex>`; leading with `ws_…` changes the narrative | Make it an explicit, recorded amendment (W2) to `api-guidelines` D2/D4; keep `org_<hex>` returned + accepted forever so no client breaks. |
| **Dual-id confusion** — `slug` + `ws_…` both look human | Doctrine: `slug` is **URL-only**; `ws_…` is the thing you quote/automate/commit. AWS proves the alias/account-id split works; lead docs + console copy with it. |
| **External consumers store `org_<hex>`** — webhook `tenant.orgId` has already left the system | **Never remove** `tenant.orgId`; only *add* `tenant.workspaceId`. Same for in-flight token claims — carry both until old tokens expire. |
| **Resolver hot-path cost** — one more lookup per request | `public_ref` is immutable → cache the `ws_ → uuid` map with no invalidation; unique index makes the miss path cheap. |
| **Enumerability** — a short id can look guessable | Generate **randomly** (not sequential — AWS account ids aren't either); treat as non-secret but unguessable; authority always comes from the resolved record + RBAC, never from holding the id. |
| **Authority cascade (Stage 1a)** — account roles granting workspace access is a real new power | Gate `scope_kind='account'` grants behind `account_owner`/`account_admin` only; policy tests must assert the cascade matches on `accountId` and still denies non-members by default. |
| **Inheritance footguns (Stage 1b)** — silent account-wide overrides | Make inheritance mode explicit (`overridable: true|false`); surface "inherited from Account" provenance in the console; locked values clearly marked. |

## Non-blocking notes

- **No data migration beyond `public_ref`:** every `org_id` column, the UUID PKs, and
  all billing behavior are untouched; the id track is column-add + backfill + alias.
- **Cross-repo coordination:** the `intent.yaml`/CLI `ws_` acceptance (WID5) is owned
  with `saas-orun-platform` (DV5), exactly as WS3 was — do not fork the tenancy
  precedence chain in `sourceplane/orun`.
- **Stage 2 is deliberately deferred:** the `accounts` entity (WID8) is scoped only
  when a concrete driver (nested depth, account-owned policy home, teams-as-level)
  exists; the W1d "no role in id" + W3 `acct_`-alias decisions keep that migration
  id-churn-free.
- **`saas-teams` dependency:** TM (Stage-1 teams) consumes WID6's `scope_kind='account'`
  RBAC + cascade; sequence WID6 before the TM authz milestone.
