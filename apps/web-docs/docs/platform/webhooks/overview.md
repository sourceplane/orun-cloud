---
title: Webhooks
description: Signed outbound webhooks — endpoints, event-type subscriptions, and delivery attempts, scoped to a workspace or a project.
---

**Webhooks** push platform events to your systems as they happen. Every meaningful state mutation in Orun Cloud — a project created, a member added, an invoice paid, a `scm.push` from a linked GitHub repo — lands on the workspace's event log, and the webhooks pipeline fans matching events out to your HTTPS endpoints as signed POST requests.

The model has three resources:

- **Endpoint** — an HTTPS URL plus a server-generated **signing secret**. Endpoints belong to a workspace and can optionally be scoped to a single project. An endpoint is `active`, or `disabled` (by you, or automatically after repeated failures).
- **Subscription** — an event-type filter attached to an endpoint. Each subscription names one event type (or a wildcard) that should be delivered to that endpoint.
- **Delivery attempt** — one record per event × subscription, tracking status, HTTP result, retries, and replay. See [Retries & replay](/platform/webhooks/retries-and-replay).

## Endpoints and routes

All routes live under the workspace (`/v1/organizations/{orgId}/…` — `/v1/workspaces/…` is an accepted alias). Endpoint creation and listing also exist project-scoped.

| Method | Path | Description |
| --- | --- | --- |
| `GET` / `POST` | `/v1/organizations/{orgId}/webhooks/endpoints` | List / create endpoints (workspace scope) |
| `GET` / `POST` | `/v1/organizations/{orgId}/projects/{projectId}/webhooks/endpoints` | List / create endpoints (project scope) |
| `GET` / `PATCH` / `DELETE` | `…/webhooks/endpoints/{id}` | Read, update (`url`, `name`, `description`), delete |
| `POST` | `…/webhooks/endpoints/{id}/disable` | Disable (optional `reason` in body) |
| `POST` | `…/webhooks/endpoints/{id}/enable` | Re-enable a disabled endpoint |
| `POST` | `…/webhooks/endpoints/{id}/rotate-secret` | Rotate the signing secret — returns the new secret **once** |
| `GET` | `…/webhooks/endpoints/{id}/subscriptions` | List an endpoint's subscriptions |
| `GET` | `…/webhooks/endpoints/{id}/delivery-attempts` | List delivery attempts (cursor-paginated) |
| `POST` | `/v1/organizations/{orgId}/webhooks/subscriptions` | Create a subscription |
| `GET` / `PATCH` / `DELETE` | `…/webhooks/subscriptions/{id}` | Read, update, delete a subscription |
| `GET` | `…/webhooks/delivery-attempts/{id}` | Read one delivery attempt |
| `POST` | `…/webhooks/delivery-attempts/{id}/replay` | Manually replay a delivery |

Endpoint URLs must be HTTPS. Reads require the `organization.webhook.read` (or `project.webhook.read`) permission; writes require `organization.webhook.write` (or `project.webhook.write`). Public ids use the prefixes `whe_` (endpoint), `whs_` (subscription), and `whd_` (delivery attempt).

## Which events you can subscribe to

Subscriptions filter the **platform event log** — the same stream that feeds the [audit log](/platform/audit/audit-log). A subscription's `eventType` is either an exact type, a prefix wildcard like `project.*` (matches `project.created`, `project.archived`, …), or `*` for everything. Representative types:

| Area | Event types |
| --- | --- |
| Workspace & membership | `organization.created`, `membership.added`, `membership.updated`, `membership.removed`, `invite.created`, `invite.accepted`, `invite.revoked` |
| Teams | `team.created`, `team.updated`, `team.deleted`, `team.member.added`, `team.member.removed` |
| Projects & environments | `project.created`, `project.archived`, `environment.created`, `environment.archived` |
| Identity | `api_key.created`, `api_key.revoked` |
| Configuration | `settings.updated`, `feature.updated`, `secrets.updated` |
| Billing | `subscription.activated`, `subscription.updated`, `subscription.canceled`, `invoice.paid`, `payment.failed`, `entitlements.updated` |
| Webhooks (management) | `webhook_endpoint.created`, `webhook_endpoint.updated`, `webhook_endpoint.disabled`, `webhook_endpoint.enabled`, `webhook_endpoint.secret_rotated`, `webhook_subscription.created` |
| Source control (GitHub) | `scm.push`, `scm.pull_request.opened`, `scm.pull_request.merged`, `scm.check.completed`, `scm.release.published` — see [GitHub integration](/platform/integrations/github) |

