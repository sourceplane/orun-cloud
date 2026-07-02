---
title: Authentication
description: Bearer credentials accepted by the Orun Cloud API, how the edge resolves the caller, and which routes are public.
---

Every authenticated request to the Orun Cloud API carries a single header:

```
Authorization: Bearer <token>
```

The transport is identical for every credential kind — what differs is how the token was minted and what it can do. This page covers the API mechanics; for obtaining credentials, see the identity guides linked below.

## Credential kinds

| Credential | Token shape | Minted by | Typical use |
|---|---|---|---|
| **Session token** | `sps_ses_<id>.<secret>` | Console login (`/v1/auth/login/*`, OAuth) | Browsers, interactive tooling |
| **API key** | Workspace-scoped secret (service principal) | Console or API key endpoints | Servers, automation |
| **CLI access JWT** | Short-lived JWT (~15 min) | CLI device flow; refreshed with a rotating single-use refresh token | `orun-cloud` CLI, local dev |
| **Workflow token** | Actor token bound to (workspace, project) | `POST /v1/auth/oidc/exchange` from a GitHub Actions OIDC token | CI/CD, keyless deploys |

```bash
curl https://api.orun.dev/v1/organizations/ws_a1b2c3d4/projects \
  -H "Authorization: Bearer $ORUN_CLOUD_API_KEY"
```

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_API_KEY! },
});
```

:::warning
CLI refresh tokens are single-use: reusing one revokes the whole token family. This is deliberate — a replayed refresh token is treated as theft.
:::

## How the edge resolves the actor

The API edge does not interpret the token itself. It forwards the bearer to the identity service, which classifies the credential and returns an **actor** — the subject id and type (user, service principal, CLI session, or workflow actor) plus any bindings the token carries (workspace for API keys, workspace + project for workflow tokens, workspace list for CLI JWTs). The edge then injects that actor context into the downstream service; authorization decisions (RBAC) happen against the resolved actor, never the raw token.

Successful resolutions are cached briefly at the edge (keyed by a hash of the token) to keep the hot path fast. Failed resolutions are never cached.

## Unauthenticated routes

A small set of routes deliberately accepts no bearer, because the request body or flow itself carries the proof:

| Route | Why it is public |
|---|---|
| `POST /v1/auth/login/start`, `POST /v1/auth/login/complete` | The login flow is how you get a token |
| `GET /v1/auth/oauth/providers`, `GET /v1/auth/oauth/{provider}/start`, `…/callback` | Browser-redirect sign-in; CSRF-protected by a state cookie |
| `POST /v1/auth/cli/start`, `/v1/auth/cli/device/start`, `/v1/auth/cli/device/poll`, `/v1/auth/cli/token`, `/v1/auth/cli/revoke` | CLI device flow — the device code / refresh token is the credential |
| `POST /v1/auth/oidc/exchange` | The GitHub Actions OIDC token in the body is the credential |
| `GET /health` | Service health probe |
| Provider webhook ingress (billing provider webhooks, integration install callbacks) | Authenticated by provider signatures / signed single-use state, not a bearer |

Everything else returns `401 unauthenticated` without a valid bearer. Public auth routes sit in the tightest [rate-limit family](/api/rate-limits) (10 requests/min per identity) to blunt brute force.

## 401 vs 403

The two failure modes are distinct and consistent:

- **`401 unauthenticated`** — the request carried no `Authorization` header, or the token is missing, malformed, expired, or revoked. Fix the credential and retry.
- **`403 forbidden`** — the credential is valid, but the resolved actor lacks the required permission on the target resource (RBAC is deny-by-default). Retrying will not help; the actor needs a role grant.

```json
{
  "error": {
    "code": "unauthenticated",
    "message": "Missing or invalid Authorization header",
    "details": {},
    "requestId": "req_9c8b7a6f5e4d3c2b1a09f8e7"
  }
}
```

## Related

- [Sign-in and sessions](/platform/identity/authentication)
- [API keys](/platform/identity/api-keys)
- [CLI and CI authentication](/platform/identity/cli-and-ci-auth)
- [Access control (RBAC)](/platform/access-control/rbac)
