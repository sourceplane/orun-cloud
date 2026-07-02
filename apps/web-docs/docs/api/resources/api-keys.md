---
title: API keys
description: Create, list, and revoke workspace API keys — service-principal credentials whose secret is revealed exactly once at creation.
---

A workspace **API key** is a long-lived credential for machine callers. Creating one mints a **service principal** bound to a role (workspace-wide, or scoped to one project via `projectId`) and returns the `sk_…` secret exactly once; the key then authenticates requests as `Authorization: Bearer <secret>`. For the model, see [API keys](/platform/identity/api-keys).

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/v1/organizations/{orgId}/api-keys` | `organization.api_key.list` | List keys (metadata only — never secrets) |
| `POST` | `/v1/organizations/{orgId}/api-keys` | `organization.api_key.create` | Create a key; the response reveals the secret once |
| `DELETE` | `/v1/organizations/{orgId}/api-keys/{apiKeyId}` | `organization.api_key.revoke` | Revoke a key |

## Create an API key

The request body takes `label`, `role` (the role granted to the key's service principal), and optionally `projectId` (scope the role to one project) and `expiresAt`.

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f6a3c9e/api-keys" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ci-deploy-key-01" \
  -d '{ "label": "ci-deploy", "role": "builder", "expiresAt": "2027-07-02T00:00:00.000Z" }'
```

```json
{
  "data": {
    "apiKey": {
      "id": "b4f2b0e6-6a1d-4e0a-9c3f-2a7d8e5b1c90",
      "label": "ci-deploy",
      "prefix": "sk_4f9a2b7c1",
      "secret": "sk_4f9a2b7c1d8e3f6a0b5c9d2e7f4a1b8c3d6e9f0a5b2c7d4e1f8a3b6c9d0e5f2a",
      "createdAt": "2026-07-02T09:30:00.000Z",
      "expiresAt": "2027-07-02T00:00:00.000Z",
      "servicePrincipal": {
        "id": "7c1d2e3f-9a8b-4c5d-8e6f-0a1b2c3d4e5f",
        "displayName": "API Key: ci-deploy",
        "role": "builder",
        "projectId": null
      }
    }
  },
  "meta": { "requestId": "req_8b9c0d1e2f3a", "cursor": null }
}
```

The create response returns `201 Created`.

:::warning
`secret` appears **only** in this create response. It is stored as a hash — Orun Cloud cannot show it again. Persist it immediately (a secret manager, your CI provider's encrypted secrets); if it is lost, revoke the key and create a new one. Every later read returns only the 12-character `prefix` for identification.
:::

Send `Idempotency-Key` on create so a retried request replays the original response — including the secret — instead of minting a second key.

## List keys

```bash
curl "https://api.orun.dev/v1/organizations/org_1f6a3c9e/api-keys" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "apiKeys": [
      {
        "id": "b4f2b0e6-6a1d-4e0a-9c3f-2a7d8e5b1c90",
        "label": "ci-deploy",
        "prefix": "sk_4f9a2b7c1",
        "createdAt": "2026-07-02T09:30:00.000Z",
        "expiresAt": "2027-07-02T00:00:00.000Z",
        "lastUsedAt": "2026-07-02T11:02:14.000Z",
        "revokedAt": null,
        "servicePrincipal": {
          "id": "7c1d2e3f-9a8b-4c5d-8e6f-0a1b2c3d4e5f",
          "displayName": "API Key: ci-deploy",
          "role": "builder",
          "projectId": null
        }
      }
    ]
  },
  "meta": { "requestId": "req_9c0d1e2f3a4b", "cursor": null }
}
```

Use `prefix` and `lastUsedAt` to match a leaked or stale credential to its key record.

## Revoke a key with the SDK

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const { apiKey } = await client.apiKeys.create(
  "org_1f6a3c9e",
  { label: "ci-deploy", role: "builder" },
  { idempotencyKey: "ci-deploy-key-01" },
);
// apiKey.secret is available here — and only here.

await client.apiKeys.revoke("org_1f6a3c9e", apiKey.id);
```

The revoke response returns `{ id, label, prefix, revokedAt }`; requests authenticated with a revoked key are rejected.

## Related

- [API keys](/platform/identity/api-keys)
- [Authentication](/api/authentication)
- [RBAC](/platform/access-control/rbac)
- [CLI & CI auth](/platform/identity/cli-and-ci-auth)
