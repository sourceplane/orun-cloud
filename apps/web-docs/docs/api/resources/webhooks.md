---
title: Webhooks
description: Manage outbound webhook endpoints, event subscriptions, and delivery attempts — including secret rotation and manual replay.
---

The **webhooks API** manages outbound webhook **endpoints** (where Orun Cloud delivers events), **subscriptions** (which event types go to which endpoint), and **delivery attempts** (the per-delivery history, with manual replay). How deliveries are signed and verified is covered in [Verifying deliveries](/platform/webhooks/verifying-deliveries); the retry schedule and replay semantics in [Retries and replay](/platform/webhooks/retries-and-replay); the model in [Webhooks overview](/platform/webhooks/overview).

Endpoints exist at **workspace scope** or **project scope**. The endpoint collection is served at both path shapes; item routes are always workspace-scoped (the endpoint id is unique within the workspace). Authorization follows the endpoint's scope: workspace-scoped endpoints check `organization.webhook.read`/`.write`, project-scoped endpoints check `project.webhook.read`/`.write`.

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/v1/organizations/{orgId}/webhooks/endpoints` | `organization.webhook.read` | List workspace endpoints |
| `POST` | `/v1/organizations/{orgId}/webhooks/endpoints` | `organization.webhook.write`¹ | Create an endpoint |
| `GET` | `/v1/organizations/{orgId}/projects/{projectId}/webhooks/endpoints` | `project.webhook.read` | List a project's endpoints |
| `POST` | `/v1/organizations/{orgId}/projects/{projectId}/webhooks/endpoints` | `project.webhook.write`¹ | Create a project-scoped endpoint |
| `GET` | `/v1/organizations/{orgId}/webhooks/endpoints/{endpointId}` | `organization.webhook.read`² | Get an endpoint |
| `PATCH` | `/v1/organizations/{orgId}/webhooks/endpoints/{endpointId}` | `organization.webhook.write`² | Update `url`, `name`, `description` |
| `DELETE` | `/v1/organizations/{orgId}/webhooks/endpoints/{endpointId}` | `organization.webhook.write`² | Delete an endpoint |
| `POST` | `/v1/organizations/{orgId}/webhooks/endpoints/{endpointId}/disable` | `organization.webhook.write`² | Disable (optional `reason` in body) |
| `POST` | `/v1/organizations/{orgId}/webhooks/endpoints/{endpointId}/enable` | `organization.webhook.write`² | Re-enable a disabled endpoint |
| `POST` | `/v1/organizations/{orgId}/webhooks/endpoints/{endpointId}/rotate-secret` | `organization.webhook.write`² | Rotate the signing secret (reveal-once) |
| `POST` | `/v1/organizations/{orgId}/webhooks/subscriptions` | `organization.webhook.write`² | Create a subscription |
| `GET` | `/v1/organizations/{orgId}/webhooks/endpoints/{endpointId}/subscriptions` | `organization.webhook.read`² | List an endpoint's subscriptions |
| `GET` | `/v1/organizations/{orgId}/webhooks/subscriptions/{subscriptionId}` | `organization.webhook.read`² | Get a subscription |
| `PATCH` | `/v1/organizations/{orgId}/webhooks/subscriptions/{subscriptionId}` | `organization.webhook.write`² | Enable/disable a subscription |
| `DELETE` | `/v1/organizations/{orgId}/webhooks/subscriptions/{subscriptionId}` | `organization.webhook.write`² | Delete a subscription |
| `GET` | `/v1/organizations/{orgId}/webhooks/endpoints/{endpointId}/delivery-attempts` | `organization.webhook.read` | List delivery attempts |
| `GET` | `/v1/organizations/{orgId}/webhooks/delivery-attempts/{attemptId}` | `organization.webhook.read` | Get a delivery attempt |
| `POST` | `/v1/organizations/{orgId}/webhooks/delivery-attempts/{attemptId}/replay` | `organization.webhook.write` | Re-send the event (fresh attempt) |

¹ The `project.webhook.*` action applies when the request targets a project scope (project path, or a `projectId` in the create body).
² Item and subscription routes check the `project.webhook.*` variant when the underlying resource is project-scoped.

Ids are prefixed: endpoints `whe_…`, subscriptions `whs_…`, delivery attempts `whd_…`. Mutations accept an [`Idempotency-Key` header](/api/idempotency).

## Create an endpoint and subscribe it

Create returns the endpoint without any secret material — rotate the secret once after creation to obtain the signing secret.

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/webhooks/endpoints \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://hooks.acme.dev/orun", "name": "acme-prod-hooks" }'
```

