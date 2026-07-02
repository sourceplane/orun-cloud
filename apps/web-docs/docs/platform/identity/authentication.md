---
title: Authentication
description: Users, sessions, email-code sign-in, OAuth, profile, and security events in Orun Cloud.
---

Orun Cloud identity is built on two objects: a **user** (`usr_…`) — a globally unique, email-anchored account that can belong to many workspaces — and a **session** (`sps_ses_<id>.<secret>`) — a revocable bearer token minted at sign-in. Every authenticated console and API request presents the session token as `Authorization: Bearer <token>`; the edge resolves it to an actor before any workspace-scoped routing happens.

Sessions live for 30 days and are stored hashed server-side — the raw token is returned exactly once, at login. On your first sign-in a workspace is created for you automatically, so you land in a working scope rather than an empty account.

## Sign in with an email code

Login is a two-step, magic-link-style challenge: request a code, then redeem it. The code is 6 digits, delivered to your email (notification category `security`), and the challenge expires after 10 minutes.

**Step 1 — start the challenge:**

```bash
curl -X POST https://api.orun.dev/v1/auth/login/start \
  -H "Content-Type: application/json" \
  -d '{"email": "dev@example.com"}'
```

```json
{
  "data": {
    "challengeId": "chl_9f8e7d6c5b4a39281706f5e4",
    "expiresAt": "2026-07-02T12:10:00.000Z",
    "delivery": { "mode": "email", "emailHint": "d***@example.com" }
  },
  "meta": { "requestId": "req_0a1b2c3d4e5f", "cursor": null }
}
```

**Step 2 — redeem the code:**

```bash
curl -X POST https://api.orun.dev/v1/auth/login/complete \
  -H "Content-Type: application/json" \
  -d '{"challengeId": "chl_9f8e7d6c5b4a39281706f5e4", "code": "123456"}'
```

```json
{
  "data": {
    "token": "sps_ses_1f2e3d4c5b6a79880917263544332211.k3J9…",
    "tokenType": "bearer",
    "expiresAt": "2026-08-01T12:00:00.000Z",
    "user": { "id": "usr_7a6b5c4d3e2f10099887766554433221", "email": "dev@example.com", "displayName": null }
  },
  "meta": { "requestId": "req_1b2c3d4e5f6a", "cursor": null }
}
```

An unknown or wrong code returns `not_found`; an expired or already-used challenge returns `precondition_failed`. Challenges are single-use.

With the SDK:

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({ baseUrl: "https://api.orun.dev", auth: { kind: "bearer", token: "" } });

const start = await client.auth.loginStart({ email: "dev@example.com" });
// … user reads the 6-digit code from their inbox …
const { token, user } = await client.auth.loginComplete({
  challengeId: start.challengeId,
  code: "123456",
});
```

:::note
Login endpoints sit in the `auth` rate-limit family — 10 requests per identity and 60 per workspace per 60 s — the strictest bucket on the platform. Failed and successful attempts both record security events.
:::

## Sign in with OAuth

The console can also sign users in through an OAuth provider. The flow is browser-redirect, not JSON:

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/auth/oauth/providers` | Providers that are fully configured — the console renders a button per entry |
| `GET` | `/v1/auth/oauth/{provider}/start` | 302 to the provider's consent page |
| `GET` | `/v1/auth/oauth/{provider}/callback` | Provider redirect target; issues the same session token |

A successful OAuth login mints the same `sps_ses_…` session as the email flow. Account linking is verified-email-or-bust: a provider identity with no verified email cannot attach to or create an account; a verified email that matches an existing user links to that user.

:::note
GitHub (and Google) OAuth sign-in is scaffolded end to end but **credential-blocked in production** — the provider only appears in `/v1/auth/oauth/providers` once OAuth app credentials are configured (see `specs/epics/saas-baseline`, item B1). Email-code login is always available.
:::

## Inspect the current session

```bash
curl https://api.orun.dev/v1/auth/session \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": {
    "session": { "id": "ses_1f2e3d4c5b6a79880917263544332211", "expiresAt": "2026-08-01T12:00:00.000Z", "createdAt": "2026-07-02T12:00:00.000Z" },
    "user": { "id": "usr_7a6b5c4d3e2f10099887766554433221", "email": "dev@example.com", "displayName": "Rahul", "lastOrgSlug": "acme" }
  },
  "meta": { "requestId": "req_2c3d4e5f6a7b", "cursor": null }
}
```

An expired or revoked token returns `401 unauthenticated`. The SDK equivalent is `client.auth.getSession()`.

## Log out

`POST /v1/auth/logout` revokes the session server-side and evicts it from the edge's actor cache, so the token stops working immediately — not at cache expiry.

```ts
await client.auth.logout(); // → { success: true }
```

## Manage your profile

`GET /v1/auth/profile` returns the signed-in user; `PATCH /v1/auth/profile` is a partial update of `displayName` and `lastOrgSlug` (the cross-device default-landing hint the console maintains). Profile routes are session-token only — an API key gets `403`.

```bash
curl -X PATCH https://api.orun.dev/v1/auth/profile \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"displayName": "Rahul Varghese"}'
```

```ts
const { user } = await client.auth.updateProfile({ displayName: "Rahul Varghese" });
```

Changing `displayName` records a security event; updating `lastOrgSlug` does not (it changes on routine navigation).

## Review security events

`GET /v1/auth/security-events` lists the identity-level audit trail for **your own** account — login challenges, session creation and revocation, profile changes, API key lifecycle. Cursor-paginated (`limit` + `cursor`).

```bash
curl "https://api.orun.dev/v1/auth/security-events?limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

Each event carries `eventType` (e.g. `login.challenge.created`, `session.created`, `session.revoked`, `user.profile.updated`, `api_key.created`), `outcome`, `occurredAt`, `requestId`, `ip`, `userAgent`, and `metadata`. Secret-bearing metadata (codes, token hashes, key material) is redacted before it leaves the service.

## Related

- [API keys](/platform/identity/api-keys)
- [CLI & CI authentication](/platform/identity/cli-and-ci-auth)
- [Workspaces & accounts](/platform/workspaces/organizations)
- [API authentication mechanics](/api/authentication)
