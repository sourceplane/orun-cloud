---
title: Access control (RBAC)
description: Deny-by-default role-based access control across accounts, workspaces, projects, and teams — with explainable, provenance-carrying decisions.
---

Orun Cloud authorizes every request with **deny-by-default RBAC**. A **permission** is an explicit action string (`project.create`, `billing.manage`, `audit.read`); a **role** is a named bundle of permissions granted at a **scope** — an account, a workspace, or a project. An action is allowed only when the caller holds a role, at a matching scope, whose permission set contains that exact action string. Unknown actions, missing scopes, and missing grants are all denials.

Every decision is explainable: allows carry the reason (which role matched) and a `via` block recording **how** the grant reached the actor — directly, through a [team](/platform/workspaces/teams), or cascaded from the parent account.

## The model

- **Permissions** are dotted action strings from a closed catalog. Requests naming an action outside the catalog are denied (`unknown_action`) — new surfaces are deny-by-default until their actions are added.
- **Roles** are static permission sets evaluated by the policy engine. There are three role families, one per scope kind.
- **Scopes** nest: account → workspace → project. A role granted at a scope confers authority at that scope and below (account roles cascade to every child workspace; workspace roles cover all projects in the workspace; project roles cover one project).
- **Project-scoped actions** (`project.read`, `environment.create`, `project.config.write`, …) require the request to name a project; without one they are denied with `invalid_scope`, even for workspace owners.

:::note
On tenant-scoped resources, an authorization denial surfaces as `404 not_found` rather than `403 forbidden` — the API does not reveal whether a resource you cannot access exists.
:::

## Workspace roles

Granted to a member (or team) on a single workspace.

| Role | Intended for | Summary |
|---|---|---|
| `owner` | Workspace owners | Everything, including `billing.read` / `billing.manage`, member and team management, config and secret writes, integrations, state-plane writes |
| `admin` | Day-to-day administrators | Everything `owner` has **except** billing management |
| `builder` | Engineers shipping work | Create/update projects and environments, read config, `secret.value.use`, state-plane reads and writes, catalog publish, CLI linking |
| `viewer` | Read-only access | Read projects, environments, config metadata, webhooks, metering, state runs and objects |
| `billing_admin` | Finance | `organization.read`, `billing.read`, `billing.manage` — nothing else |

## Project roles

Granted on a single project inside a workspace. Use these to give someone authority over one project without workspace-wide rights.

| Role | Summary |
|---|---|
| `project_admin` | Full control of the project: update/delete, environments (create through delete), project config writes, project webhooks, repo links, and API-key management scoped to the project |
| `project_builder` | Update the project, create/update environments, read project config and webhooks |
| `project_viewer` | Read the project, its environments, project config, and webhooks |

Project roles only ever authorize project-scoped actions (plus API-key actions for `project_admin`), and only when the request names *their* project.

## Account roles

An **account** is a parent organization; its roles cascade to **every child workspace** under it. Each account role mirrors a workspace role's permission set:

| Role | Mirrors | Cascade effect |
|---|---|---|
| `account_owner` | `owner` | Full owner authority on every workspace in the account, including billing |
| `account_admin` | `admin` | Admin authority on every workspace — no billing management |
| `account_billing_admin` | `billing_admin` | Billing read/manage on every workspace |

See [Workspaces & organizations](/platform/workspaces/organizations) for the account/workspace hierarchy.

## Permissions

Permissions are exact strings — there are no wildcards. A representative sample of the catalog:

| Action | Grants | Held by |
|---|---|---|
| `project.create` | Create projects in the workspace | `owner`, `admin`, `builder` |
| `project.delete` | Archive a project | `owner`, `admin`, `project_admin` |
| `environment.create` | Create environments in a project | `owner`, `admin`, `builder`, `project_admin`, `project_builder` |
| `organization.member.update_role` | Change a member's workspace role | `owner`, `admin` |
| `organization.config.write` | Write workspace-scoped settings, flags, and secrets | `owner`, `admin` |
| `billing.manage` | Change plans, manage checkout and portal | `owner`, `billing_admin` |
| `audit.read` | Query the workspace audit log | `owner`, `admin` |
| `secret.value.use` | Use a secret's decrypted value at runtime (state plane) | `owner`, `admin`, `builder` |
| `organization.integration.token.issue` | Mint short-lived GitHub installation tokens | `owner`, `admin` |
| `state.run.write` | Create and update orun runs | `owner`, `admin`, `builder` |
| `team.role.grant` | Grant a role to a team | `owner`, `admin` |

