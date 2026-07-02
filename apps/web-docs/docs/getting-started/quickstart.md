---
title: Quickstart
description: From zero to your first authenticated Orun Cloud API call — sign in, create an API key, and create a project with curl, the SDK, and the CLI.
---

This guide takes you from nothing to a working project in your workspace: sign in to the console, mint an API key, make your first authenticated call against `https://api.orun.dev`, then do the same with the SDK and the CLI.

## 1. Sign in

Open [`https://app.orun.dev`](https://app.orun.dev) and sign in with your email — Orun Cloud is passwordless, so you complete sign-in with the code emailed to you instead of a password.

On first login a **workspace** is auto-created for you, and the console lands you directly in it — no chooser screen. You can create additional workspaces later from the console.

:::note
OAuth sign-in providers are credential-blocked in this deployment and rolling out; email sign-in is the supported path today (see `specs/epics/saas-baseline` in the repo).
:::

## 2. Find your workspace ID

Everything in Orun Cloud lives under a workspace. In the console, open **Settings** for your workspace — the settings hub shows three identifiers:

- **Workspace ID** (`ws_…`) — the durable, immutable public handle. Safe to commit to `intent.yaml`, quote to support, and use in API requests.
- **Workspace slug** — the friendly URL namespace (`app.orun.dev/orgs/{slug}/…`). Mutable, so don't store it as a reference.
- **Legacy workspace ID** (`org_…`) — the internal identifier, still accepted everywhere.

The API's canonical resource name for a workspace is **organization** — paths read `/v1/organizations/{orgId}`, and `/v1/workspaces/*` is an accepted alias for the same routes. See [Vocabulary](/getting-started/vocabulary).

## 3. Create an API key

In the console, go to your workspace's **Settings → API keys** and click **Create**. An API key is a long-lived credential for a **service principal** — a machine identity with its own role in the workspace.

:::warning
The secret is shown **once**, at creation. Copy it immediately and store it securely — you cannot retrieve it again, only revoke the key and create a new one.
:::

Export it for the rest of this guide:

```bash
export ORUN_CLOUD_TOKEN="<paste the secret>"
export ORG_ID="org_…"   # or your ws_… workspace ID
```

## 4. Make your first API call

List the projects in your workspace. All requests authenticate with `Authorization: Bearer`:

```bash
curl -s "https://api.orun.dev/v1/organizations/$ORG_ID/projects" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

Every success response uses the same envelope — your payload under `data`, request metadata under `meta`:

```json
{
  "data": { "projects": [] },
  "meta": { "requestId": "req_a1b2c3d4e5f6", "cursor": null }
}
```

An empty `projects` array is correct — you haven't created one yet. Errors come back as `{ "error": { "code", "message", "details", "requestId" } }`; see [Errors](/api/errors).

## 5. Create a project

A **project** maps one-to-one to a repo. Create one with `POST` — and send an `Idempotency-Key` so a retried request can never double-create:

```bash
curl -s -X POST "https://api.orun.dev/v1/organizations/$ORG_ID/projects" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "name": "Web app" }'
```

```json
{
  "data": {
    "project": {
      "id": "prj_…",
      "orgId": "org_…",
      "name": "Web app",
      "slug": "web-app",
      "status": "active",
      "createdAt": "2026-07-02T12:00:00.000Z",
      "updatedAt": "2026-07-02T12:00:00.000Z",
      "archivedAt": null
    }
  },
  "meta": { "requestId": "req_…", "cursor": null }
}
```

:::tip
Retrying a write with the same `Idempotency-Key` within 24 hours replays the stored response instead of re-executing — replays carry `x-saas-replay-source: edge-idempotency`. See [Idempotency](/api/idempotency).
:::

Re-run the list call from step 4 and your project is there.

## 6. Same calls with the SDK

The TypeScript SDK (`@saas/sdk`) is a typed, zero-dependency client that runs in Node ≥ 20, browsers, Cloudflare Workers, and Bun:

```ts
import { randomUUID } from "node:crypto";
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env["ORUN_CLOUD_TOKEN"]! },
});

const orgId = process.env["ORG_ID"]!;

const { projects } = await client.projects.list(orgId);

const { project } = await client.projects.create(
  orgId,
  { name: "Web app" },
  { idempotencyKey: randomUUID() },
);
```

Non-2xx responses throw typed subclasses of `OrunCloudError` (`ValidationError`, `RateLimitError`, …) so you can branch on the class. See [SDK](/developers/sdk).

## 7. Same calls with the CLI

The `orun-cloud` CLI wraps the SDK. `login` prompts you to paste a Bearer token — use the API key from step 3 — validates it against the API, and stores it in your OS keychain (falling back to `~/.config/orun-cloud/credentials.json`, mode `0600`):

```bash
orun-cloud login
orun-cloud whoami
orun-cloud workspace list
orun-cloud workspace use <workspace>
orun-cloud project list
orun-cloud project create "Web app" --idempotency-key=$(uuidgen)
```

Every command supports `--output=human|json`. See [CLI](/developers/cli).

## 8. Where to go next

- **Connect orun remote state.** Point your `intent.yaml` at Orun Cloud so plans, runs, and the catalog are shared across machines and CI — see the [state plane overview](/platform/state-plane/overview) and the [`orun cloud` commands](https://orun.sourceplane.ai/cli/orun-cloud) in the orun docs.
- **Invite your team** and assign roles — [Members and invitations](/platform/workspaces/members-and-invitations), [RBAC](/platform/access-control/rbac).
- **Automate from CI** with GitHub Actions OIDC instead of long-lived keys — [CLI and CI auth](/platform/identity/cli-and-ci-auth).

## Related

- [The console](/getting-started/console)
- [API overview](/api/overview)
- [Authentication](/api/authentication)
- [Projects and environments](/platform/projects/projects-and-environments)
