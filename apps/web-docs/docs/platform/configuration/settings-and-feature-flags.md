---
title: Settings & feature flags
description: Scoped key-value settings with inheritance across account, workspace, project, and environment — plus feature flags at the same scopes.
---

Orun Cloud gives every workspace a configuration store with two resource families: **settings** (typed key–value pairs) and **feature flags** (keyed on/off switches with an optional value). Both live at three scopes — **workspace**, **project**, and **environment** — and settings additionally support **inherited resolution** up a scope chain, so a value set once at the account or workspace level applies everywhere below unless a more specific scope overrides it.

## Scopes

Each scope has its own collection path; the same operations work at every scope:

| Scope | Base path |
|---|---|
| Workspace | `/v1/organizations/{orgId}/config` |
| Project | `/v1/organizations/{orgId}/projects/{projectId}/config` |
| Environment | `/v1/organizations/{orgId}/projects/{projectId}/environments/{envId}/config` |

Reads at workspace scope require `organization.config.read`; project and environment scopes require `project.config.read`. Writes require the corresponding `…config.write` action. A fourth rung — the **account** (the workspace's parent organization) — participates in resolved reads: values set at the account level are inherited by every workspace under it.

## Manage settings

| Method | Path (relative to a scope base) | Description |
|---|---|---|
| `GET` | `/settings` | List settings at exactly this scope |
| `POST` | `/settings` | Create a setting (`key`, `value`, optional `description`) |
| `PATCH` | `/settings/{settingId}` | Update a setting by its public id (`set_…`), not its key |
| `GET` | `/settings/resolve?key={key}` | Resolved read — walks the inheritance chain |

There is no delete endpoint for settings or flags — the management surface is create, list, and update.

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f2e3d4c/projects/prj_5e6f7a8b/config/settings" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key": "deploy.max_concurrency", "value": 4, "description": "Cap concurrent deploys"}'
```

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const scope = { kind: "project", orgId: "org_1f2e3d4c", projectId: "prj_5e6f7a8b" } as const;

const { setting } = await client.config.createSetting(scope, {
  key: "deploy.max_concurrency",
  value: 4,
});

await client.config.updateSetting(scope, setting.id, { value: 8 });
```

The SDK models the scope as a discriminated object (`{ kind: "organization" | "project" | "environment", … }`) so one method covers all three scopes.

## Resolve a setting through the scope chain

`GET …/config/settings/resolve?key=<key>` returns the **effective** value at a scope by walking the resolution chain, most specific first:

```
environment → project → workspace → account → default
```

The first scope with a value wins. The response carries provenance — `inheritedFrom.scopeKind` tells you which rung supplied the value (`"default"` with no value means nothing is set anywhere in the chain):

```bash
curl "https://api.orun.dev/v1/organizations/org_1f2e3d4c/projects/prj_5e6f7a8b/environments/env_3c4d5e6f/config/settings/resolve?key=deploy.max_concurrency" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "setting": {
      "id": "set_4d5e6f7a8b9c",
      "orgId": "org_1f2e3d4c5b6a",
      "projectId": "prj_5e6f7a8b9c0d",
      "environmentId": null,
      "scopeKind": "project",
      "key": "deploy.max_concurrency",
      "value": 4,
      "description": "Cap concurrent deploys",
      "overridable": true,
      "inheritedFrom": { "scopeKind": "project" },
      "createdAt": "2026-06-12T09:30:00.000Z",
      "updatedAt": "2026-06-12T09:30:00.000Z"
    }
  },
  "meta": { "requestId": "req_7a8b9c0d1e2f", "cursor": null }
}
```

Contrast with `GET …/settings`, which is the *management* view: it lists only values defined at exactly that scope, with no inheritance.

### Locked account guardrails

An account-scoped setting can be marked locked (`overridable: false`), making it a **guardrail**: any attempt to write the same key at a child workspace, project, or environment scope is rejected with `409 conflict`. Because the override write is blocked, resolved reads never need to arbitrate — the account value is simply the only one that can exist. Settings created through the API default to `overridable: true`; use guardrails for org-wide policy values that individual workspaces must not loosen.

:::note
The account rung resolves fail-soft: if the parent account cannot be determined during a read, resolution falls back to environment → project → workspace → default rather than failing the request.
:::

## Feature flags

Feature flags live at the same three scopes with the same list/create/update surface under `…/config/feature-flags`. A flag has a `flagKey`, an `enabled` boolean, and an optional `value` payload for variants:

```ts
const { featureFlag } = await client.config.createFeatureFlag(
  { kind: "environment", orgId: "org_1f2e3d4c", projectId: "prj_5e6f7a8b", environmentId: "env_3c4d5e6f" },
  { flagKey: "checkout.new_flow", enabled: false, value: { rollout: 0 } },
);

// Flip it on
await client.config.updateFeatureFlag(
  { kind: "environment", orgId: "org_1f2e3d4c", projectId: "prj_5e6f7a8b", environmentId: "env_3c4d5e6f" },
  featureFlag.id,
  { enabled: true, value: { rollout: 25 } },
);
```

Flags are updated by their public id (`flg_…`), not by key.

:::note
The `…/resolve` scope-chain read currently exists for **settings only**. Feature flags are scoped but read exactly-scope — resolve semantics for flags are a planned follow-up. (Don't confuse these tenant flags with Orun Cloud's *plan* flags like `feature.multi_org`, which come from [billing entitlements](/platform/billing/plans-and-entitlements).)
:::

## Settings vs. flags

| Use a **setting** when… | Use a **feature flag** when… |
|---|---|
| The value is configuration your code reads (limits, endpoints, tuning) | The primary question is "is this behavior on here?" |
| You want inheritance — set once at workspace/account, override per environment | You want an explicit per-scope switch with an optional variant payload |
| The value should be enforceable org-wide (`overridable: false` guardrails) | You'll flip it independently per environment during a rollout |

All setting, flag, and secret writes are recorded in the [audit log](/platform/audit/audit-log) under the `config` category.

## Related

- [Secrets](/platform/configuration/secrets)
- [Access control (RBAC)](/platform/access-control/rbac)
- [Plans & entitlements](/platform/billing/plans-and-entitlements)
- [API reference: Config](/api/resources/config)
