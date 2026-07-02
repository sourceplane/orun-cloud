---
title: Idempotency
description: Stripe-style request replay with the Idempotency-Key header — retry writes safely without double-creating resources.
---

Write requests to the Orun Cloud API support **Stripe-style idempotency**: send a caller-owned `Idempotency-Key` header on any `POST`, `PATCH`, `PUT`, or `DELETE`, and retries with the same key return the recorded response of the first attempt instead of executing again. A timed-out create you retry can never double-create.

```bash
curl -X POST https://api.orun.dev/v1/organizations/ws_a1b2c3d4/projects \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-checkout-api-2026-07-02" \
  -d '{"name": "checkout-api"}'
```

```ts
await client.projects.create(
  "org_1f6a3c9e",
  { name: "checkout-api" },
  { idempotencyKey: "create-checkout-api-2026-07-02" },
);
```

## How replay works

1. The first request with a given key executes normally and its response is recorded at the edge.
2. Any retry with the same key within the window returns the recorded response — status, allow-listed headers, and body — without invoking the backend again.
3. After the window expires, the key is forgotten and a request with it executes fresh.

- **Window:** 24 hours from the first response.
- **Replay marker:** replayed responses carry `x-saas-replay-source: edge-idempotency`, so you can distinguish a replay from a fresh execution in logs.
- **What gets recorded:** any final response below HTTP 500 — including 4xx errors. A recorded `422` replays as a `422`. Transient `5xx` responses are never recorded, so a retry after a server error executes for real.
- **Header allow-list:** only a strict allow-list of response headers is persisted and replayed (`content-type`, `content-language`, `cache-control`, `etag`, `x-request-id`, `x-saas-replay-source`). Session-bearing headers such as `set-cookie` are never stored.

## Scope

Keys are scoped per **workspace + route shape**: the record key combines the workspace segment from the path, the route with concrete ids normalized to placeholders, and your `Idempotency-Key` value. Consequences:

- The same key in two different workspaces never collides.
- The same key on two different routes (e.g. create-project vs create-webhook) never collides.
- Reusing a key on the *same* route in the same workspace within 24 h replays — even if you changed the request body. Use a fresh key for each distinct operation.

## Key format and naming

A key must be 1–255 characters of printable ASCII (`U+0020`–`U+007E`) after trimming. A present-but-malformed key (empty, too long, or containing control/non-ASCII characters) is rejected with `400 validation_failed` **before any work executes** — `details` carries `header: "Idempotency-Key"` and a stable `reason` (`empty`, `too_long`, `illegal_characters`).

Good keys are either:

- **A UUID per logical operation** — generate once, reuse across all retries of that operation: `d3b7f0a2-8c1e-4b5f-9a6d-2e7c8f0a1b3c`.
- **A deterministic operation name** — derived from your own state so independent workers converge: `invoice-2026-07-cust_8842-finalize`.

Do not derive keys from timestamps of the retry itself — every retry would get a new key and replay protection is lost.

## Absent key

The header is optional. Without it, an unsafe request executes exactly once per request sent — no recording, no replay. Reads (`GET`, `HEAD`) have no idempotency semantics; a key on a read is ignored.

:::note
The replay store **fails open**: if the storage backing it is unavailable, requests execute normally without recording or replay rather than failing with a 5xx. The tradeoff is deliberate — a cache outage must not take down writes — but it means idempotency is best-effort protection, not a transactional guarantee. Design critical operations to also be safe under at-least-once execution (e.g. unique constraints, upserts).
:::

## SDK usage

The SDK is Stripe-parity: it never auto-generates keys. Pass `idempotencyKey` in the per-request options on any write; when omitted, no header is sent. The SDK also has no built-in retries — pair `idempotencyKey` with your own retry loop:

```ts
const key = crypto.randomUUID();
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    return await client.projects.create(orgId, body, { idempotencyKey: key });
  } catch (err) {
    if (attempt === 2 || !isRetryable(err)) throw err;
    await sleep(500 * 2 ** attempt);
  }
}
```

## Related

- [Errors](/api/errors)
- [Rate limits](/api/rate-limits)
- [SDK](/developers/sdk)
- [CLI](/developers/cli)