(Account roles hold whatever their mirrored workspace role holds, on every child workspace.)

## Grant roles to teams

A [team](/platform/workspaces/teams) can hold role grants exactly like an individual member. Every member of the team receives the granted role's permissions, and decisions produced through a team grant are labeled with the team's id.

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f2e3d4c/team-roles" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: grant-platform-builders-1" \
  -d '{"teamId": "team_9a8b7c6d", "role": "builder", "scopeKind": "organization"}'
```

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

await client.teams.grantTeamRole("org_1f2e3d4c", {
  teamId: "team_9a8b7c6d",
  role: "builder",
  scopeKind: "organization",
});
```

Project-scoped grants pass `scopeKind: "project"` plus `scopeRef` (the project id); account-scoped grants pass `scopeKind: "account"`.

Revoking mirrors granting: `DELETE /v1/organizations/{orgId}/team-roles` with the same tuple in the body, or `client.teams.revokeTeamRole(...)`.

## Inspect effective permissions

**Effective access** answers "who can do what here, and via which grant". `GET /v1/organizations/{orgId}/effective-access` evaluates the full action catalog for a subject on a target scope. It defaults to the caller; pass `subjectId` to inspect another subject (requires member-list authority) and `projectId` to narrow to a project.

```bash
curl "https://api.orun.dev/v1/organizations/org_1f2e3d4c/effective-access?projectId=prj_5e6f7a8b" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "permissions": [
      { "action": "project.read", "allow": true, "reason": "org_builder", "via": { "kind": "team", "teamId": "team_9a8b7c6d" } },
      { "action": "environment.create", "allow": true, "reason": "org_builder", "via": { "kind": "team", "teamId": "team_9a8b7c6d" } },
      { "action": "billing.manage", "allow": false, "reason": "no_matching_role" },
      { "action": "audit.read", "allow": false, "reason": "no_matching_role" }
    ]
  },
  "meta": { "requestId": "req_b1c2d3e4f5a6", "cursor": null }
}
```

```ts
const { permissions } = await client.teams.effectiveAccess("org_1f2e3d4c", {
  projectId: "prj_5e6f7a8b",
});

const denied = permissions.filter((p) => !p.allow);
```

### Decision provenance (`via`)

Each allowed action carries a `via` block naming the origin of the permitting grant:

| `via.kind` | Meaning |
|---|---|
| `direct` | The role is assigned to the subject directly |
| `team` | The role reached the subject through a team grant; `via.teamId` names the team |
| `account_cascade` | The role cascaded from an account-level grant on the parent account |

`via` is reporting-only — it never changes the decision. It exists so union-over-teams and account cascade stay explainable when you're auditing who can do what.

## How enforcement works

Conceptually, every authorized request passes through three internal steps:

1. The **edge** authenticates the bearer token and resolves the acting subject (user, service principal, or workflow actor).
2. The owning service assembles the subject's **membership facts** for the target workspace — direct role assignments, team grants expanded to their members, and account-level grants remapped onto the target workspace.
3. The **policy engine** evaluates the facts against the requested action and scope, returning `allow`/`deny` with a reason, the policy version, the derived scope, and `via` provenance.

The policy service is **internal-only**: it has no public route and is reachable only over service bindings between Orun Cloud's own workers. You interact with it exclusively through the resources it protects and the `effective-access` read model.

## Choosing roles

Grant the least privilege that gets the job done:

- **Default new members to `viewer`** and promote deliberately. `viewer` can see projects, environments, config metadata, and state runs — enough to orient.
- **Use `builder` for engineers**, not `admin`. Builders can create projects and environments, run the state plane, and use secret values — without member management, config writes, or audit access.
- **Prefer project roles over workspace roles** when someone's work is confined to one project. `project_admin` on one project is far narrower than workspace `admin`.
- **Keep `owner` rare.** `admin` covers everything operational; the difference is billing. Give finance `billing_admin` instead of ownership.
- **Grant to teams, not individuals**, once more than a couple of people need the same access — membership changes then update access automatically, and `via` keeps the audit trail legible.
- **Use account roles sparingly** — they cascade to every current *and future* workspace under the account.

## Related

- [Teams](/platform/workspaces/teams)
- [Members & invitations](/platform/workspaces/members-and-invitations)
- [Workspaces & organizations](/platform/workspaces/organizations)
- [Security model](/security/security-model)
