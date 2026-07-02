---
title: Usage & quotas
description: Record usage events, read hourly and daily rollups, and enforce quotas with the Orun Cloud metering API.
---

Metering is the workspace's **usage ledger**. Your services record **usage events** against named **metrics** (`build_minutes`, `api_requests`, …), the platform materializes them into hourly and daily **rollups**, and **quotas** turn those totals into allow/deny decisions you can enforce at runtime. Billing consumes normalized rollups — never raw events — so the ledger you write here is also the input to plan limits and invoicing.

Every metering route is workspace-scoped under the canonical `/v1/organizations/{id}` prefix (`/v1/workspaces/{id}` is an accepted alias):

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/v1/organizations/{id}/usage` | `organization.metering.write` | Record a single usage event |
| `POST` | `/v1/organizations/{id}/usage/batch` | `organization.metering.write` | Ingest up to 100 events with per-record results |
| `GET` | `/v1/organizations/{id}/usage/summary` | `organization.metering.read` | Totals plus hour/day rollups for a metric |
| `POST` | `/v1/organizations/{id}/quotas/check` | `organization.metering.read` | Point-in-time quota decision for a metric |
| `GET` | `/v1/organizations/{id}/quotas/violations` | `organization.metering.read` | List recorded quota violations |

`organization.metering.write` is held by the **owner** and **admin** workspace roles; `organization.metering.read` by owner, admin, builder, and viewer. Denied requests return `404 not_found` rather than `403`, so workspace existence is never leaked.

## Record a usage event

`POST /v1/organizations/{id}/usage` records one event. `metric` and a body-level `idempotencyKey` are required; `quantity` defaults to `1` and `recordedAt` to now. Events can be scoped to a project (`projectId`), an environment (`environmentId` — requires `projectId`), and an arbitrary `resourceId`.

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c/usage" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 9c41c3f2-a2be-4bb4-9f6e-2f1d54c0a8e1" \
  -d '{
    "metric": "build_minutes",
    "quantity": 12,
    "idempotencyKey": "run-2026-07-02-000123",
    "projectId": "prj_1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a",
    "recordedAt": "2026-07-02T09:15:00Z"
  }'
```

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const { usageRecord } = await client.metering.recordUsage(
  "org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c",
  {
    metric: "build_minutes",
    quantity: 12,
    idempotencyKey: "run-2026-07-02-000123",
    projectId: "prj_1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a",
  },
  { idempotencyKey: "9c41c3f2-a2be-4bb4-9f6e-2f1d54c0a8e1" },
);
```

A successful write returns `201` with the stored record:

```json
{
  "data": {
    "usageRecord": {
      "id": "5b8f2d0c-7a61-4e3f-9c2b-1a0d8e7f6c5d",
      "orgId": "7f3a9c2e-51d8-4b6f-a0e2-c4d8b91f6a3c",
      "projectId": "1d2c3b4a-5f6e-7d8c-9b0a-1f2e3d4c5b6a",
      "environmentId": null,
      "resourceId": null,
      "metric": "build_minutes",
      "quantity": 12,
      "idempotencyKey": "run-2026-07-02-000123",
      "recordedAt": "2026-07-02T09:15:00.000Z",
      "metadata": null,
      "createdAt": "2026-07-02T09:15:04.211Z"
    }
  },
  "meta": { "requestId": "req_01j9x2k4m8", "cursor": null }
}
```

`metadata` accepts a bounded, redaction-safe map — never put secrets, tokens, or credentials in it.

## Ingest a batch

`POST /v1/organizations/{id}/usage/batch` accepts `{ "records": [ … ] }` — up to **100** events per call, each with the same shape (and required per-record `idempotencyKey`) as a single write. The response carries a **per-record result array** in input order, so one duplicate does not fail the batch:

```json
{
  "data": {
    "results": [
      { "ok": true, "usageRecord": { "id": "0c7d9e1f-…", "metric": "api_requests", "quantity": 250 } },
      { "ok": false, "error": { "kind": "conflict", "message": "Duplicate idempotency key" } }
    ]
  },
  "meta": { "requestId": "req_01j9x2m1qv", "cursor": null }
}
```

```ts
const { results } = await client.metering.ingestUsageBatch(orgId, {
  records: [
    { metric: "api_requests", quantity: 250, idempotencyKey: "agg-2026-07-02T09:00-a" },
    { metric: "api_requests", quantity: 175, idempotencyKey: "agg-2026-07-02T09:00-b" },
  ],
});
```

## Make ingestion idempotent

Usage writes are deduplicated at two independent layers — use both:

- **Body `idempotencyKey`** (required) — a deduplication key unique per workspace, owned by the metering service. Re-sending the same key returns `409 conflict` on the single-event route, or an `{ "ok": false, "error": { "kind": "conflict" } }` entry in a batch. Derive it from the fact you are recording (a run ID, an aggregation window), not from a random value, so retries collide with the original.
- **`Idempotency-Key` header** (recommended) — standard edge replay protection on the POST itself. Replays within the 24-hour window return the stored response with `x-saas-replay-source: edge-idempotency`. See [Idempotency](/api/idempotency).

:::tip
Treat a `conflict` as success in retry loops: it means the event is already in the ledger. Emitters that crash between send and acknowledgment can safely resend the same body.
:::

## Read summaries and rollups

The platform materializes **rollups** — per-metric aggregates in `hour` and `day` buckets, keyed by workspace/project/environment — on a recurring schedule that covers the prior and current hour and the prior and current day. `GET /v1/organizations/{id}/usage/summary` returns the totals plus the matching rollup rows. `metric` is required; `projectId`, `environmentId`, `bucketType` (`hour` | `day`), `startTime`, and `endTime` (ISO 8601, start inclusive, end exclusive) are optional filters.

```bash
curl "https://api.orun.dev/v1/organizations/org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c/usage/summary?metric=build_minutes&bucketType=day&startTime=2026-06-01T00:00:00Z&endTime=2026-07-01T00:00:00Z" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```ts
const summary = await client.metering.getUsageSummary(orgId, {
  metric: "build_minutes",
  bucketType: "day",
  startTime: "2026-06-01T00:00:00Z",
  endTime: "2026-07-01T00:00:00Z",
});
// summary.totalQuantity, summary.totalRecords, summary.rollups[]
```

