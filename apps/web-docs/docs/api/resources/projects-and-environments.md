---
title: Projects & environments
description: Create, list, read, and archive projects and their environments under a workspace.
---

A **project** (called a **repo** in the new vocabulary) groups related work inside a workspace; each project contains **environments** — the deploy targets (`dev`, `staging`, `prod`, …) that runs and config attach to. Both are archived, never hard-deleted: `DELETE` flips `status` to archived and stamps `archivedAt`. For the model, see [Projects & environments](/platform/projects/projects-and-environments).

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/v1/organizations/{orgId}/projects` | `project.list` | List projects |
| `POST` | `/v1/organizations/{orgId}/projects` | `project.create` | Create a project |
| `GET` | `/v1/organizations/{orgId}/projects/{projectId}` | `project.read` | Get a project |
| `DELETE` | `/v1/organizations/{orgId}/projects/{projectId}` | `project.delete` | Archive a project |
| `GET` | `/v1/organizations/{orgId}/projects/{projectId}/environments` | `environment.read` | List environments |
| `POST` | `/v1/organizations/{orgId}/projects/{projectId}/environments` | `environment.create` | Create an environment |
| `GET` | `/v1/organizations/{orgId}/projects/{projectId}/environments/{environmentId}` | `environment.read` | Get an environment |
| `DELETE` | `/v1/organizations/{orgId}/projects/{projectId}/environments/{environmentId}` | `environment.delete` | Archive an environment |

Project ids are `prj_…`; environment ids are `env_…`. Project creation counts against the plan's `limit.projects` entitlement — see [Plans & entitlements](/platform/billing/plans-and-entitlements).

## Create a project

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f6a3c9e/projects" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-checkout-api-01" \
  -d '{ "name": "Checkout API", "slug": "checkout-api" }'
```

`slug` is optional — one is derived from `name` when omitted.

```json
{
  "data": {
    "project": {
      "id": "prj_2d3e4f5a",
      "orgId": "org_1f6a3c9e",
      "name": "Checkout API",
      "slug": "checkout-api",
      "status": "active",
      "createdAt": "2026-07-02T09:40:00.000Z",
      "updatedAt": "2026-07-02T09:40:00.000Z",
      "archivedAt": null
    }
  },
  "meta": { "requestId": "req_0d1e2f3a4b5c", "cursor": null }
}
```

On the `/v1/workspaces/*` alias the same object additionally carries `workspaceId` (equal to `orgId`).

## Create an environment

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f6a3c9e/projects/prj_2d3e4f5a/environments" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Staging", "slug": "staging" }'
```

```json
{
  "data": {
    "environment": {
      "id": "env_6a7b8c9d",
      "orgId": "org_1f6a3c9e",
      "projectId": "prj_2d3e4f5a",
      "name": "Staging",
      "slug": "staging",
      "status": "active",
      "createdAt": "2026-07-02T09:42:00.000Z",
      "updatedAt": "2026-07-02T09:42:00.000Z",
      "archivedAt": null,
      "lastActiveAt": "2026-07-02T09:42:00.000Z"
    }
  },
  "meta": { "requestId": "req_1e2f3a4b5c6d", "cursor": null }
}
```

:::note
`lastActiveAt` records the last push to the environment (a run, plan, or catalog push referencing it). A background sweep archives active environments whose `lastActiveAt` predates the retention window, so idle targets do not accumulate.
:::

## Archive

```bash
curl -X DELETE "https://api.orun.dev/v1/organizations/org_1f6a3c9e/projects/prj_2d3e4f5a" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Idempotency-Key: archive-checkout-api-01"
```

The response returns the project with `status` archived and `archivedAt` set — the record and its history remain readable.

## Use the SDK

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const { project } = await client.projects.create("org_1f6a3c9e", {
  name: "Checkout API",
});

const { environment } = await client.environments.create(
  "org_1f6a3c9e",
  project.id,
  { name: "Staging" },
);

const { environments } = await client.environments.list("org_1f6a3c9e", project.id);
console.log(environments.map((e) => `${e.slug}: ${e.status}`));
```

`client.repos` is an alias for `client.projects` — the same client under the new vocabulary.

## Related

- [Projects & environments](/platform/projects/projects-and-environments)
- [Config API](/api/resources/config)
- [Plans & entitlements](/platform/billing/plans-and-entitlements)
- [Workspaces API](/api/resources/organizations)
