# Epic program: teams-platform

Status: **Holding register / program index** — the world-class Teams program. The
per-milestone bodies live in the five `teams-*` epics indexed below; this file is the
entry point (thesis + the three planes + sequencing + the keystone decisions).

**Turn Teams from an RBAC principal into the product's primary human-scale organizing
primitive — an *access* principal, an *ownership* grain, and a *collaboration* hub — the
way Datadog Teams is the connective tissue of Datadog.** The existing
[`saas-teams`](../saas-teams/) epic (**TM**) ships the cheapest, most mechanical slice:
Team as a *grantable principal*. That is correct Stage-1 sequencing but it is ~20% of
what people mean by "Datadog Teams." This program builds the other 80% **without a
tenancy remodel** — it never deepens the `Account → Workspace` tree.

## Why now / the core insight

The **Account is only a reference** (`parent_org_id`, resolved by
`effectiveBillingOrgId` — `specs/core/vocabulary.md`), not a first-class hierarchy node
with its own entity or surfaces. That leaves the tree with **no human-scale organizing
unit** between the thin Account and its many Workspaces. Datadog faced the identical
shape (a Datadog *org* is the tenant; there is no sub-org hierarchy) and answered it by
making **Teams the connective tissue** — precisely *because* a Team is orthogonal to
tenancy. So the account being thin is not the obstacle to great Teams; it is the reason
Teams must carry this weight. The minimalism in **TM** was an engineering-cost decision
(additive, no remodel), **not** a product ceiling.

We keep TM's locked decision — **a Team is a principal, not a hierarchy level** (that is
`saas-workspace-id` Stage 2, and stays rejected) — and grow the *meaning* of the
principal along three planes.

## The three planes (the mental model of the designer who built Datadog Teams)

A world-class Team answers three questions for every engineer, in the order Datadog
actually built them:

| Plane | The question | Datadog analogue | This program |
|-------|--------------|------------------|--------------|
| **Ownership** | "What's ours?" | every asset carries a team; "My Teams" filters the whole product | [`teams-ownership`](../teams-ownership/) (**TO**) |
| **Collaboration / Ops** | "Who do we reach?" | `@team` routing, on-call/escalation | [`teams-collaboration`](../teams-collaboration/) (**TC**) |
| **Hub** | "How are we doing?" | the team page: our services, health, deploys, on-call | [`teams-hub`](../teams-hub/) (**TH**) |
| **Access** | "What can we touch?" | team-based grants / team scopes — wired *last* at Datadog | [`saas-teams`](../saas-teams/) (**TM**) + [`teams-foundation`](../teams-foundation/) (**TF**) |

Access is the *foundation*, not the value. TM ships it; **TF** promotes the bare
principal into a first-class **entity** (handle, description, self-management, provenance)
so the other planes have something real to hang on.

## The epics

| Epic | Cluster | Plane | Status | What it is |
|------|---------|-------|--------|------------|
| [`teams-foundation/`](../teams-foundation/) | **TF** | Access (entity) | ✅ Shipped | Promote Team from grantable principal → first-class **entity**: `team_` public id + handle/name/description/avatar, **team-level roles** (`team_admin`/`team_member`) for self-management, effective-access + provenance surface, and `team.*` audit/events everywhere. Rides **TM** (which stays the access-grant slice). |
| [`teams-ownership/`](../teams-ownership/) | **TO** | Ownership | Draft | The keystone: an **owner-handle → Team resolver** (account-authored map; **respects** the `18-state` *derived-never-authored* catalog invariant), catalog owner resolution + real `group-by: team`, and a **"My Teams / My Services"** lens across catalog + the flat Activities feed. |
| [`teams-hub/`](../teams-hub/) | **TH** | Hub + account surface | Draft | Thicken the **account *surface*** (not the tree): an **Account Hub** (members · teams · account-roles · workspaces · usage rollup) to host account-spanning objects, the **Team Page** (owned services across workspaces, health, deploys, members), the **cross-workspace aggregation** read layer, and multi-workspace grant management (the "add a team to N chosen workspaces from the account" action). |
| [`teams-collaboration/`](../teams-collaboration/) | **TC** | Collaboration / Ops | Draft | Team as **notification target** (`subjectKind='team'`, expand-to-members at enqueue, team-default + member-override prefs), `@team` handles, event→owning-team **routing** (deploy failure on an owned service pages its team), and **team-scoped on-call/escalation defaults** (promote SC6 entity annotations to team-level with entity override). |
| [`teams-governance/`](../teams-governance/) | **TG** | Enterprise governance | Draft (mostly ⛔-gated) | **SCIM/SAML group → team** membership sync (gated on `saas-baseline` **B10**), **team-scoped visibility / restriction** (the allow-only-engine ceiling → a deny/ABAC decision), **custom roles + team-scoped grants**, and lifecycle governance (archival, ownership transfer, access reviews/attestation). |

