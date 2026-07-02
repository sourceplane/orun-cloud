---
title: GitHub integration
description: Connect a GitHub organization through a GitHub App — normalized scm.* events, project ↔ repository links, and a short-lived installation-token broker.
---

The **GitHub integration** connects a workspace to a GitHub account through a **GitHub App** installation. Once connected, Orun Cloud ingests GitHub webhooks into a verified inbox, normalizes them into provider-neutral `scm.*` events on the platform event log, links repositories to projects, and brokers **short-lived, repo-scoped installation tokens** so your automation never holds a long-lived GitHub credential.

The integration is gated by the `feature.integrations.github` entitlement — calls on plans without it return `412 precondition_failed` with an upgrade pointer. See [Plans & entitlements](/platform/billing/plans-and-entitlements).

## Connect a GitHub account

A **connection** binds one GitHub App installation to a workspace (or to a parent account, shared across its workspaces):

1. `POST /v1/organizations/{orgId}/integrations/github/connect` (permission `organization.integration.connect`) creates a `pending` connection and returns an `installUrl` carrying a signed, single-use state token. The console opens this in a popup.
2. The user installs the App on their GitHub organization and picks repositories (`all` or `selected`).
3. GitHub redirects back to the platform's setup ingress (`/ingress/github/setup`). The workspace binding comes **only** from the signed state — the platform verifies the state, verifies the installation as the App, then binds and activates the connection and emits `integration.connected`. An installation arriving without valid state is recorded as *orphaned* and never auto-bound: the flow fails closed.

List and manage connections with `GET /v1/organizations/{orgId}/integrations` and `GET|PATCH|DELETE …/integrations/{connectionId}` (ids are `int_…`). A connection tracks provider-side lifecycle too: suspending or uninstalling the App on GitHub moves it to `suspended` / `revoked`. Connections owned by a parent account can be shared with child workspaces either automatically (`shareMode: "auto"`) or per-workspace via admission grants (`…/integrations/{connectionId}/grants`).

## The inbound webhook inbox

GitHub delivers webhooks to `/ingress/github/webhook`. This ingress is deliberately minimal — **verify, insert, ack**:

- The `x-hub-signature-256` HMAC is verified over the **raw request bytes**, with a constant-time compare, before any parsing. A bad signature is an immediate `401` with no detail.
- The verified payload is inserted into a durable **inbox**, keyed by GitHub's delivery id — redeliveries are acknowledged as no-op duplicates.
- Everything else happens asynchronously: a **drain** attributes each delivery to a connection, normalizes it, and emits the resulting event in the same transaction that marks the row `emitted` — exactly-once by construction, with bounded retries for transient failures.

Inspect the inbox per connection with `GET …/integrations/{connectionId}/deliveries` (status `received` → `attributed` → `emitted` | `skipped` | `failed`), and re-run normalization from the persisted payload with `POST …/deliveries/{deliveryId}/replay` — replay never re-trusts the wire.

## Normalized `scm.*` events

Supported GitHub events are projected into compact, versioned, provider-neutral events on the event log — consumable through [outbound webhooks](/platform/webhooks/overview) and visible in the [audit trail](/platform/audit/audit-log):

| GitHub event | Normalized event type |
| --- | --- |
| `push` | `scm.push` |
| `pull_request` (opened) | `scm.pull_request.opened` |
| `pull_request` (synchronize, edited, reopened, ready_for_review) | `scm.pull_request.updated` |
| `pull_request` (closed, merged) | `scm.pull_request.merged` |
| `pull_request` (closed, not merged) | `scm.pull_request.closed` |
| `check_run` (completed) | `scm.check.completed` |
| `release` (published) | `scm.release.published` |
| `create` / `delete` (branch, tag) | `scm.branch.created`, `scm.branch.deleted`, `scm.tag.created` |

Every payload carries the repository identity (`provider`, rename-stable `externalId`, `fullName`) plus workspace scope; when a repo link matches, the event is enriched with the linked `projectId` and the environment resolved from the branch → environment map. Events outside this taxonomy are marked `skipped`, never failed. Raw provider payloads stay in the inbox — they never cross the public API.

## Link repositories to projects

A **repo link** binds a project to one repository on a connection — the tenancy anchor for event enrichment and token issuance:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `…/integrations/{connectionId}/repositories` | Browse repositories the installation can see |
| `GET` / `POST` | `/v1/organizations/{orgId}/projects/{projectId}/repo-links` | List / create links (permission `project.repo_link.write`, entitlement `limit.repo_links`) |
| `PATCH` / `DELETE` | `…/projects/{projectId}/repo-links/{repoLinkId}` | Update `branchEnvMap` / `defaultBranch`, or unlink |

`branchEnvMap` maps provider branches to the project's environments (e.g. `{"main": "prod", "staging": "stage"}`) and is validated against live environments at write time.

## The installation-token broker

`POST /v1/organizations/{orgId}/integrations/github/token` exchanges your Orun Cloud credential for a **short-lived, repo-scoped GitHub installation token** (permission `organization.integration.token.issue`):

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_2f8a1c9e/integrations/github/token \
  -H "Authorization: Bearer $ORUN_CLOUD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "repositories": ["123456789"],
    "permissions": { "contents": "read", "checks": "write" }
  }'
```

```json
{
  "data": {
    "token": "ghs_…",
    "expiresAt": "2026-07-02T10:14:03Z",
    "repositories": ["123456789"],
    "permissions": { "contents": "read", "checks": "write" }
  },
  "meta": { "requestId": "req_01j9x7", "cursor": null }
}
```

```ts
const minted = await client.integrations.issueGithubToken("org_2f8a1c9e", {
  repositories: ["123456789"],
  permissions: { contents: "read", checks: "write" },
});
// minted.token is reveal-once — use it and let it expire.
```

The broker is deny-by-default at every layer:

- Every requested repository (1–20 provider ids) must match an **active repo link owned by your workspace** — a sibling workspace's repo is denied even on a shared connection — and all must resolve to one connection.
- Requested permissions (1–10 entries, `read` | `write`) must be a subset of what the App was actually granted; `write` requires a granted write.
- On `shareMode: "granted"` connections, your workspace must hold an active admission grant.
- The token is minted fresh from GitHub, scoped down by GitHub itself, and returned exactly once — never cached, never logged. **TTL is ≤ 1 hour** (GitHub's native installation-token expiry).
- Every issuance is audited as `integration.token.issued` with the actor, repositories, and permissions — never the token.

From the CLI:

```bash
orun-cloud integrations github token \
  --repos=123456789 \
  --permissions=contents:read,checks:write \
  --output=json
```

The token prints exactly once and is never stored.

:::note
Orun Cloud also uses this seam internally in the other direction: run results are written back to GitHub as check runs and commit statuses through the same scoped-token machinery, without the state plane ever seeing the App credential.
:::

## Related

- [Webhooks overview](/platform/webhooks/overview)
- [Projects & environments](/platform/projects/projects-and-environments)
- [Plans & entitlements](/platform/billing/plans-and-entitlements)
- [Integrations API reference](/api/resources/integrations)
