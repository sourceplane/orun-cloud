---
title: Retries & replay
description: Delivery semantics — at-least-once with exponential backoff, delivery-attempt records, automatic endpoint disabling, and manual replay.
---

Webhook delivery is **at-least-once**. Orun Cloud retries failed deliveries on an exponential backoff schedule, records every attempt, disables endpoints that fail persistently, and lets you replay any past delivery on demand. Build your consumer to be idempotent and the rest takes care of itself.

## Retry schedule

A delivery succeeds when your endpoint answers with any **2xx** status within the 10-second delivery timeout. Anything else counts as a failure:

- a **non-2xx** response (recorded as `HTTP <status>`),
- a **timeout** (no response within 10 s, recorded as `timeout`),
- a network or TLS error (recorded with the error message).

Failures are retried up to **5 attempts** total, with exponential backoff between attempts:

| Attempt | Delay after previous failure |
| --- | --- |
| 1 | — (immediate on event dispatch) |
| 2 | 30 s |
| 3 | 120 s |
| 4 | 480 s |
| 5 | 1 920 s |

After the fifth failed attempt the delivery is terminally `failed` and a `webhook.delivery_failed` event is emitted.

## Delivery-attempt records

Every event × subscription produces a delivery-attempt record you can inspect via `GET …/webhooks/endpoints/{id}/delivery-attempts` (cursor-paginated) or `GET …/webhooks/delivery-attempts/{id}`:

```json
{
  "data": {
    "deliveryAttempt": {
      "id": "whd_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
      "endpointId": "whe_7c1d2a9b3e4f5a6b7c8d9e0f1a2b3c4d",
      "subscriptionId": "whs_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
      "eventId": "5f0c9c2e-8a51-4d5f-b0a9-1f6d2f6f9a11",
      "eventType": "project.created",
      "status": "retrying",
      "attemptNumber": 2,
      "httpStatusCode": 503,
      "failureReason": "HTTP 503",
      "nextRetryAt": "2026-07-02T09:16:03.000Z",
      "completedAt": null
    }
  },
  "meta": { "requestId": "req_01j9x4", "cursor": null }
}
```

| Field | Meaning |
| --- | --- |
| `status` | `pending` → `retrying` → `success` \| `failed` |
| `attemptNumber` | How many HTTP attempts have been made |
| `httpStatusCode` | Last HTTP status received, if any |
| `failureReason` | `HTTP <status>`, `timeout`, `endpoint_disabled`, or the network error |
| `nextRetryAt` | When the next retry is due (`null` once terminal) |

## Automatic endpoint disabling

If an endpoint accumulates **5 consecutive terminal delivery failures**, Orun Cloud disables it automatically: the endpoint's `status` becomes `disabled` with `disabledReason: "repeated_delivery_failures"`, an auditable `webhook.disabled` event is emitted, and further deliveries to it are recorded as failed with `failureReason: "endpoint_disabled"` instead of hitting your server. A single success resets the streak.

This is distinct from disabling on *your* side: `POST …/webhooks/endpoints/{id}/disable` pauses an endpoint deliberately (deploy windows, incident response) with an optional `reason`. Either way, bring it back with `POST …/webhooks/endpoints/{id}/enable`, then replay what you missed.

## Manual replay

Replay re-sends a past delivery — same event, same endpoint — through the normal signing and delivery pipeline:

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_2f8a1c9e/webhooks/delivery-attempts/whd_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d/replay \
  -H "Authorization: Bearer $ORUN_CLOUD_API_KEY"
```

```ts
const { deliveryAttempt } = await client.webhooks.replayDelivery(
  "org_2f8a1c9e",
  "whd_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
);
```

Replay creates a **new** delivery attempt (fresh `whd_…` id, `attemptNumber` starting at 1) carrying the full original event payload; the original attempt is unchanged. The new attempt inherits every delivery rule — signing (including the rotation grace window), the retry schedule, and the disabled-endpoint gate — and the response carries its post-delivery status. Replaying is how you recover after re-enabling a disabled endpoint or fixing a consumer bug.

## Lifecycle events and the recursion guard

The pipeline emits its own events onto the event log:

| Event | When |
| --- | --- |
| `webhook.delivery_succeeded` | An attempt completed with 2xx |
| `webhook.delivery_failed` | An attempt failed terminally (all retries exhausted) |
| `webhook.disabled` | An endpoint was auto-disabled after consecutive failures |

Their payloads carry `delivery_attempt_id`, `endpoint_id`, `subscription_id`, `source_event_id`, `source_event_type`, `http_status_code`, `failure_reason`, and `attempt_number` — enough to alert on delivery health from the [audit log](/platform/audit/audit-log).

:::note Recursion guard
These lifecycle events are **excluded from webhook fanout** — even a `*` subscription never receives them. Delivering a "delivery failed" event could fail, emit another event, and recurse without bound; the dispatcher skips them by construction.
:::

## Build an idempotent consumer

Because delivery is at-least-once and replay is a first-class operation, your consumer may see the same event more than once. Deduplicate on the **event id** — the `id` field in the delivery body — which is stable across retries and replays:

```ts
const event = JSON.parse(rawBody);
const fresh = await db.insertIgnoreDuplicate("processed_events", { id: event.id });
if (!fresh) return new Response("ok"); // already processed — ack and skip
await process(event);
```

Always return 2xx quickly (enqueue heavy work) — slow handlers hit the 10 s timeout and burn retry attempts. `X-Webhook-ID` identifies the *attempt*, not the event; use it for tracing, not deduplication.

## Related

- [Webhooks overview](/platform/webhooks/overview)
- [Verify deliveries](/platform/webhooks/verifying-deliveries)
- [Audit log](/platform/audit/audit-log)
- [Webhooks API reference](/api/resources/webhooks)
