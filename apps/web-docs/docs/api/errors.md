---
title: Errors
description: The Orun Cloud error envelope, the full error-code table, retry guidance, and the SDK's typed error classes.
---

Every non-2xx response from the Orun Cloud API uses a single **error envelope**. The `code` is a stable machine-readable identifier — branch on it, not on the message text.

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Request body failed validation",
    "details": { "fields": { "name": ["must not be empty"] } },
    "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a21"
  }
}
```

- `code` — one of the identifiers below.
- `message` — human-readable; may change without notice.
- `details` — code-specific structured context (may be `{}`).
- `requestId` — quote this in support requests; it ties the response to server-side traces.

## Error codes

| Code | HTTP status | Meaning | Retry guidance |
|---|---|---|---|
| `bad_request` | 400 | Malformed request (bad JSON, invalid parameter) | Do not retry unchanged; fix the request |
| `unauthenticated` | 401 | Missing, invalid, expired, or revoked credential | Do not retry until the credential is fixed |
| `forbidden` | 403 | Valid credential, insufficient permission | Do not retry; grant the required role |
| `not_found` | 404 | Resource or route does not exist (or ref did not resolve) | Do not retry unchanged |
| `unsupported` | 405 / 415 | Method not allowed on this route / unsupported media type | Do not retry unchanged |
| `conflict` | 409 | State conflict (duplicate slug, concurrent modification) | Re-read the resource, then decide |
| `precondition_failed` | 412 | A required precondition on the resource was not met | Re-read the resource, then decide |
| `validation_failed` | 422 | Body parsed but failed field-level validation | Do not retry unchanged; see `details.fields` |
| `rate_limited` | 429 | Token bucket exhausted for a scope | Retry after `Retry-After` seconds |
| `internal_error` | 500 | Unexpected server failure | Retry with backoff; include `requestId` if reporting |

Unknown codes may appear in the future — treat any unrecognized code as non-retryable by default and fall back on the HTTP status.

## Validation errors

`validation_failed` carries field-level violations in `details.fields` — a map of field name to an array of human-readable messages. A malformed `Idempotency-Key` header also produces `validation_failed` (with `details.header` and `details.reason`) — see [Idempotency](/api/idempotency).

A worked example — creating a project with an empty name:

```bash
curl -X POST https://api.orun.dev/v1/organizations/ws_a1b2c3d4/projects \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": ""}'
```

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Request body failed validation",
    "details": {
      "fields": {
        "name": ["must not be empty"]
      }
    },
    "requestId": "req_3e2d1c0b9a8f7e6d5c4b3a21"
  }
}
```

## Rate-limit errors

`rate_limited` (429) includes `details: { "scope": "org" | "identity", "retryAfterSeconds": <n> }` plus a `Retry-After` response header. See [Rate limits](/api/rate-limits) for the scopes and headers.

## SDK typed errors

The `@saas/sdk` client decodes every non-2xx response into a typed error class. All of them extend **`OrunCloudError`**, which exposes `code`, `status`, `requestId`, `details`, the raw `envelope`, and (when available) the original `response`. Unknown codes decode to the base class, so `instanceof OrunCloudError` always matches.

| Code | SDK class | Extra fields |
|---|---|---|
| `bad_request` | `BadRequestError` | — |
| `unauthenticated` | `UnauthenticatedError` | — |
| `forbidden` | `ForbiddenError` | — |
| `not_found` | `NotFoundError` | — |
| `conflict` | `ConflictError` | — |
| `precondition_failed` | `PreconditionFailedError` | — |
| `validation_failed` | `ValidationError` | `fields: Record<string, string[]>` |
| `unsupported` | `UnsupportedError` | — |
| `rate_limited` | `RateLimitError` | `retryAfterSeconds`, `scope`, `windows` (+ `orgWindow` / `identityWindow` accessors) |
| `internal_error` | `InternalError` | — |

```ts
import { OrunCloud, ValidationError, RateLimitError } from "@saas/sdk";

try {
  await client.projects.create("org_1f6a3c9e", { name: "" });
} catch (err) {
  if (err instanceof ValidationError) {
    console.error(err.fields); // { name: ["must not be empty"] }
  } else if (err instanceof RateLimitError) {
    await sleep((err.retryAfterSeconds ?? 1) * 1000);
  } else {
    throw err; // includes err.requestId for support
  }
}
```

:::note
The SDK has no built-in retries — retry policy is yours. `RateLimitError.retryAfterSeconds` and the code table above tell you what is safe to retry.
:::

## Related

- [API overview](/api/overview)
- [Rate limits](/api/rate-limits)
- [Idempotency](/api/idempotency)
- [SDK](/developers/sdk)
