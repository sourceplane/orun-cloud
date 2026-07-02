---
title: Integrations
description: GitHub App connections, the scoped token broker, inbound delivery inspection, admission grants, and project repo links.
---

The **integrations API** manages provider **connections** (a GitHub App installation bound to a workspace), project **repo links**, the inbound **delivery log** with replay, admission **grants** for account-shared connections, and a **token broker** that exchanges your Orun Cloud credential for a short-lived, repo-scoped GitHub installation token. The install flow, sharing model, and event taxonomy are described in [GitHub integration](/platform/integrations/github).

Connecting GitHub is gated by the `feature.integrations.github` entitlement; repo links by `limit.repo_links` (see [Plans and entitlements](/platform/billing/plans-and-entitlements)). Ids are prefixed: connections `int_…`, inbound deliveries `igd_…`, repo links `repl_…`.

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/v1/organizations/{orgId}/integrations/github/connect` | `organization.integration.connect` | Start the App install flow |
| `GET` | `/v1/organizations/{orgId}/integrations` | `organization.integration.read` | List connections |
| `GET` | `/v1/organizations/{orgId}/integrations/{connectionId}` | `organization.integration.read` | Get a connection |
| `PATCH` | `/v1/organizations/{orgId}/integrations/{connectionId}` | `organization.integration.manage` | Update the connection (`shareMode`) |
| `DELETE` | `/v1/organizations/{orgId}/integrations/{connectionId}` | `organization.integration.manage` | Revoke a connection |
| `POST` | `/v1/organizations/{orgId}/integrations/github/token` | `organization.integration.token.issue` | Broker a scoped installation token |
| `GET` | `/v1/organizations/{orgId}/integrations/{connectionId}/repositories` | `organization.integration.read` | Browse repositories the installation can see |
| `GET` | `/v1/organizations/{orgId}/integrations/{connectionId}/deliveries` | `organization.integration.read` | List inbound deliveries |
| `POST` | `/v1/organizations/{orgId}/integrations/{connectionId}/deliveries/{deliveryId}/replay` | `organization.integration.manage` | Re-run normalize/emit from the stored delivery |
| `GET` | `/v1/organizations/{orgId}/integrations/{connectionId}/grants` | `organization.integration.manage` | List admission grants |
| `POST` | `/v1/organizations/{orgId}/integrations/{connectionId}/grants` | `organization.integration.manage` | Admit a workspace to a shared connection |
| `DELETE` | `/v1/organizations/{orgId}/integrations/{connectionId}/grants/{workspaceOrgId}` | `organization.integration.manage` | Revoke an admission grant |
| `GET` | `/v1/organizations/{orgId}/projects/{projectId}/repo-links` | `organization.integration.read` | List a project's repo links |
| `POST` | `/v1/organizations/{orgId}/projects/{projectId}/repo-links` | `project.repo_link.write` | Link a repository to the project |
| `PATCH` | `/v1/organizations/{orgId}/projects/{projectId}/repo-links/{repoLinkId}` | `project.repo_link.write` | Update `branchEnvMap` / `defaultBranch` |
| `DELETE` | `/v1/organizations/{orgId}/projects/{projectId}/repo-links/{repoLinkId}` | `project.repo_link.write` | Unlink the repository |
| `GET` | `/ingress/github/setup` | — (provider only) | App install callback — see below |
| `POST` | `/ingress/github/webhook` | — (provider only) | Inbound GitHub webhook — see below |

## Connect GitHub

Connect creates a `pending` connection and returns an `installUrl` carrying a signed single-use state. Open it (the console uses a popup); GitHub redirects the installing user back through the setup ingress, which verifies the state and activates the connection.

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/integrations/github/connect \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "displayName": "acme-github" }'
```

```json
{
  "data": {
    "connection": {
      "id": "int_5b4a39281706f5e4d3c2b1a09f8e7d6c",
      "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
      "provider": "github",
      "status": "pending",
      "scope": "account",
      "shareMode": "auto",
      "displayName": "acme-github",
      "externalAccountLogin": null,
      "externalAccountType": null,
      "repositorySelection": null,
      "createdBy": "usr_3c2b1a0f9e8d7c6b5a49382716050403",
      "connectedAt": null,
      "revokedAt": null,
      "suspendedAt": null,
      "createdAt": "2026-07-02T09:50:00.000Z",
      "updatedAt": "2026-07-02T09:50:00.000Z"
    },
    "installUrl": "https://github.com/apps/orun-cloud/installations/new?state=…"
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a31", "cursor": null }
}
```

Account-owned connections are shared with child workspaces: `shareMode: "auto"` admits every workspace under the account; switch to `"granted"` (via `PATCH`) to admit only workspaces with an explicit grant. Child workspaces see the shared row with `inherited: true` plus `sharedByWorkspaceRef`/`sharedByName` provenance.

## Broker a scoped GitHub token

`POST …/integrations/github/token` exchanges your control-plane credential for a short-lived installation token. Every requested repository must match an active repo link in a project you can access, and requested permissions must be a subset of the App's grant — deny-by-default.

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/integrations/github/token \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repositories": ["456789123"],
    "permissions": { "contents": "read", "checks": "write" }
  }'
```

```json
{
  "data": {
    "token": "ghs_…",
    "expiresAt": "2026-07-02T10:55:00.000Z",
    "repositories": ["456789123"],
    "permissions": { "contents": "read", "checks": "write" }
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a32", "cursor": null }
}
```

:::warning
The token is **revealed exactly once**, never cached or logged platform-side, and expires within **1 hour**. Treat it like a password and let it expire.
:::

## Link a repository to a project

Browse candidate repositories via `GET …/integrations/{connectionId}/repositories` (optional `query` substring filter), then create the link. `branchEnvMap` maps provider branches to environment slugs, validated against the project's live environments.

```ts
const { repoLink } = await client.integrations.createRepoLink(
  "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
  "prj_3e2d1c0b4a5968f7a6b5c4d3e2f1a0b9",
  {
    connectionId: "int_5b4a39281706f5e4d3c2b1a09f8e7d6c",
    repoExternalId: "456789123",
    repoFullName: "acme/storefront",
    defaultBranch: "main",
    branchEnvMap: { main: "prod", staging: "stage" },
  },
  { idempotencyKey: "link-storefront-1" },
);
```

Inbound deliveries attributed to a connection are inspectable at `GET …/{connectionId}/deliveries` (status `received | attributed | emitted | skipped | failed`, `signatureOk`, safe `failureReason`); `POST …/deliveries/{deliveryId}/replay` re-runs normalization from the persisted inbox row — it never re-trusts the wire.

## Provider ingress (provider only)

Two unauthenticated routes exist solely for GitHub to call — do not call them yourself:

| Route | Auth mechanism |
|---|---|
| `GET /ingress/github/setup` | Signed **single-use state** in the query string — the install-callback redirect of the installing user's browser after an App install. Verified by the state secret's owner; no bearer token. |
| `POST /ingress/github/webhook` | **`x-hub-signature-256`** HMAC over the raw body, verified against the App webhook secret before any parse (fails closed). `x-github-delivery` and `x-github-event` headers are forwarded with the raw bytes. |

Both are allowlist-routed and rate-limited per source at the edge.

## Related

- [GitHub integration](/platform/integrations/github)
- [Projects and environments](/platform/projects/projects-and-environments)
- [State (orun remote state)](/api/resources/state)
- [Plans and entitlements](/platform/billing/plans-and-entitlements)
