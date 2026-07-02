---
title: API overview
description: Base URL, versioning, response envelopes, tenancy, request ids, and a map of the Orun Cloud REST API.
---

The **Orun Cloud API** is a JSON REST API served at `https://api.orun.dev`. Every endpoint lives under the `/v1` path prefix, accepts and returns `application/json`, and wraps responses in a consistent envelope so clients can handle success, errors, and pagination the same way everywhere.

```bash
curl https://api.orun.dev/v1/organizations/ws_a1b2c3d4/projects \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

## Versioning

All routes are prefixed with `/v1`. Breaking changes ship under a new version prefix; additive changes (new fields, new endpoints) may appear within `/v1` at any time — clients should ignore unknown response fields.

## Response envelopes

Successful responses wrap the payload in `data` and carry request metadata in `meta`:

```json
{
  "data": { "id": "proj_9f8e7d6c", "name": "checkout-api" },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a21", "cursor": null }
}
```

- `meta.requestId` — the id of this request; echo it in support tickets.
- `meta.cursor` — continuation token on list endpoints; `null` means no more pages. See [Pagination](/api/pagination).

Errors use a single envelope with a stable machine-readable `code`:

```json
{
  "error": {
    "code": "not_found",
    "message": "Route not found: /v1/organizations/org_1a2b3c/nope",
    "details": {},
    "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a21"
  }
}
```

See [Errors](/api/errors) for the full code table.

## Tenancy in the path

Most resources are scoped to a **workspace** and addressed as `/v1/organizations/{ref}/…` — `organizations` is the API's canonical name for what the product calls a workspace. The `{ref}` segment accepts three spellings, all resolved at the edge before routing:

| Ref form | Example | Notes |
|---|---|---|
| Opaque id | `org_1f6a3c9e…` | Canonical; zero-overhead pass-through |
| Workspace ID | `ws_a1b2c3d4` | Durable, immutable public id |
| Slug | `acme-prod` | Mutable vanity label |

A `ws_` ref or slug that does not resolve returns `404 not_found` — the request is never forwarded with an unresolvable reference.

`/v1/workspaces/*` is an accepted alias that rewrites to `/v1/organizations/*` before routing, so both spellings serve identical resources. API examples in these docs use the canonical `/v1/organizations/…` paths.

## Request ids

Every response carries a request id — in `meta.requestId` on success and `error.requestId` on failure. Supply your own with the `x-request-id` header (1–128 characters, letters/digits/`_`/`-`) to correlate with your logs; otherwise the edge generates a `req_…` value. The SDK sends a generated `req_<uuid>` automatically and accepts a `requestId` per-request option.

## Health

`GET /health` is unauthenticated and returns service status:

```json
{
  "status": "ok",
  "service": "api-edge",
  "environment": "production",
  "checks": { "database": { "configured": true, "reachable": true } }
}
```

`status` is `ok` or `degraded` (`degraded` returns HTTP 503).

## Request headers

| Header | Direction | Purpose |
|---|---|---|
| `Authorization: Bearer <token>` | request | Credential — session token, API key, CLI JWT, or workflow token. See [Authentication](/api/authentication) |
| `Content-Type: application/json` | request | Required on requests with a body |
| `Idempotency-Key` | request | Caller-owned replay key for unsafe methods. See [Idempotency](/api/idempotency) |
| `x-request-id` | both | Trace id; echoed in `meta.requestId` / `error.requestId` |
| `X-RateLimit-Limit/Remaining/Reset-{org,identity}` | response | Per-scope rate-limit state. See [Rate limits](/api/rate-limits) |
| `Retry-After` | response | Seconds to wait, on `429` responses |
| `x-saas-replay-source: edge-idempotency` | response | Present when the response is an idempotent replay |

## Resource groups

| Group | Reference |
|---|---|
| Workspaces (organizations) | [Organizations](/api/resources/organizations) |
| Members & invitations | [Members and invitations](/api/resources/members-and-invitations) |
| Teams | [Teams](/api/resources/teams) |
| API keys | [API keys](/api/resources/api-keys) |
| Projects & environments | [Projects and environments](/api/resources/projects-and-environments) |
| Configuration & secrets | [Config](/api/resources/config) |
| Audit log | [Audit](/api/resources/audit) |
| Usage & quotas | [Usage](/api/resources/usage) |
| Billing | [Billing](/api/resources/billing) |
| Outbound webhooks | [Webhooks](/api/resources/webhooks) |
| Notification preferences | [Notifications](/api/resources/notifications) |
| Integrations (GitHub) | [Integrations](/api/resources/integrations) |
| State plane | [State](/api/resources/state) |

## Related

- [Authentication](/api/authentication)
- [Errors](/api/errors)
- [Pagination](/api/pagination)
- [Vocabulary](/getting-started/vocabulary)
