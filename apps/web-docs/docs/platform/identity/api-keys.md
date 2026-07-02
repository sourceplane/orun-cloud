---
title: API keys
description: Workspace-scoped API keys backed by service principals — create, list, revoke, and rotate.
---

An **API key** is a workspace-scoped bearer credential for servers and automation. Every key is backed by a **service principal** — a non-human actor that holds exactly one role binding in the workspace's membership system. The key *is* the service principal's credential: authenticating with it makes the service principal the actor, and RBAC evaluates that actor like any other subject.

Keys are managed under the workspace: `/v1/organizations/{orgId}/api-keys`. The secret is generated server-side (`sk_` + 64 hex characters), stored only as a SHA-256 hash, and returned exactly once at creation. The stored **prefix** — the first 12 characters — is what list views show so you can tell keys apart.

## Create an API key

`POST /v1/organizations/{orgId}/api-keys` — requires the `organization.api_key.create` permission.

| Field | Required | Description |
|---|---|---|
| `label` | yes | Human name, ≤128 characters |
| `role` | yes | Role bound to the service principal (see below) |
| `projectId` | for project roles | Scopes the key to one project; required when `role` is `project_*` |
| `expiresAt` | no | ISO 8601 expiry; must be in the future |

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_1a2b3c4d5e6f70819203a4b5c6d7e8f9/api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "deploy-bot", "role": "builder", "expiresAt": "2027-01-01T00:00:00Z"}'
```

```json
{
  "data": {
    "apiKey": {
      "id": "d2f1e0c9-…",
      "label": "deploy-bot",
      "prefix": "sk_4f8a2b1c",
      "secret": "sk_4f8a2b1c9d…(64 hex chars)",
      "createdAt": "2026-07-02T12:00:00.000Z",
      "expiresAt": "2027-01-01T00:00:00.000Z",
      "servicePrincipal": {
        "id": "7c6b5a49-…",
        "displayName": "API Key: deploy-bot",
        "role": "builder",
        "projectId": null
      }
    }
  },
  "meta": { "requestId": "req_3d4e5f6a7b8c", "cursor": null }
}
```

```ts
const { apiKey } = await client.apiKeys.create(orgId, {
  label: "deploy-bot",
  role: "builder",
});
console.log(apiKey.secret); // store it now — never shown again
```

:::warning
`secret` appears **only** in the create response. It is hashed at rest and cannot be retrieved later. If you lose it, revoke the key and create a new one.
:::

## How a key authenticates

The transport is identical to a user session — plain `Authorization: Bearer`:

```bash
curl https://api.orun.dev/v1/organizations/org_1a2b3c4d5e6f70819203a4b5c6d7e8f9/members \
  -H "Authorization: Bearer sk_4f8a2b1c9d…"
```

The edge resolves the token: anything that doesn't parse as a `sps_ses_…` session token is hashed and looked up as an API key. A match yields an actor of type `service_principal`, pinned to the key's workspace (and project, if project-scoped). A revoked, expired, or inactive key resolves to `401 unauthenticated`.

Service principals cannot use user-only surfaces — for example, `PATCH /v1/auth/profile` rejects API keys.

## RBAC for service principals

Creating a key writes a **service-principal role binding** in the membership system: subject = the service principal, role = the requested role, scope = the workspace or one project. Policy decisions then treat the service principal exactly like a user member — deny-by-default, permissions derived from the bound role.

| Scope | Roles |
|---|---|
| Workspace | `owner`, `admin`, `builder`, `viewer`, `billing_admin` |
| Project | `project_admin`, `project_builder`, `project_viewer` |

Project-scoped keys are the least-privilege default for CI and per-service automation: a `project_builder` key cannot read or act outside its project.

:::tip
Grant the narrowest role that works. A key that only reads telemetry needs `viewer` (or `project_viewer`), not `builder`.
:::

## List keys

`GET /v1/organizations/{orgId}/api-keys` — permission `organization.api_key.list`. Supports `limit`, `cursor`, and a `projectId` filter. Responses never include secret material — only the prefix.

```ts
const { apiKeys } = await client.apiKeys.list(orgId);
// each: { id, label, prefix, createdAt, expiresAt, lastUsedAt, revokedAt, servicePrincipal }
```

`lastUsedAt` tells you whether a key is still live traffic before you revoke it.

## Revoke a key

`DELETE /v1/organizations/{orgId}/api-keys/{apiKeyId}` — permission `organization.api_key.revoke`. Revocation is immediate and permanent; re-revoking returns `409 conflict`.

```bash
curl -X DELETE https://api.orun.dev/v1/organizations/org_1a2b3c4d…/api-keys/d2f1e0c9-… \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": { "apiKey": { "id": "d2f1e0c9-…", "label": "deploy-bot", "prefix": "sk_4f8a2b1c", "revokedAt": "2026-07-02T14:00:00.000Z" } },
  "meta": { "requestId": "req_4e5f6a7b8c9d", "cursor": null }
}
```

Key creation and revocation are written to the identity security-event log **and** the workspace audit log (`api_key.created`, `api_key.revoked`, category `api_keys`), so both the key owner and workspace admins can trace lifecycle changes.

## Rotate a key

Rotation is create-cut-over-delete — there is no in-place secret regeneration:

1. **Create** a new key with the same role and scope (use a versioned label, e.g. `deploy-bot-2026-07`).
2. **Cut over** consumers to the new secret and confirm the old key's `lastUsedAt` stops advancing.
3. **Delete** the old key.

Setting `expiresAt` at creation gives every key a built-in rotation deadline — an expired key fails authentication exactly like a revoked one.

## Related

- [Authentication](/platform/identity/authentication)
- [CLI & CI authentication](/platform/identity/cli-and-ci-auth)
- [Access control (RBAC)](/platform/access-control/rbac)
- [API keys API reference](/api/resources/api-keys)
