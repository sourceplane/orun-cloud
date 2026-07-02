---
title: Workspaces (organizations)
description: Create, list, and read workspaces; enumerate an Account's child workspaces; and inspect effective access with grant provenance.
---

A **workspace** is the tenancy boundary of Orun Cloud — every project, member, secret, and audit entry belongs to exactly one. The API canonically calls a workspace an **organization** and serves it at `/v1/organizations/*`; `/v1/workspaces/*` is an accepted alias for the same handlers. **Accounts** are parent organizations whose account-scoped roles cascade to their child workspaces. For the model, see [Workspaces](/platform/workspaces/organizations).

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/v1/organizations` | authenticated actor | Create a workspace; the creator becomes its first member |
| `GET` | `/v1/organizations` | authenticated actor | List the workspaces the caller belongs to |
| `GET` | `/v1/organizations/{orgId}` | `organization.read` | Get one workspace |
| `GET` | `/v1/organizations/{orgId}/workspaces` | `organization.member.list` | List an Account's child workspaces |
| `GET` | `/v1/organizations/{orgId}/effective-access` | none (self); `organization.member.list` (another subject) | Effective permissions on the workspace, with `via` provenance |

## Workspace references in paths

The `{orgId}` segment accepts three spellings, all resolved at the edge before routing:

| Form | Example | Stability |
|---|---|---|
| `org_…` | `org_1f6a3c9e` | Legacy opaque id — permanent |
| `ws_…` | `ws_a1b2c3d4` | Immutable public **Workspace ID** — safe to commit and automate |
| slug | `acme` | Mutable vanity label — can be renamed |

An unresolvable `ws_`/slug reference returns `404 not_found`. Requests to `/v1/workspaces/*` are rewritten to `/v1/organizations/*` and their JSON responses additionally carry `workspaceId` next to every `orgId` — the two surfaces are otherwise identical.

## Create a workspace

```bash
curl -X POST "https://api.orun.dev/v1/organizations" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 8b6f1c2e-create-acme" \
  -d '{ "name": "Acme", "slug": "acme" }'
```

`slug` is optional — one is derived from `name` when omitted.

```json
{
  "data": {
    "organization": {
      "id": "org_1f6a3c9e",
      "name": "Acme",
      "slug": "acme",
      "workspaceRef": "ws_a1b2c3d4",
      "accountId": "ws_a1b2c3d4",
      "kind": "account",
      "isAccountRoot": true,
      "createdAt": "2026-07-02T09:15:00.000Z"
    },
    "membership": { "role": "owner", "joinedAt": "2026-07-02T09:15:00.000Z" }
  },
  "meta": { "requestId": "req_7a6b5c4d3e2f", "cursor": null }
}
```

`accountId` is the owning Account's `ws_…` id; it equals the workspace's own `workspaceRef` exactly when the workspace is an Account root.

## Get a workspace by any reference

```bash
curl "https://api.orun.dev/v1/organizations/ws_a1b2c3d4" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "organization": {
      "id": "org_1f6a3c9e",
      "name": "Acme",
      "slug": "acme",
      "workspaceRef": "ws_a1b2c3d4",
      "accountId": "ws_a1b2c3d4",
      "kind": "account",
      "isAccountRoot": true,
      "createdAt": "2026-07-02T09:15:00.000Z"
    }
  },
  "meta": { "requestId": "req_9c8d7e6f5a4b", "cursor": null }
}
```

To enumerate the child workspaces under an Account:

```bash
curl "https://api.orun.dev/v1/organizations/ws_a1b2c3d4/workspaces" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "workspaces": [
      { "orgId": "org_44e0b7a1", "workspaceRef": "ws_f9e8d7c6", "name": "Acme Staging" }
    ]
  },
  "meta": { "requestId": "req_2b3c4d5e6f7a", "cursor": null }
}
```

## Inspect effective access

`GET /v1/organizations/{orgId}/effective-access` returns the caller's permitted actions, each carrying `via` provenance (`direct`, `team`, or `account_cascade`). Optional query parameters: `projectId` narrows the resource scope; `subjectId` inspects another subject's access (requires `organization.member.list`).

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

// List my workspaces, then check what I can do in the first one.
const { organizations } = await client.organizations.list();
const access = await client.teams.effectiveAccess(organizations[0]!.id);
for (const p of access.permissions) {
  if (p.allow) console.log(p.action, "via", p.via?.kind ?? "direct");
}
```

## Related

- [Workspaces](/platform/workspaces/organizations)
- [RBAC](/platform/access-control/rbac)
- [Members & invitations API](/api/resources/members-and-invitations)
- [Vocabulary](/getting-started/vocabulary)