## The two keystone architectural ideas

Everything downstream depends on these; they are elaborated in each epic's `design.md`.

1. **Owner-handle → Team resolver — reconcile git-ownership with the entity without
   breaking the invariant.** The catalog is *derived, never authored*
   (`specs/components/18-state.md`): the console may never write catalog content. But it
   *may* own a **mapping** from a git-authored owner handle (`owner: team-payments`) to a
   `team_` entity id — that map is org metadata, not catalog content, so the invariant
   holds. This is Backstage's `group:team-x` → entity-ref model. Landing it turns the
   flat `owner` string into a real Team and unlocks ~70% of "Datadog Teams" (My Services,
   team pages, ownership scorecards, team-routed notifications) **without touching the
   catalog projection.** Owned by **TO**.

2. **Thicken the account *surface*, not the *tree*.** A Team is account-owned and spans
   Workspaces (correct — mirrors a Datadog team spanning the org), but the account has
   almost no console home today (no account page, no account-members page). Do **not**
   add an `Account → Team → Workspace` level. Instead build an **Account Hub** as the
   surface that hosts account-spanning objects. Teams is the feature that finally
   justifies the account surface **WID6/WS** left thin. Owned by **TH**;
   `list-account-workspaces` (IT12) is the existing picker seam.

## Read order

1. `README.md` (this file) — the program thesis, the three planes, the keystones.
2. [`teams-foundation`](../teams-foundation/) — the entity the other planes need.
3. [`teams-ownership`](../teams-ownership/) — the resolver keystone + the ownership lens.
4. [`teams-hub`](../teams-hub/) — the account surface + team page + cross-workspace reads.
5. [`teams-collaboration`](../teams-collaboration/) — notifications, mentions, on-call.
6. [`teams-governance`](../teams-governance/) — SCIM sync, restriction/ABAC, lifecycle.

## Sequencing

```
WID6 (shipped) → saas-teams TM1–TM6 (access grants)
                       │
                       ▼
                 TF (entity)  ──►  TO (ownership + resolver)  ──►  ┌ TH (hub + account surface)
                                                                    └ TC (notifications + on-call)
                                                                           │
                                                                           ▼
                                                                    TG (SCIM · restriction · lifecycle)
```

- **TF → TO is the critical path.** TO's resolver needs TF's entity + handle.
- **TH and TC parallelize** after TO (both consume "the team's owned services").
- **TG is enterprise long-tail**: TG1 (SCIM) is ⛔ on **B10**; TG2 (restriction) needs a
  deliberate engine evolution (the allow-only union cannot express "team sees only its
  own") and is the one place this program may touch `packages/policy-engine`.

## Hard constraints this program must design around (see per-epic risks)

- **Allow-only union engine** (`packages/policy-engine`): grants compose, but the engine
  **cannot restrict**. Datadog-grade least-privilege ("this team sees *only* its
  resources") is a **TG** engine decision, not additive.
- **Catalog is git-authored / derived-never-authored** (`18-state`): ownership binds via
  the **resolver map**, never by writing catalog content.
- **Account surface is the real prerequisite** for hosting Teams — budgeted inside **TH**.
- **Cross-workspace aggregation** is a new read pattern: catalog + runs are per-org
  indexed; team pages fan out across the account's Workspace set.
- **SCIM/SSO is gated on B10** (⛔ in `saas-baseline`) — manual teams first, sync later.

## Relationship to existing work

- **`saas-teams` (TM)** — the access-grant slice; **TF** builds directly on it (the
  `team_` id TM grants becomes TF's entity id). TM is **not** superseded; it is Plane A.
- **`saas-workspace-id` (WID)** — supplies account ownership + the RBAC cascade (WID6,
  shipped); **TH** thickens the account surface WID left thin.
- **`saas-service-catalog` / `saas-catalog-portal` (SC/CP)** — **TO** consumes the
  `owner` field, the `group-by: team` dimension, SC6 annotations, and the SC8 "My
  Services" intent, resolving them onto real Team entities.
- **`saas-baseline` (B)** — **TC** rides B2 notifications; **TG** rides B10 SSO/SCIM.