```json
{
  "data": {
    "endpoint": {
      "id": "whe_9a8b7c6d5e4f30211a2b3c4d5e6f7a8b",
      "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
      "projectId": null,
      "url": "https://hooks.acme.dev/orun",
      "name": "acme-prod-hooks",
      "description": null,
      "status": "active",
      "disabledReason": null,
      "disabledAt": null,
      "secretVersion": 1,
      "secretLastRotatedAt": null,
      "createdAt": "2026-07-02T09:30:00.000Z",
      "updatedAt": "2026-07-02T09:30:00.000Z"
    }
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a26", "cursor": null }
}
```

Then subscribe it to an event type:

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/webhooks/subscriptions \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "endpointId": "whe_9a8b7c6d5e4f30211a2b3c4d5e6f7a8b", "eventType": "project.created" }'
```

With the SDK (project scope shown):

```ts
const { endpoint } = await client.webhooks.createProjectEndpoint(
  "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
  "prj_3e2d1c0b4a5968f7a6b5c4d3e2f1a0b9",
  { url: "https://hooks.acme.dev/orun" },
  { idempotencyKey: "create-hooks-endpoint-1" },
);
```

## Rotate the signing secret

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/webhooks/endpoints/whe_9a8b7c6d5e4f30211a2b3c4d5e6f7a8b/rotate-secret \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "endpoint": { "id": "whe_9a8b7c6d5e4f30211a2b3c4d5e6f7a8b", "secretVersion": 2, "…": "…" },
    "secret": "whsec_4f3e2d1c0b9a8e7f6d5c4b3a29181706",
    "previousSecretExpiresAt": "2026-07-03T09:32:00.000Z",
    "gracePeriodSeconds": 86400
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a27", "cursor": null }
}
```

:::warning
`secret` (`whsec_<32 hex>`) is **revealed exactly once** — it is never persisted in logs, events, or any read surface. Store it immediately. During the grace window, deliveries carry the previous secret's signature in `X-Webhook-Signature-Previous` alongside the new `X-Webhook-Signature`, so subscribers can roll over without dropping events.
:::

## Inspect and replay a delivery

```bash
curl "https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/webhooks/endpoints/whe_9a8b7c6d5e4f30211a2b3c4d5e6f7a8b/delivery-attempts?limit=1" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "deliveryAttempts": [
      {
        "id": "whd_1f2e3d4c5b6a79880919a2b3c4d5e6f7",
        "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
        "endpointId": "whe_9a8b7c6d5e4f30211a2b3c4d5e6f7a8b",
        "subscriptionId": "whs_2a3b4c5d6e7f80911a2b3c4d5e6f7a8b",
        "eventId": "evt_6e5d4c3b2a190807f6e5d4c3b2a19080",
        "eventType": "project.created",
        "status": "failed",
        "attemptNumber": 5,
        "httpStatusCode": 503,
        "failureReason": "upstream returned 503",
        "idempotencyKey": null,
        "nextRetryAt": null,
        "completedAt": "2026-07-02T10:05:00.000Z",
        "createdAt": "2026-07-02T09:31:00.000Z",
        "updatedAt": "2026-07-02T10:05:00.000Z"
      }
    ]
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a28", "cursor": null }
}
```

Replay re-sends the same event to the same endpoint through the normal signing seam and records a **new** attempt (fresh id, `attemptNumber` 1); the original is unchanged:

```ts
const { deliveryAttempt } = await client.webhooks.replayDelivery(
  "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
  "whd_1f2e3d4c5b6a79880919a2b3c4d5e6f7",
);
```

## Related

- [Webhooks overview](/platform/webhooks/overview)
- [Verifying deliveries](/platform/webhooks/verifying-deliveries)
- [Retries and replay](/platform/webhooks/retries-and-replay)
- [Pagination](/api/pagination)