:::note
The delivery lifecycle events `webhook.delivery_succeeded`, `webhook.delivery_failed`, and `webhook.disabled` are emitted onto the event log but are **never fanned out to webhooks**, even under a `*` subscription — this recursion guard prevents deliveries from generating deliveries. Read them from the audit log instead.
:::

## What a delivery looks like

Each delivery is a `POST` to your endpoint with `Content-Type: application/json`, `User-Agent: Orun-Webhooks/1.0`, and the signing headers described in [Verify deliveries](/platform/webhooks/verifying-deliveries). The body carries the event:

```json
{
  "id": "5f0c9c2e-8a51-4d5f-b0a9-1f6d2f6f9a11",
  "type": "project.created",
  "occurred_at": "2026-07-02T09:14:03.000Z",
  "data": {
    "name": "storefront",
    "slug": "storefront"
  }
}
```

`id` is the event-log id — stable across retries and replays, so use it for consumer-side deduplication.

## Create an endpoint end-to-end

**1. Create the endpoint.**

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_2f8a1c9e/webhooks/endpoints \
  -H "Authorization: Bearer $ORUN_CLOUD_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-hooks-endpoint-001" \
  -d '{"url": "https://hooks.example.com/orun-cloud", "name": "Production consumer"}'
```

```json
{
  "data": {
    "endpoint": {
      "id": "whe_7c1d2a9b3e4f5a6b7c8d9e0f1a2b3c4d",
      "orgId": "org_2f8a1c9e",
      "projectId": null,
      "url": "https://hooks.example.com/orun-cloud",
      "name": "Production consumer",
      "status": "active",
      "secretVersion": 1,
      "createdAt": "2026-07-02T09:14:03.000Z"
    }
  },
  "meta": { "requestId": "req_01j9x2", "cursor": null }
}
```

**2. Fetch the signing secret.** The create response never contains secret material. Call `rotate-secret` once — the response is the only time the plaintext (`whsec_…`) is revealed; store it in your secret manager.

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_2f8a1c9e/webhooks/endpoints/whe_7c1d2a9b3e4f5a6b7c8d9e0f1a2b3c4d/rotate-secret \
  -H "Authorization: Bearer $ORUN_CLOUD_API_KEY"
```

**3. Subscribe to event types.**

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_2f8a1c9e/webhooks/subscriptions \
  -H "Authorization: Bearer $ORUN_CLOUD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"endpointId": "whe_7c1d2a9b3e4f5a6b7c8d9e0f1a2b3c4d", "eventType": "project.*"}'
```

The same flow with the SDK:

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_API_KEY! },
});

const { endpoint } = await client.webhooks.createEndpoint(
  "org_2f8a1c9e",
  { url: "https://hooks.example.com/orun-cloud", name: "Production consumer" },
  { idempotencyKey: "create-hooks-endpoint-001" },
);

// Reveal-once: store `secret` immediately, it is never readable again.
const { secret } = await client.webhooks.rotateSecret("org_2f8a1c9e", endpoint.id);

await client.webhooks.createSubscription("org_2f8a1c9e", {
  endpointId: endpoint.id,
  eventType: "project.*",
});
```

Project-scoped endpoints work the same way via `client.webhooks.createProjectEndpoint(orgId, projectId, …)` — they only receive events for that project, and are governed by the project-level `project.webhook.*` permissions.

## Related

- [Verify deliveries](/platform/webhooks/verifying-deliveries)
- [Retries & replay](/platform/webhooks/retries-and-replay)
- [Audit log](/platform/audit/audit-log)
- [Webhooks API reference](/api/resources/webhooks)
