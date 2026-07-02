---
title: CLI & CI authentication
description: The CLI device flow with rotating refresh tokens, and keyless GitHub Actions auth via OIDC exchange.
---

Machines authenticate to Orun Cloud two ways, neither of which parks a long-lived secret on disk or in CI settings:

- **CLI device flow** — a human approves a device in the console once; the CLI then holds a short-lived (~15 min) access JWT plus a rotating, single-use refresh token.
- **GitHub Actions OIDC exchange** — a workflow trades its runner-issued OIDC token for a short-lived platform token bound to one (workspace, project). No stored secret at all.

Both credentials travel as ordinary `Authorization: Bearer` headers.

## CLI device flow

The device flow is RFC-8628-shaped: the CLI asks for a code, the human approves it in the console, the CLI polls until approval lands.

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/auth/cli/device/start` | Begin: returns `deviceCode`, `userCode`, `verificationUrl`, `interval` |
| `POST` | `/v1/auth/cli/device/poll` | Poll with `deviceCode` until complete |
| `POST` | `/v1/auth/cli/token` | Redeem a loopback grant, or rotate a refresh token |
| `POST` | `/v1/auth/cli/revoke` | Log a CLI session out (by refresh token) |

**Start** (unauthenticated; `host` is a label shown on the approval page):

```bash
curl -X POST https://api.orun.dev/v1/auth/cli/device/start \
  -H "Content-Type: application/json" \
  -d '{"host": "rahul-laptop"}'
```

```json
{
  "data": {
    "deviceCode": "…machine-polled secret…",
    "userCode": "ABCD-1234",
    "verificationUrl": "https://app.orun.dev/cli/device",
    "interval": 5,
    "expiresAt": "2026-07-02T12:10:00.000Z"
  },
  "meta": { "requestId": "req_5f6a7b8c9d0e", "cursor": null }
}
```

The user opens `verificationUrl` in a signed-in console session and enters the `userCode`. The approval window is 10 minutes.

**Poll** until the grant resolves:

```bash
curl -X POST https://api.orun.dev/v1/auth/cli/device/poll \
  -H "Content-Type: application/json" \
  -d '{"deviceCode": "…"}'
```

While pending: `{"status": "pending", "error": "authorization_pending"}`. Denied by the user → `403 access_denied`; timed out → `410 expired`. On approval:

```json
{
  "data": {
    "status": "complete",
    "session": {
      "accessToken": "eyJ…",
      "expiresAt": "2026-07-02T12:15:00.000Z",
      "refreshToken": "…opaque…",
      "user": { "id": "usr_…", "email": "dev@example.com", "displayName": "Rahul" },
      "orgs": [{ "id": "org_…", "workspaceRef": "ws_a1b2c3d4", "slug": "acme", "name": "Acme", "role": "owner" }]
    }
  },
  "meta": { "requestId": "req_6a7b8c9d0e1f", "cursor": null }
}
```

A browser-loopback variant also exists: `POST /v1/auth/cli/start` returns an `authorizeUrl` (the console's `/cli/approve` page) plus a one-time `cliCode` redeemed via `POST /v1/auth/cli/token` with `grantType: "cli_code"`. Both doors produce the same session kind.

### Token lifetimes and rotation

The access token is a JWT that expires after **~15 minutes**. When it expires, rotate:

```bash
curl -X POST https://api.orun.dev/v1/auth/cli/token \
  -H "Content-Type: application/json" \
  -d '{"grantType": "refresh_token", "refreshToken": "…"}'
```

The response is a fresh access + refresh pair. Refresh tokens are **single-use** and rotate on every refresh; the sliding idle window is ~30 days, capped by a ~90-day absolute session age.

:::warning
Reusing an already-rotated refresh token revokes the **entire token family**. This is deliberate replay defense: a refresh token observed twice means either a retry race (a ~10 s grace window absorbs that) or theft — and theft kills the session. If your CLI session dies unexpectedly, just log in again.
:::

### Manage CLI sessions and grants

Console-authenticated endpoints (user session required):

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/auth/cli/sessions` | List your CLI sessions (host, created, last used, expiry) |
| `DELETE` | `/v1/auth/cli/sessions/{sessionId}` | Revoke one CLI session |
| `GET` | `/v1/auth/cli/grants/{grantId}` | Inspect a pending login grant (also `?userCode=`) |
| `POST` | `/v1/auth/cli/grants/{grantId}/approve` | Approve a pending device/loopback login |
| `POST` | `/v1/auth/cli/grants/{grantId}/deny` | Deny it |

```ts
const { sessions } = await client.cliSessions.list();
await client.cliSessions.revoke(sessions[0].id);
// approving a device by its human code:
await client.cliSessions.approveByUserCode("ABCD-1234");
```

:::note
The shipped `orun-cloud login` command currently uses a **token-paste** flow — you paste a bearer token (an API key, or a session token in development) and it is stored in the OS keychain or `~/.config/orun-cloud/credentials.json` (mode 0600). The device-flow endpoints above are live server-side; the CLI switches to them as the flows converge.
:::

## GitHub Actions OIDC exchange

`POST /v1/auth/oidc/exchange` turns a GitHub Actions runner's OIDC token into a platform **workflow token** — actor kind `workflow`, bound to exactly one (workspace, project), expiring in ~15 minutes. The workspace's repository link *is* the trust binding: the server verifies the OIDC token's signature against GitHub's JWKS (audience `orun-cloud`), resolves the repository to its linked workspace and project, and applies the link's CI gate. Nothing is auto-created on this path.

```bash
# Inside a GitHub Actions job with `permissions: id-token: write`
OIDC_TOKEN=$(curl -sH "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=orun-cloud" | jq -r .value)

curl -X POST https://api.orun.dev/v1/auth/oidc/exchange \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$OIDC_TOKEN\"}"
```

```json
{
  "data": {
    "accessToken": "eyJ…",
    "tokenType": "Bearer",
    "expiresAt": "2026-07-02T12:15:00.000Z",
    "orgId": "org_1a2b3c4d5e6f70819203a4b5c6d7e8f9",
    "workspaceId": "ws_a1b2c3d4",
    "projectId": "prj_9f8e7d6c5b4a39281706f5e4d3c2b1a0"
  },
  "meta": { "requestId": "req_7b8c9d0e1f2a", "cursor": null }
}
```

If the repository is linked into more than one workspace, pass `org` (slug or `org_…`) to disambiguate — the hint is checked against authorized links, never trusted.

| Status | Code | Meaning |
|---|---|---|
| 401 | `unauthenticated` | OIDC token invalid, expired, or wrong audience |
| 404 | `not_found` | Repo not linked, or the `org` hint matches no authorized link |
| 409 | `conflict` | Repo linked to multiple workspaces and no `org` hint given |
| 403 | `forbidden` | The link's CI gate denied it — `details.reason` is `oidc_disabled`, `ref_not_allowed`, or `environment_not_allowed` |

Per-link CI settings let workspace admins require specific refs (glob over the Actions `ref` claim) or deployment environments before a workflow token is minted — so `main`-only deploy tokens are a link setting, not workflow discipline.

:::tip
This is the zero-secret CI path: no API key in repository secrets, nothing to rotate, and a leaked token dies within ~15 minutes and can only touch one project.
:::

## Related

- [Authentication](/platform/identity/authentication)
- [API keys](/platform/identity/api-keys)
- [GitHub integration](/platform/integrations/github)
- [CLI reference](/developers/cli)
