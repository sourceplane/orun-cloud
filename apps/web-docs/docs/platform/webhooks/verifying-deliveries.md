---
title: Verify deliveries
description: Verify the HMAC-SHA256 signature on every webhook delivery — with @saas/webhook-verifier, raw Node crypto, or the CLI.
---

Every webhook delivery from Orun Cloud is signed. Verify the signature before trusting the payload — it proves the request came from Orun Cloud, that the body was not tampered with, and (via the timestamp) that it is not a replay of an old delivery.

## The signing scheme

The signature is an **HMAC-SHA256** over the string `"{timestamp}.{body}"` — the value of the `X-Webhook-Timestamp` header, a literal `.`, and the raw request body — keyed with your endpoint's signing secret. The result is sent as lowercase hex with a `sha256=` prefix.

| Header | Value |
| --- | --- |
| `X-Webhook-Signature` | `sha256=<lowercase hex HMAC-SHA256 of "{timestamp}.{body}">` |
| `X-Webhook-Timestamp` | Delivery timestamp (unix seconds) — the exact value signed |
| `X-Webhook-ID` | Delivery attempt id (unique per attempt) |
| `X-Webhook-Signature-Previous` | Present only during a secret-rotation grace window (see below) |

To verify:

1. Read `X-Webhook-Timestamp` and reject if it is outside your tolerance window (**default 300 seconds** of skew, either direction).
2. Compute `HMAC-SHA256(secret, "{timestamp}.{rawBody}")` using the header value verbatim.
3. Compare against the hex after `sha256=` using a **constant-time comparison** — never `===` on strings, which leaks timing.

:::warning Always verify the raw body
Compute the HMAC over the exact bytes you received — before any JSON parsing. Re-serializing a parsed object (`JSON.stringify(req.body)`) reorders keys and changes whitespace, producing a different byte sequence and a false signature mismatch. Configure your framework to give you the raw request body (e.g. `express.raw()`, `await request.text()`).
:::

## Verify with `@saas/webhook-verifier`

**`@saas/webhook-verifier`** is the official zero-dependency verifier. It uses only WebCrypto, so the same code runs on Node ≥ 20, Cloudflare Workers, Bun, and browsers. Its two functions are `verifyWebhookSignature` and `signWebhookPayload`.

```ts
import { verifyWebhookSignature } from "@saas/webhook-verifier";

export async function handler(request: Request): Promise<Response> {
  const body = await request.text(); // raw body, before parsing

  const result = await verifyWebhookSignature({
    secret: process.env.ORUN_CLOUD_WEBHOOK_SECRET!, // whsec_…
    body,
    headers: request.headers, // Headers object or a plain record, case-insensitive
    // toleranceSeconds: 300,  // the default; tighten if your clocks are synced
  });

  if (!result.ok) {
    // result.reason is one of: missing_signature | missing_timestamp |
    // malformed_timestamp | timestamp_out_of_tolerance |
    // malformed_signature | signature_mismatch
    return new Response(`rejected: ${result.reason}`, { status: 401 });
  }

  const event = JSON.parse(body); // now trusted — dispatch on event.type
  return new Response("ok");
}
```

`verifyWebhookSignature` returns a tagged result — `{ ok: true }` or `{ ok: false, reason }` — so you can log the exact failure mode. The comparison is constant-time internally (full-length XOR accumulator, no short-circuit).

The companion `signWebhookPayload({ secret, body, timestamp })` produces the exact `sha256=<hex>` header value Orun Cloud emits — useful for test fixtures:

```ts
import { signWebhookPayload } from "@saas/webhook-verifier";

const signature = await signWebhookPayload({
  secret: "whsec_test",
  body: JSON.stringify({ id: "evt_123", type: "test.event", data: {} }),
  timestamp: "1751446443",
});
// → "sha256=…" — feed into your handler tests alongside X-Webhook-Timestamp
```

## Verify with raw Node crypto

If you prefer no dependency at all:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;

export function verify(secret: string, rawBody: string, headers: Record<string, string>): boolean {
  const signature = headers["x-webhook-signature"];
  const timestamp = headers["x-webhook-timestamp"];
  if (!signature?.startsWith("sha256=") || !timestamp) return false;

  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(skew) || skew > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const provided = Buffer.from(signature.slice("sha256=".length), "hex");
  const wanted = Buffer.from(expected, "hex");
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
```

## Secret rotation and the grace window

Rotate an endpoint's secret with `POST …/webhooks/endpoints/{id}/rotate-secret`. The response reveals the new `whsec_…` secret exactly once and bumps the endpoint's `secretVersion`.

During the rotation **grace window** (default 24 hours; the response's `previousSecretExpiresAt` and `gracePeriodSeconds` tell you exactly), both secrets remain usable: each delivery carries the primary `X-Webhook-Signature` computed with the **new** secret and an additional `X-Webhook-Signature-Previous` computed with the **old** one. Roll over safely by accepting a delivery if *either* header verifies against the secret you currently hold, then deploy the new secret before the window closes.

:::tip
Rotation is audited (`webhook_endpoint.secret_rotated` on the event log) and the plaintext never appears in events, audit rows, or any later read — if you lose the secret, rotate again.
:::

## Verify and sign from the CLI

The [`orun-cloud` CLI](/developers/cli) ships local, offline helpers — pure crypto, no network, no login required:

```bash
# Verify: exit 0 on success, exit 4 with a reason on verifier failure
cat payload.json | orun-cloud webhook verify \
  --secret="$WEBHOOK_SECRET" \
  --signature="sha256=ab12…" \
  --timestamp="1751446443" \
  --tolerance-seconds=300

# Sign: produce the header values for a fixture
cat payload.json | orun-cloud webhook sign \
  --secret="$WEBHOOK_SECRET" \
  --timestamp="1751446443" \
  --output=json
```

Both commands read the body from STDIN or `--body=PATH` and never trim, re-encode, or JSON-parse it — the bytes are hashed verbatim.

## Related

- [Webhooks overview](/platform/webhooks/overview)
- [Retries & replay](/platform/webhooks/retries-and-replay)
- [CLI reference](/developers/cli)
