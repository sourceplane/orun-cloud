---
title: Rate limits
description: Token-bucket rate limiting per workspace and per identity, the per-family caps, response headers, and how to back off.
---

The Orun Cloud API rate-limits every request with a **token bucket** that refills continuously over a 60-second window. Two independent scopes are evaluated per request, and either one can deny it:

- **`org`** — keyed on the workspace in the path (`/v1/organizations/{ref}/…`); skipped on routes with no workspace segment.
- **`identity`** — keyed on a SHA-256 fingerprint of the bearer token (the same token shares one bucket regardless of actor type). Unauthenticated requests fall back to an anonymous bucket keyed by client IP + route family, so a single IP cannot bypass the limit.

Because buckets refill continuously (limit ÷ 60 tokens per second), short bursts up to the full limit are absorbed and capacity comes back gradually rather than at a hard window boundary.

## Limits by route family

Every route belongs to a family; each family has its own caps per 60 s window:

| Family | Routes | Per identity | Per workspace |
|---|---|---|---|
| `auth` | Login, OAuth, CLI device flow, OIDC exchange | 10 | 60 |
| `audit` | Audit log reads | 120 | 600 |
| `org` | Workspaces, members, invitations, teams, API keys | 60 | 300 |
| `project` | Projects and environments | 60 | 300 |
| `config` | Settings, feature flags, secrets | 60 | 300 |
| `webhooks` | Webhook endpoints and deliveries | 60 | 300 |
| `metering` | Usage and quotas | 60 | 300 |
| `billing` | Plans, checkout, portal | 60 | 300 |
| `notifications` | Notification preferences | 60 | 300 |
| `integrations` | GitHub integration | 60 | 300 |
| `state` | State plane | 60 | 300 |

`auth` is deliberately tight — login flows are the brute-force target. `audit` is read-only and raised so export loops do not starve.

## Response headers

Every response (not just 429s) carries per-scope counters:

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit-org` / `X-RateLimit-Limit-identity` | Bucket capacity for the scope |
| `X-RateLimit-Remaining-org` / `X-RateLimit-Remaining-identity` | Whole tokens left |
| `X-RateLimit-Reset-org` / `X-RateLimit-Reset-identity` | Unix epoch seconds when the bucket is full again |

The `-org` headers appear only on workspace-scoped routes.

## 429 responses

When a bucket is empty, the API returns `429` with a `Retry-After` header (seconds) and the standard error envelope naming the scope that tripped:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Rate limit exceeded for identity scope. Retry after 3 seconds.",
    "details": { "scope": "identity", "retryAfterSeconds": 3 },
    "requestId": "req_2b3c4d5e6f7a8b9c0d1e2f3a"
  }
}
```

## Enforcement precision

Enforcement differs by method class, trading precision for latency where it is safe:

- **Writes** (`POST`, `PATCH`, `PUT`, `DELETE`) use durable, globally consistent counters — each bucket is a single-threaded Durable Object, so the consume is atomic and the cap is exact.
- **Reads** (`GET`, `HEAD`) use a fast local approximation with no network round-trip. The effective global read limit can exceed the nominal cap under wide fan-out; caps are generous and reads are not the abuse vector writes are.

:::note
The limiter **fails open**: if its backing store is unavailable, requests are admitted (without rate-limit headers) rather than rejected. An infrastructure outage in the limiter never turns into a platform-wide 429.
:::

## Backing off

- Honor `Retry-After` (or `details.retryAfterSeconds`) on 429 before retrying; add jitter when many workers share an identity or workspace.
- Watch `X-RateLimit-Remaining-*` proactively and smooth bursts before you hit zero.
- Spread bulk work: buckets refill continuously, so a steady ~1 req/s per identity on default families never trips.
- Pair retried writes with an [idempotency key](/api/idempotency) so a request denied mid-burst is safe to resend.

The SDK throws a typed `RateLimitError` with everything decoded — it has no built-in retries, so drive the backoff yourself:

```ts
import { RateLimitError } from "@saas/sdk";

try {
  await client.projects.create(orgId, body, { idempotencyKey: key });
} catch (err) {
  if (err instanceof RateLimitError) {
    console.log(err.scope);             // "org" | "identity" | null
    console.log(err.retryAfterSeconds); // number | null
    console.log(err.identityWindow);    // { scope, limit, remaining, resetAt } | undefined
    await sleep((err.retryAfterSeconds ?? 1) * 1000);
    // retry with the same idempotency key
  }
}
```

## Related

- [Errors](/api/errors)
- [Idempotency](/api/idempotency)
- [Authentication](/api/authentication)
- [SDK](/developers/sdk)