Each rollup row carries `bucketType`, `bucketStart`, the aggregated `quantity`, and the contributing `recordCount`. Because rollups materialize on a schedule, the current bucket can lag live writes by a few minutes.

## Check a quota

`POST /v1/organizations/{id}/quotas/check` evaluates a metric against the workspace's quota configuration and returns a decision — call it **before** performing the metered work when you enforce limits in your own services:

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c/quotas/check" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "metric": "build_minutes" }'
```

```json
{
  "data": {
    "allowed": true,
    "metric": "build_minutes",
    "limit": 500,
    "used": 342,
    "remaining": 158,
    "period": "month",
    "enforcement": "hard",
    "reason": null
  },
  "meta": { "requestId": "req_01j9x2p7t3", "cursor": null }
}
```

`period` is one of `hour`, `day`, `month`, or `billing_cycle`; `enforcement` is `soft` (record a violation, allow the action) or `hard` (deny). When no quota is defined for the metric, `limit` and `remaining` are `-1` and `reason` is `no_quota_defined`; an exceeded quota sets `reason: "quota_exceeded"`. Optional `projectId`, `environmentId`, and `resourceId` narrow the scope.

## List quota violations

Exceeded quotas are recorded as **violations** — one row per breach, with the quota's `limitValue`, the `actualValue` observed, `enforcement`, `violatedAt`, and `resolvedAt`. `GET /v1/organizations/{id}/quotas/violations` lists them, filterable by `metric`, `projectId`, `environmentId`, and `resourceId`, with `limit` + `cursor` pagination:

```bash
curl "https://api.orun.dev/v1/organizations/org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c/quotas/violations?metric=build_minutes&limit=20" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

Soft-enforced quotas are the usual source of violations: the action proceeds, the breach is recorded, and you can alert or upsell from this list.

## How metering feeds billing

Metering and billing enforce different kinds of limits:

- **Entitlement limits** — plan facts like `limit.projects` or `limit.members`. Owning services (projects, membership) consult the billing entitlement decision seam before each create, so plan limits gate writes platform-wide without those services reading billing tables. See [Plans & entitlements](/platform/billing/plans-and-entitlements).
- **Usage quotas** — metered consumption over a period, enforced through `quotas/check` against the ledger you populate here.

Billing consumes the normalized rollups, not raw usage records, so consistent metric keys and idempotent ingestion directly determine what plan enforcement and invoicing see.

## Related

- [Plans & entitlements](/platform/billing/plans-and-entitlements)
- [Usage API reference](/api/resources/usage)
- [Idempotency](/api/idempotency)
- [Projects & environments](/platform/projects/projects-and-environments)
