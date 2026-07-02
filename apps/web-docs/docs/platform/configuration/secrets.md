---
title: Secrets
description: Scoped secret management with write-only values, AES-256-GCM encryption at rest, and a rotate/revoke lifecycle.
---

Orun Cloud **secrets** manage sensitive values at the same three scopes as settings — workspace, project, and environment. The API surface is deliberately asymmetric: secret **values are write-only**. You supply a value on create and rotate; the platform encrypts it before persistence, and no response, event, or audit payload ever contains the value, its ciphertext, or a hash of it. Everything you can read back is **metadata** — key, status, version, rotation timestamps.

## Encryption at rest

Values are encrypted in the worker before they touch storage, using **AES-256-GCM** (authenticated encryption) with a random 12-byte IV per value. The 256-bit key is sourced from a deployment environment binding — it is never stored alongside the data. What persists is a versioned ciphertext envelope (`{ alg: "AES-256-GCM", v: 1, iv, ct }`); plaintext is never written.

## Resource shape

```json
{
  "secret": {
    "id": "sec_9c8d7e6f5a4b",
    "orgId": "org_1f2e3d4c5b6a",
    "projectId": "prj_5e6f7a8b9c0d",
    "environmentId": null,
    "scopeKind": "project",
    "secretKey": "stripe.webhook_signing",
    "displayName": "Stripe webhook signing secret",
    "status": "active",
    "version": 2,
    "rotationPolicy": null,
    "lastRotatedAt": "2026-06-20T10:03:11.482Z",
    "expiresAt": null,
    "createdBy": "usr_2b3c4d5e6f7a",
    "createdAt": "2026-05-02T08:41:07.909Z",
    "updatedAt": "2026-06-20T10:03:11.482Z"
  }
}
```

## Endpoints

All paths are relative to a scope base — `/v1/organizations/{orgId}/config`, `…/projects/{projectId}/config`, or `…/environments/{envId}/config`:

| Method | Path | Description |
|---|---|---|
| `GET` | `/secrets` | List secret metadata at this scope |
| `POST` | `/secrets` | Create a secret (optional write-only `value`) |
| `POST` | `/secrets/{secretId}/rotate` | Replace the value; bumps `version`, sets `lastRotatedAt` |
| `DELETE` | `/secrets/{secretId}` | Revoke — soft delete, sets `status: "revoked"` |

Listing requires `organization.config.read` (workspace scope) or `project.config.read`; create, rotate, and revoke require the corresponding `…config.write` action.

## Create a secret

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f2e3d4c/projects/prj_5e6f7a8b/config/secrets" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"secretKey": "stripe.webhook_signing", "displayName": "Stripe webhook signing secret", "value": "whsec_..."}'
```

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const scope = { kind: "project", orgId: "org_1f2e3d4c", projectId: "prj_5e6f7a8b" } as const;

const { secret } = await client.config.createSecretMetadata(scope, {
  secretKey: "stripe.webhook_signing",
  displayName: "Stripe webhook signing secret",
  value: process.env.STRIPE_WEBHOOK_SECRET!,
});
```

The `201` response carries metadata only. `value` may be omitted to register metadata first and supply the value on a later rotate.

:::warning
Once written, a value cannot be read back through any Orun Cloud API. Keep your own copy in a system of record if you need to reference it — the only recovery path is rotating in a new value.
:::

## Rotate and revoke

**Rotate** replaces the value in place: the metadata row keeps its id and key, `version` increments, and `lastRotatedAt` is set. Consumers referencing the secret by id or key pick up the new value without re-wiring.

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f2e3d4c/projects/prj_5e6f7a8b/config/secrets/sec_9c8d7e6f5a4b/rotate" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "whsec_new..."}'
```

```ts
await client.config.rotateSecret(scope, "sec_9c8d7e6f5a4b", {
  value: process.env.STRIPE_WEBHOOK_SECRET_V2!,
});
```

**Revoke** is the end of the lifecycle — a soft delete that flips `status` to `revoked` while preserving the metadata row for audit:

```ts
await client.config.revokeSecret(scope, "sec_9c8d7e6f5a4b");
```

Create, rotate, and revoke all land in the [audit log](/platform/audit/audit-log) under the `config` category — with the value redacted by construction, since it never enters any event payload.

## The `secret.value.use` permission

Reading metadata and writing values are gated by the config permissions above. A separate action, **`secret.value.use`**, governs the *runtime use* of a secret's decrypted value — for example, a state-plane run consuming a secret during execution. It is held by the `owner`, `admin`, and `builder` workspace roles but not `viewer`, so read-only members can see that a secret exists without ever being able to exercise its value.

:::note
`secret.value.use` is part of the state-plane action set, which is rolling out — the permission is enforced deny-by-default in the policy catalog ahead of the surfaces that consume it. See [State plane overview](/platform/state-plane/overview).
:::

## Orun Cloud secrets vs. deployment wiring secrets

Two different kinds of secret exist in an Orun Cloud deployment — keep them separate:

- **Orun Cloud secrets (this page)** are *tenant data*: application-level values your workspaces, projects, and environments manage through the API — third-party API keys, webhook signing secrets, tokens your runs consume.
- **Deployment wiring secrets** are *infrastructure configuration* of the platform itself — database credentials, the secret-encryption key, provider tokens. These never live in this API; they belong in your cloud's secret manager and are injected as worker bindings when you run your own instance. See [Self-hosting architecture](/self-hosting/architecture).

## Related

- [Settings & feature flags](/platform/configuration/settings-and-feature-flags)
- [Access control (RBAC)](/platform/access-control/rbac)
- [Security model](/security/security-model)
- [API reference: Config](/api/resources/config)
