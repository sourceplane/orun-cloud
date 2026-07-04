# Epic: teams-foundation (TF)

**Promote a Team from a *grantable principal* into a first-class *entity*** — with a
public id, a stable handle, a name/description/avatar, **team-level roles** so a team can
be self-managed, an **effective-access + provenance** surface, and `team.*` audit/events
on every mutation. `saas-teams` (**TM**) makes a team something you can *grant a role to*;
**TF** makes a team something the rest of the product can *point at, own things with, and
notify*. TF is the substrate the ownership / hub / collaboration planes all consume.

Part of the [`teams-platform`](../teams-platform/) program. **Plane: Access (entity).**

## Status

| Field | Value |
|-------|-------|
| Status | **✅ Shipped** (TF1–TF5) — additive over `saas-teams` **TM**: enriches the entity and its management without re-modelling grants. As-built in [`IMPLEMENTATION-STATUS.md`](./IMPLEMENTATION-STATUS.md). |
| Cluster | **TF** (teams-foundation — the entity) |
| Owner(s) | `packages/db` (schema) · `apps/membership-worker` (team CRUD + team-role checks) · `apps/api-edge` + `packages/contracts`/`sdk`/`cli` · `apps/web-console-next` |
| Builds on | `saas-teams` **TM** (`membership.teams`, `membership.team_members`, `subject_type='team'` in `role_assignments`, the authz-context expansion); `saas-workspace-id` **WID6** (account RBAC — who may manage teams); the existing member-management console chrome |
| Decisions locked | (1) A Team is a **first-class entity**, not just a grant subject — it gains a handle + profile; (2) **two role planes**: *team-management* roles (`team_admin`/`team_member`, govern the team object) are **distinct** from the *platform* roles a team is granted (`role_assignments`) — a team admin manages membership, an account/workspace admin decides what the team can *do*; (3) grants and all external references bind to the **immutable `team_` id**, never the mutable handle/slug; (4) provenance is first-class — every effective permission is traceable to its source grant. |
| Gate | Confirm TF-A (handle namespace/format), TF-B (who may create teams — account-admin only vs delegated), TF-C (self-service join for "open" teams — Datadog parity vs closed-only at v1). See `risks-and-open-questions.md`. |

## Thesis

TM answers "*can* a team hold a role?" TF answers "*what is a team*?" — because the
ownership, hub, and collaboration planes cannot exist over a bare `(team_id, name)` row.
They need: a **handle** (`@payments`) to mention and to map git ownership onto; a
**profile** (description, avatar) for a team page; a **membership model with its own
roles** so teams don't require an account admin for every add/remove; and **provenance**
so union-over-teams access stays legible. TF is deliberately small per-item but it is the
hinge the whole program swings on.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| TF1 | **Team entity**: `team_` public id + `handle` (account-unique, immutable-preferred) + `name`/`description`/`avatar`; profile CRUD | ✅ Shipped |
| TF2 | **Team-management roles**: `team_admin`/`team_member` on `team_members`; team-self-management authority distinct from platform-grant authority | ✅ Shipped |
| TF3 | **Access-principal integration**: verify TM grants bind to the `team_` entity id; the entity is the single subject of `subject_type='team'` rows | ✅ Shipped |
| TF4 | **Effective-access + provenance**: "who can do what here, via which team/grant" + `grantedVia` on every listed grant (promotes `saas-teams` TM6) | ✅ Shipped |
| TF5 | **Audit/events**: emit `team.*` on create/update/delete/member-add/remove/role-change/grant/revoke | ✅ Shipped |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| Team entity (handle + profile), team-management roles, provenance/effective-access surface, `team.*` audit, CRUD across console/SDK/CLI | Owner-handle → team **resolution** (→ **TO**); notification routing (→ **TC**); team pages / cross-workspace aggregation (→ **TH**); SCIM sync + restriction/custom-roles (→ **TG**); nested teams / teams-as-level (stays deferred to WID Stage 2) |

## Read order

1. `README.md` — the entity thesis + the two-role-planes decision.
2. `design.md` — the schema deltas over TM, the two authority planes, provenance model.
3. `implementation-plan.md` — TF1–TF5 with "done when".
4. `risks-and-open-questions.md` — handle namespace, create authority, open-join.
