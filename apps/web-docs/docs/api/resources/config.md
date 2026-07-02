---
title: Config
description: Settings, feature flags, and secrets at workspace, project, and environment scope — collection and item routes, secret rotation, and resolved settings reads.
---

The config surface manages three resource families — **settings** (typed key/value), **feature flags**, and **secrets** (write-only values, metadata-only reads) — each available at three scopes: the workspace, a project, or an environment. The same route shapes repeat under each scope prefix. For the model, see [Settings & feature flags](/platform/configuration/settings-and-feature-flags) and [Secrets](/platform/configuration/secrets).

## Scope prefixes

Every route below is relative to one of these three prefixes (`{scope}`):

| Scope | Prefix |
|---|---|
| Workspace | `/v1/organizations/{orgId}` |
| Project | `/v1/organizations/{orgId}/projects/{projectId}` |
| Environment | `/v1/organizations/{orgId}/projects/{projectId}/environments/{environmentId}` |

Reads require `organization.config.read` at workspace scope and `project.config.read` at project or environment scope; writes require the matching `organization.config.write` / `project.config.write`.

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `{scope}/config/settings` | `*.config.read` | List settings at exactly this scope |
| `POST` | `{scope}/config/settings` | `*.config.write` | Create a setting |
| `PATCH` | `{scope}/config/settings/{settingId}` | `*.config.write` | Update a setting's value/description |
| `GET` | `{scope}/config/settings/resolve?key={key}` | `*.config.read` | Resolved read — walks the inheritance chain |
| `GET` | `{scope}/config/feature-flags` | `*.config.read` | List feature flags |
| `POST` | `{scope}/config/feature-flags` | `*.config.write` | Create a feature flag |
| `PATCH` | `{scope}/config/feature-flags/{flagId}` | `*.config.write` | Update a flag (`enabled`, `value`, `description`) |
| `GET` | `{scope}/config/secrets` | `*.config.read` | List secret **metadata** (never values) |
| `POST` | `{scope}/config/secrets` | `*.config.write` | Create a secret (write-only `value`) |
| `POST` | `{scope}/config/secrets/{secretId}/rotate` | `*.config.write` | Rotate a secret's value |
| `DELETE` | `{scope}/config/secrets/{secretId}` | `*.config.write` | Revoke a secret |

Setting ids are `stg_…`, flag ids `flg_…`, secret ids `sec_…`. Settings and flags have no `DELETE` route — item routes accept `PATCH` only.

## Create and update a setting

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f6a3c9e/projects/prj_2d3e4f5a/config/settings" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "key": "deploy.max_parallelism", "value": 4, "description": "Cap concurrent deploy steps" }'
```

```json
{
  "data": {
    "setting": {
      "id": "stg_3f4a5b6c",
      "orgId": "org_1f6a3c9e",
      "projectId": "prj_2d3e4f5a",
      "environmentId": null,
      "scopeKind": "project",
      "key": "deploy.max_parallelism",
      "value": 4,
      "description": "Cap concurrent deploy steps",
      "createdAt": "2026-07-02T10:00:00.000Z",
      "updatedAt": "2026-07-02T10:00:00.000Z"
    }
  },
  "meta": { "requestId": "req_2f3a4b5c6d7e", "cursor": null }
}
```

Update with `PATCH {scope}/config/settings/stg_3f4a5b6c` and a body of `{ "value": …, "description": … }`.

## Resolve a setting through the inheritance chain

`GET {scope}/config/settings` is the management view — it returns only what is defined at exactly that scope. The **resolve** endpoint answers "what value applies here": it walks the chain **environment → project → workspace → account → default** and returns the first match, with provenance.

```bash
curl "https://api.orun.dev/v1/organizations/org_1f6a3c9e/projects/prj_2d3e4f5a/environments/env_6a7b8c9d/config/settings/resolve?key=deploy.max_parallelism" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "setting": {
      "id": "stg_3f4a5b6c",
      "orgId": "org_1f6a3c9e",
      "projectId": "prj_2d3e4f5a",
      "environmentId": null,
      "scopeKind": "project",
      "key": "deploy.max_parallelism",
      "value": 4,
      "description": "Cap concurrent deploy steps",
      "overridable": true,
      "inheritedFrom": { "scopeKind": "project" },
      "createdAt": "2026-07-02T10:00:00.000Z",
      "updatedAt": "2026-07-02T10:00:00.000Z"
    }
  },
  "meta": { "requestId": "req_3a4b5c6d7e8f", "cursor": null }
}
```

`inheritedFrom.scopeKind` names the rung the value was found at; `overridable: false` marks a locked account-scope guardrail that lower scopes cannot override. The `key` query parameter is required.

## Create and rotate a secret

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f6a3c9e/projects/prj_2d3e4f5a/environments/env_6a7b8c9d/config/secrets" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-stripe-key-01" \
  -d '{ "secretKey": "STRIPE_API_KEY", "value": "sk_live_…", "displayName": "Stripe API key" }'
```

```json
{
  "data": {
    "secret": {
      "id": "sec_4b5c6d7e",
      "orgId": "org_1f6a3c9e",
      "projectId": "prj_2d3e4f5a",
      "environmentId": "env_6a7b8c9d",
      "scopeKind": "environment",
      "secretKey": "STRIPE_API_KEY",
      "displayName": "Stripe API key",
      "status": "active",
      "version": 1,
      "rotationPolicy": null,
      "lastRotatedAt": null,
      "expiresAt": null,
      "createdBy": "usr_9f8e7d6c",
      "createdAt": "2026-07-02T10:05:00.000Z",
      "updatedAt": "2026-07-02T10:05:00.000Z"
    }
  },
  "meta": { "requestId": "req_4b5c6d7e8f9a", "cursor": null }
}
```

:::warning
Secret `value` is **write-only**. It is encrypted in the worker before persistence and never appears in any response, event, or audit payload — list and item responses carry metadata only.
:::

Rotate by POSTing the replacement value; the metadata response reflects the bumped `version` and `lastRotatedAt`:

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f6a3c9e/projects/prj_2d3e4f5a/environments/env_6a7b8c9d/config/secrets/sec_4b5c6d7e/rotate" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "value": "sk_live_new…" }'
```

Revoke with `DELETE {scope}/config/secrets/{secretId}`.

## Use the SDK

The SDK exposes each family as one flat method taking a discriminated `scope` argument instead of nine path permutations:

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const scope = {
  kind: "environment",
  orgId: "org_1f6a3c9e",
  projectId: "prj_2d3e4f5a",
  environmentId: "env_6a7b8c9d",
} as const;

const { settings } = await client.config.listSettings(scope);

const { secret } = await client.config.createSecretMetadata(scope, {
  secretKey: "STRIPE_API_KEY",
  value: "sk_live_…",
});
await client.config.rotateSecret(scope, secret.id, { value: "sk_live_new…" });
```

## Related

- [Settings & feature flags](/platform/configuration/settings-and-feature-flags)
- [Secrets](/platform/configuration/secrets)
- [Projects & environments API](/api/resources/projects-and-environments)
- [RBAC](/platform/access-control/rbac)
