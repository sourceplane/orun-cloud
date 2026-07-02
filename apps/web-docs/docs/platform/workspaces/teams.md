---
title: Teams
description: Account-owned teams as first-class RBAC subjects — membership, role grants, and provenance.
---

A **team** is a named group of subjects (`team_<hex>`) that can hold role grants of its own. Instead of assigning `builder` to forty engineers one by one, you grant it once to the platform team — members inherit the team's roles for as long as they're on the team, and authorization decisions record that the access came *via the team*.

Teams are **account-owned**: they live on the account (parent organization) and can be granted roles at account, workspace, or project scope. Team management therefore requires authority on the account — a workspace-only admin cannot create or edit teams.

## Manage teams

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/v1/organizations/{orgId}/teams` | `team.create` | Create a team (`name`, optional `slug`) |
| `GET` | `/v1/organizations/{orgId}/teams` | `organization.member.list` | List the account's teams |
| `GET` | `/v1/organizations/{orgId}/teams/{teamId}` | `organization.member.list` | Get one team |
| `PATCH` | `/v1/organizations/{orgId}/teams/{teamId}` | `team.update` | Rename / re-slug |
| `DELETE` | `/v1/organizations/{orgId}/teams/{teamId}` | `team.delete` | Delete the team |

```bash
curl -X POST https://api.orun.dev/v1/organizations/ws_a1b2c3d4/teams \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Platform", "slug": "platform"}'
```

```json
{
  "data": {
    "team": {
      "id": "team_3c2b1a09f8e7d6c5b4a3928170654e3d",
      "name": "Platform",
      "slug": "platform",
      "status": "active",
      "createdAt": "2026-07-02T12:00:00.000Z"
    }
  },
  "meta": { "requestId": "req_4c5d6e7f8a9b", "cursor": null }
}
```

```ts
const { team } = await client.teams.createTeam(orgId, { name: "Platform" });
const { teams } = await client.teams.listTeams(orgId);
await client.teams.updateTeam(orgId, team.id, { name: "Platform Eng" });
await client.teams.deleteTeam(orgId, team.id);
```

Any workspace reference under the account works in the path — teams resolve to the account root.

## Manage team membership

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/v1/organizations/{orgId}/teams/{teamId}/members` | `organization.member.list` | List team members |
| `POST` | `/v1/organizations/{orgId}/teams/{teamId}/members` | `team.member.add` | Add a subject (`subjectId`, optional `subjectType`, default `user`) |
| `DELETE` | `/v1/organizations/{orgId}/teams/{teamId}/members/{subjectId}` | `team.member.remove` | Remove a subject |

```ts
await client.teams.addTeamMember(orgId, teamId, { subjectId: "usr_7a6b5c4d…" });
const { members } = await client.teams.listTeamMembers(orgId, teamId);
await client.teams.removeTeamMember(orgId, teamId, "usr_7a6b5c4d…");
```

Service principals can be team members too (`subjectType: "service_principal"`), so a team grant can cover automation alongside its human owners.

## Grant roles to a team

Team role grants are the point of the feature: the team becomes the subject of a role assignment, at any of the three scopes.

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/v1/organizations/{orgId}/team-roles` | `team.role.grant` | Grant `{teamId, role, scopeKind, scopeRef?}` |
| `DELETE` | `/v1/organizations/{orgId}/team-roles` | `team.role.grant` | Revoke the same tuple |

`scopeKind` is `account`, `organization` (a workspace), or `project` — `scopeRef` names the project when `scopeKind` is `project`.

```bash
curl -X POST https://api.orun.dev/v1/organizations/ws_a1b2c3d4/team-roles \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"teamId": "team_3c2b1a09f8e7d6c5b4a3928170654e3d", "role": "builder", "scopeKind": "organization"}'
```

```json
{
  "data": {
    "grant": { "teamId": "team_3c2b1a09f8e7d6c5b4a3928170654e3d", "role": "builder", "scopeKind": "organization", "scopeRef": null }
  },
  "meta": { "requestId": "req_5d6e7f8a9b0c", "cursor": null }
}
```

```ts
await client.teams.grantTeamRole(orgId, { teamId, role: "builder", scopeKind: "organization" });
await client.teams.revokeTeamRole(orgId, { teamId, role: "builder", scopeKind: "organization" });
```

:::tip
Manage access at team granularity end to end: onboarding is `team member-add`, offboarding is `team member-remove` — no per-workspace role edits. Direct member roles still work and union with team grants; the effective permission set is the union of everything the subject holds.
:::

## Provenance: decisions show the team path

Authorization facts assembled for a team member carry their origin, and allowed decisions report it as `via` — `{ "kind": "team", "teamId": "team_…" }` — alongside `direct` and `account_cascade`. The [effective-access endpoint](/platform/workspaces/members-and-invitations) renders this per action, so "why does Sam have `project.create` here?" is answerable without spelunking role tables. Provenance is reporting only; it never changes the decision.

Team lifecycle changes (`team.created`, `team.member.added`, `team.role` grants, …) are recorded in the workspace [audit log](/platform/audit/audit-log).

## Teams from the CLI

The `orun-cloud` CLI mirrors the whole surface:

```bash
orun-cloud team list
orun-cloud team create "Platform" --slug=platform
orun-cloud team get team_3c2b1a09… 
orun-cloud team update team_3c2b1a09… --name="Platform Eng"
orun-cloud team members team_3c2b1a09…
orun-cloud team member-add team_3c2b1a09… usr_7a6b5c4d… 
orun-cloud team member-remove team_3c2b1a09… usr_7a6b5c4d…
orun-cloud team grant team_3c2b1a09… --role=builder --scope=organization
orun-cloud team revoke team_3c2b1a09… --role=builder --scope=organization
orun-cloud team access            # your own effective access, with via provenance
orun-cloud team delete team_3c2b1a09…
```

All commands accept `--org=ORG_ID` to override the active workspace and `--output=json` for scripting.

## Related

- [Members & invitations](/platform/workspaces/members-and-invitations)
- [Access control (RBAC)](/platform/access-control/rbac)
- [Workspaces & accounts](/platform/workspaces/organizations)
- [Teams API reference](/api/resources/teams)
