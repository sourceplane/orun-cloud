---
title: State (orun remote state)
description: The orun-facing plane — CLI workspace links, run coordination, the object and catalog plane, repo facets, and state storage usage.
---

The **state API** is the plane the `orun` CLI talks to when a repository is linked to Orun Cloud: workspace **links** bind a git remote to a workspace + project, and everything under `…/state/` coordinates runs, stores content-addressed objects and logs, and advances the catalog. You normally do not call these routes directly — `orun cloud link`, `orun run`, and CI runners drive them. See [State plane overview](/platform/state-plane/overview) for the model and the [orun cloud CLI docs](https://orun-docs.pages.dev/cli/orun-cloud) for the client-side workflow.

:::note
The state plane is **rolling out**. The route groups below are live behind the API edge; surfaces still land incrementally (the project-scoped catalog entity read-model, for example, currently returns `501`).
:::

## Contract versioning

Project-scoped `…/state/…` routes enforce the wire contract's major version before any work:

| Header | Behavior |
|---|---|
| `Orun-Contract-Version: <major>` | Client's contract major. Supported majors: `1`–`2`. A missing header is tolerated (treated as current); an explicit unsupported major is rejected with `409 contract_version_unsupported` and the supported range in `error.details`. |

State-plane errors ride the standard [error envelope](/api/errors) with additional codes: `already_claimed`, `lease_lost`, `deps_not_ready`, `run_terminal`, `object_missing`, `ref_conflict`, `contract_version_unsupported`.

## Route groups

CLI links (workspace ↔ git remote binding):

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/v1/organizations/{orgId}/cli/links` | `org.cli.link` | Create a workspace link (creates the project when absent) |
| `GET` | `/v1/organizations/{orgId}/cli/links` | `org.cli.link` | List the workspace's active links (the repo allow-list) |
| `GET` | `/v1/cli/links/resolve?remoteUrl=` | — (authenticated) | Workspaces/projects the caller may link for a remote — powers `orun cloud link`'s picker |
| `GET` | `/v1/organizations/{orgId}/projects/{projectId}/cli/links` | | List a project's links (console) |
| `DELETE` | `/v1/organizations/{orgId}/projects/{projectId}/cli/links/{linkId}` | | Unlink (console) |

Run coordination and the object/catalog plane, all under `/v1/organizations/{orgId}/projects/{projectId}/state/…` (contract-version enforced):

| Group | Routes | Description |
|---|---|---|
| Runs | `POST`/`GET …/state/runs`, `GET …/runs/{runId}`, `GET …/runs/{runId}/jobs`, `GET …/runs/{runId}/runnable` | Create (idempotent by client-minted run ULID), list, and inspect runs and their job plans |
| Job coordination | `POST …/runs/{runId}/jobs/{jobId}:claim` / `:heartbeat` / `:complete`, `POST …/runs/{runId}:cancel`, `GET …/runs/{runId}/log`, `GET …/runs/{runId}/frontier` | Lease-based claim/heartbeat/complete verbs plus the run event-log and frontier reads |
| Job logs | `POST`/`GET …/runs/{runId}/logs/{jobId}` | Chunked log append and assembled read |
| Objects | `POST …/state/objects/missing`, `PUT`/`GET …/state/objects/{digest}`, `GET …/state/objects`, `POST …/objects/{digest}/uploads` (+ part `PUT`, `POST …/complete`) | Content-addressed object plane: digest negotiation, digest-verified single-shot `PUT`, and the chunked-upload sub-protocol for large blobs |
| Catalog heads | `PUT`/`GET …/state/catalog/head`, `GET …/state/catalog/heads/history` | Advance and read the published catalog head |
| Refs | `GET …/state/refs?prefix=`, `GET`/`PUT`/`DELETE …/state/refs/{name}` | Hosted RefStore — compare-and-swap ref updates (`ref_conflict` on a lost swap) |
| Triggers | `GET …/state/triggers` | Inbound `scm.*` trigger activity feed |
| GC | `GET …/state/gc/report`, `POST …/state/gc/collect` | Object reachability report and safe-by-default (dry-run) reclamation |

Workspace-scoped read models (no project segment, no contract-version gate):

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/organizations/{orgId}/catalog/entities` | Merged org-wide catalog graph (filters: `project`, `environment`, `kind`, `owner`, `q`) |
| `GET` | `/v1/organizations/{orgId}/repo-facets` | Repo self-description read model, org list |
| `GET` | `/v1/organizations/{orgId}/repo-facets/{projectId}` | One project's repo facet |
| `GET` | `/v1/organizations/{orgId}/state/usage` | Current state-plane storage footprint |
| `GET` | `/v1/organizations/{orgId}/state/runs` | Org-global run feed across all projects (the console's Activities view) |

Project-scoped state routes authorize with the `state.run.read`/`state.run.write`, `state.object.read`/`state.object.write`, and `catalog.read`/`catalog.publish` policy actions (deny-by-default; workflow actors minted via [OIDC exchange](/platform/identity/cli-and-ci-auth) are granted within their token-bound workspace + project).

## Resolve and create a link

```bash
curl "https://api.orun.dev/v1/cli/links/resolve?remoteUrl=github.com/acme/storefront" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "candidates": [
      {
        "id": "wsl_8c7d6e5f4a3b20191817161514131211",
        "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
        "orgSlug": "acme",
        "projectId": "prj_3e2d1c0b4a5968f7a6b5c4d3e2f1a0b9",
        "projectSlug": "storefront",
        "remoteUrl": "github.com/acme/storefront",
        "provider": "github",
        "providerRepoId": "456789123",
        "providerOwnerId": "9876543",
        "providerOwnerLogin": "acme",
        "ciSettings": {
          "oidcEnabled": true,
          "apiKeyEnabled": true,
          "allowedRefPattern": null,
          "allowedEnvironments": null
        },
        "createdBy": { "id": "usr_3c2b1a0f9e8d7c6b5a49382716050403", "kind": "user" },
        "createdAt": "2026-06-20T12:00:00.000Z",
        "lastSeenAt": "2026-07-02T08:00:00.000Z"
      }
    ],
    "links": [ { "…": "same contents as candidates" } ]
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a33", "cursor": null }
}
```

Creating a link (what `orun cloud link` does after the picker) takes the normalized remote and an optional `projectSlug` — the project is created on demand when absent:

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/cli/links \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "remoteUrl": "github.com/acme/storefront", "projectSlug": "storefront" }'
```

With the SDK:

```ts
const { candidates } = await client.state.resolve("github.com/acme/storefront");
```

## Read the storage footprint

`GET …/state/usage` returns the live storage stock for quota displays — distinct from metered flow metrics:

```bash
curl https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/state/usage \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "usage": {
      "objects": { "count": 1284, "bytes": 73400320 },
      "logs": { "count": 412, "bytes": 9437184 }
    }
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a34", "cursor": null }
}
```

## Related

- [State plane overview](/platform/state-plane/overview)
- [orun cloud CLI](https://orun-docs.pages.dev/cli/orun-cloud)
- [CLI and CI authentication](/platform/identity/cli-and-ci-auth)
- [Integrations](/api/resources/integrations)
