---
title: Teams
description: Create and manage account-owned teams, add and remove team members, and grant or revoke role grants held by a team.
---

A **team** is an account-owned group of subjects (users or service principals) that can hold role grants of its own — grant a role to the team once and every team member exercises it, with `via: { kind: "team" }` provenance in authorization decisions. Teams are managed through the owning workspace's `/v1/organizations/{orgId}/…` surface. For the model, see [Teams](/platform/workspaces/teams).

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/v1/organizations/{orgId}/teams` | `organization.member.list` | List teams |
| `POST` | `/v1/organizations/{orgId}/teams` | `team.create` | Create a team |
| `GET` | `/v1/organizations/{orgId}/teams/{teamId}` | `organization.member.list` | Get a team |
| `PATCH` | `/v1/organizations/{orgId}/teams/{teamId}` | `team.update` | Rename a team or change its slug |
| `DELETE` | `/v1/organizations/{orgId}/teams/{teamId}` | `team.delete` | Delete a team |
| `GET` | `/v1/organizations/{orgId}/teams/{teamId}/members` | `organization.member.list` | List team members |
| `POST` | `/v1/organizations/{orgId}/teams/{teamId}/members` | `team.member.add` | Add a subject to the team |
| `DELETE` | `/v1/organizations/{orgId}/teams/{teamId}/members/{subjectId}` | `team.member.remove` | Remove a subject from the team |
| `POST` | `/v1/organizations/{orgId}/team-roles` | `team.role.grant` | Grant the team a role at a scope |
| `DELETE` | `/v1/organizations/{orgId}/team-roles` | `team.role.revoke` | Revoke a team role grant (grant tuple in the body) |

Team ids are `team_…`. Role grants target `scopeKind` `account`, `organization` (workspace), or `project` — `scopeRef` (the project id) is required when `scopeKind` is `project`.

## Create a team and add members

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f6a3c9e/teams" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-team-platform-01" \
  -d '{ "name": "Platform", "slug": "platform" }'
```

```json
{
  "data": {
    "team": {
      "id": "team_7c6d5e4f",
      "name": "Platform",
      "slug": "platform",
      "status": "active",
      "createdAt": "2026-07-02T09:20:00.000Z"
    }
  },
  "meta": { "requestId": "req_5e6f7a8b9c0d", "cursor": null }
}
```

Add a member (`subjectType` defaults to `"user"`; use `"service_principal"` for an API key's principal):

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f6a3c9e/teams/team_7c6d5e4f/members" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "subjectId": "usr_9f8e7d6c" }'
```

```json
{
  "data": {
    "member": {
      "subjectId": "usr_9f8e7d6c",
      "subjectType": "user",
      "status": "active",
      "createdAt": "2026-07-02T09:21:00.000Z"
    }
  },
  "meta": { "requestId": "req_6f7a8b9c0d1e", "cursor": null }
}
```

Remove with `DELETE …/teams/{teamId}/members/{subjectId}`.

## Grant and revoke team roles

Grant the team a role at a scope; every member then holds it via the team:

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f6a3c9e/team-roles" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "teamId": "team_7c6d5e4f",
    "role": "project_builder",
    "scopeKind": "project",
    "scopeRef": "prj_2d3e4f5a"
  }'
```

```json
{
  "data": {
    "grant": {
      "teamId": "team_7c6d5e4f",
      "role": "project_builder",
      "scopeKind": "project",
      "scopeRef": "prj_2d3e4f5a"
    }
  },
  "meta": { "requestId": "req_7a8b9c0d1e2f", "cursor": null }
}
```

:::note
Revocation is a `DELETE /v1/organizations/{orgId}/team-roles` carrying the same grant tuple (`teamId`, `role`, `scopeKind`, `scopeRef`) in its request body — there is no per-grant id in the path.
:::

## Manage teams with the SDK

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const { team } = await client.teams.createTeam("org_1f6a3c9e", { name: "Platform" });
await client.teams.addTeamMember("org_1f6a3c9e", team.id, { subjectId: "usr_9f8e7d6c" });

await client.teams.grantTeamRole("org_1f6a3c9e", {
  teamId: team.id,
  role: "builder",
  scopeKind: "organization",
});

// Later: revoke the same tuple.
await client.teams.revokeTeamRole("org_1f6a3c9e", {
  teamId: team.id,
  role: "builder",
  scopeKind: "organization",
});
```

## Related

- [Teams](/platform/workspaces/teams)
- [RBAC](/platform/access-control/rbac)
- [Members & invitations API](/api/resources/members-and-invitations)
- [Workspaces API](/api/resources/organizations)
