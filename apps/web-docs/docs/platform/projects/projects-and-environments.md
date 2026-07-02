---
title: Projects & environments
description: Workspace-scoped projects (repos) and their environments — lifecycle, plan limits, and activity-driven liveness.
---

A **project** is the unit of work inside a workspace — in the current vocabulary a project *is* a **repo**, and the SDK exposes `client.repos` as the canonical accessor (`client.projects` remains as an alias). Each project owns a set of **environments** (`dev`, `staging`, `prod`, …) that scope configuration, secrets, and orun runs.

Projects and environments are **soft-archived, never hard-deleted**: `DELETE` on either resource archives it, preserving history, audit trails, and references from past runs.

## Resource shape

```json
{
  "project": {
    "id": "prj_5e6f7a8b9c0d",
    "orgId": "org_1f2e3d4c5b6a",
    "name": "Checkout Service",
    "slug": "checkout-service",
    "status": "active",
    "createdAt": "2026-06-01T09:12:44.120Z",
    "updatedAt": "2026-06-01T09:12:44.120Z",
    "archivedAt": null
  }
}
```

Environments add `projectId` and `lastActiveAt` (see [Environment liveness](#environment-liveness)). Names are 1–100 characters; slugs are 2–63 lowercase alphanumerics and hyphens, and are derived from the name when omitted. Slugs are unique per scope — a duplicate returns `409 conflict`.

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/v1/organizations/{orgId}/projects` | `project.create` | Create a project |
| `GET` | `/v1/organizations/{orgId}/projects` | `project.list` | List projects |
| `GET` | `/v1/organizations/{orgId}/projects/{projectId}` | `project.read` | Get a project |
| `DELETE` | `/v1/organizations/{orgId}/projects/{projectId}` | `project.delete` | **Archive** a project |
| `POST` | `…/projects/{projectId}/environments` | `environment.create` | Create an environment |
| `GET` | `…/projects/{projectId}/environments` | `environment.read` | List environments (`?includeArchived=true` to include archived) |
| `GET` | `…/environments/{envId}` | `environment.read` | Get an environment |
| `DELETE` | `…/environments/{envId}` | `environment.delete` | **Archive** an environment |

`/v1/workspaces/…` is an accepted alias for `/v1/organizations/…` on these paths.

:::warning
`DELETE` archives — it does not destroy. The response returns the resource with `status` updated and `archivedAt` set. There is no un-archive endpoint for projects; an archived *environment* is revived automatically if activity references it again.
:::

## Create a project

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f2e3d4c5b6a/projects" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-checkout-service-1" \
  -d '{"name": "Checkout Service", "slug": "checkout-service"}'
```

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const { project } = await client.repos.create(
  "org_1f2e3d4c5b6a",
  { name: "Checkout Service", slug: "checkout-service" },
  { idempotencyKey: "create-checkout-service-1" },
);
```

Creation returns `201` with the project in the standard envelope. Every lifecycle change (`project.created`, `environment.archived`, …) also lands in the [audit log](/platform/audit/audit-log) under the `projects` category.

## Create and archive environments

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f2e3d4c5b6a/projects/prj_5e6f7a8b9c0d/environments" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "staging"}'
```

```ts
const { environment } = await client.environments.create(
  "org_1f2e3d4c5b6a",
  "prj_5e6f7a8b9c0d",
  { name: "staging" },
);

// Later: archive it (soft delete)
await client.environments.archive("org_1f2e3d4c5b6a", "prj_5e6f7a8b9c0d", environment.id);
```

## Plan limits

Creation is gated by [billing entitlements](/platform/billing/plans-and-entitlements) *after* the permission check and *before* anything is written:

| Entitlement | Applies to | Free | Pro | Business | Enterprise |
|---|---|---|---|---|---|
| `limit.projects` | Active projects per workspace | 3 | 25 | 100 | Unlimited |
| `limit.environments` | Active environments per project | 3 | 3 | 5 | Unlimited |

Only **active** resources count — archiving frees quota. When a limit is reached, creation fails with `412 precondition_failed` and a `details.reason` explaining the gate. The gate fails closed: if the entitlement check itself cannot complete, creation is refused rather than over-provisioned.

## Environment liveness

Environments track a `lastActiveAt` timestamp and follow an activity-driven lifecycle:

- **Register on activity** — when a run or plan references an environment that doesn't exist yet, the platform materializes it automatically (a system-actor `environment.created` event lands in audit). The same signal bumps `lastActiveAt` on existing environments and **revives archived ones**. System-materialized environments are not quota-blocked — you already referenced them.
- **Archive when stale** — a periodic platform sweep archives active environments whose `lastActiveAt` predates the retention window (default 90 days), emitting `environment.archived` with `reason: "stale"`. The sweep is reversible: any later activity touch revives the row.

Environment lists return active environments by default; pass `includeArchived=true` to see what the sweep has retired.

## Connect projects to repos and runs

- **Git repos** — link a project to a GitHub repository so pushes and pull requests flow into Orun Cloud (repo links require `project.repo_link.write`). See [GitHub integration](/platform/integrations/github).
- **orun runs** — projects and environments are the tenancy scope for remote state, runs, and the catalog. See [State plane overview](/platform/state-plane/overview).

## Related

- [Access control (RBAC)](/platform/access-control/rbac)
- [Plans & entitlements](/platform/billing/plans-and-entitlements)
- [GitHub integration](/platform/integrations/github)
- [API reference: Projects & environments](/api/resources/projects-and-environments)
