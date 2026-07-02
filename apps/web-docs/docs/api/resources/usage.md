---
title: Usage & quotas
description: Record usage events, read rollup summaries, check quotas, and list quota violations.
---

The **metering API** records usage events against a workspace, rolls them up into hourly and daily buckets, and evaluates **quotas** over the rolled-up totals. Products call it on the hot path (record, check) and from dashboards (summary, violations). For the model — metrics, rollups, quota periods, and soft vs. hard enforcement — see [Usage and quotas](/platform/metering/usage-and-quotas).

All routes are workspace-scoped under `/v1/organizations/{orgId}/…` and require a bearer token. Writes accept an [`Idempotency-Key` header](/api/idempotency); usage records additionally carry their own body-level `idempotencyKey` for per-event dedupe.

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/v1/organizations/{orgId}/usage` | `organization.metering.write` | Record a single usage event |
| `POST` | `/v1/organizations/{orgId}/usage/batch` | `organization.metering.write` | Ingest a batch of usage events |
| `GET` | `/v1/organizations/{orgId}/usage/summary` | `organization.metering.read` | Rollup summary for a metric |
| `POST` | `/v1/organizations/{orgId}/quotas/check` | `organization.metering.read` | Evaluate a quota for a metric |
| `GET` | `/v1/organizations/{orgId}/quotas/violations` | `organization.metering.read` | List recorded quota violations |

## Record a usage event

`metric` and the body-level `idempotencyKey` are required; `quantity` defaults to `1` and `recordedAt` to now. Optional `projectId`, `environmentId` (requires `projectId`), `resourceId`, and a bounded `metadata` map scope the event. A duplicate `idempotencyKey` within the workspace returns `409 conflict`.

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/usage \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "metric": "build_minutes",
    "quantity": 12,
    "idempotencyKey": "build-01J9ZK3T7Q",
    "projectId": "prj_3e2d1c0b4a5968f7a6b5c4d3e2f1a0b9"
  }'
```

```json
{
  "data": {
    "usageRecord": {
      "id": "0d9c8b7a-6f5e-4d3c-2b1a-0f9e8d7c6b5a",
      "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
      "projectId": "prj_3e2d1c0b4a5968f7a6b5c4d3e2f1a0b9",
      "environmentId": null,
      "resourceId": null,
      "metric": "build_minutes",
      "quantity": 12,
      "idempotencyKey": "build-01J9ZK3T7Q",
      "recordedAt": "2026-07-02T09:14:00.000Z",
      "metadata": null,
      "createdAt": "2026-07-02T09:14:00.412Z"
    }
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a21", "cursor": null }
}
```

With the SDK:

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const { usageRecord } = await client.metering.recordUsage(
  "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
  { metric: "build_minutes", quantity: 12, idempotencyKey: "build-01J9ZK3T7Q" },
);
```

Batch ingestion (`POST …/usage/batch`) takes `{ "records": [ … ] }` where each record has the same shape as a single event. The response returns a per-record `results` array — each entry is either `{ "ok": true, "usageRecord": … }` or `{ "ok": false, "error": { "kind": … } }`, so one duplicate does not fail the batch.

## Read a usage summary

`metric` is required. Optional filters: `projectId`, `environmentId`, `bucketType` (`hour` | `day`), `startTime`, `endTime` (ISO 8601, start inclusive / end exclusive).

```bash
curl "https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/usage/summary?metric=build_minutes&bucketType=day" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "metric": "build_minutes",
    "totalQuantity": 340,
    "totalRecords": 41,
    "rollups": [
      {
        "id": "8a7b6c5d-4e3f-2a1b-0c9d-8e7f6a5b4c3d",
        "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
        "projectId": null,
        "environmentId": null,
        "metric": "build_minutes",
        "bucketType": "day",
        "bucketStart": "2026-07-01T00:00:00.000Z",
        "quantity": 340,
        "recordCount": 41,
        "createdAt": "2026-07-01T01:00:02.000Z",
        "updatedAt": "2026-07-02T09:14:01.000Z"
      }
    ]
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a22", "cursor": null }
}
```

## Check a quota

`POST …/quotas/check` evaluates the metric against the workspace's most specific configured quota. The decision is a plain read — it does not record usage. `reason` is `null` for an in-quota result, `quota_exceeded` when over the limit, or `no_quota_defined` (returned with `allowed: true` and `limit`/`remaining` of `-1`) when no quota matches.

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/quotas/check \
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
    "used": 340,
    "remaining": 160,
    "period": "month",
    "enforcement": "hard",
    "reason": null
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a23", "cursor": null }
}
```

`period` is one of `hour`, `day`, `month`, `billing_cycle`. `enforcement` echoes the quota's configured mode — `soft` or `hard` — so the caller decides whether an exceeded quota blocks the action or merely records a violation.

`GET …/quotas/violations` lists recorded violations, filterable by `metric`, `projectId`, `environmentId`, and `resourceId`, with `limit`/`cursor` [pagination](/api/pagination).

## Related

- [Usage and quotas](/platform/metering/usage-and-quotas)
- [Billing](/api/resources/billing)
- [Idempotency](/api/idempotency)
- [Rate limits](/api/rate-limits)
