---
title: State plane (orun remote state)
description: The server side of orun's remote state — run coordination, a content-addressed object and log store, the catalog of record, and workspace links.
---

The **state plane** is the server side of [orun](https://orun-docs.pages.dev)'s remote state. When a repo points its `execution.state` at Orun Cloud, the plans, runs, logs, and catalog snapshots that orun produces stop living on one laptop and become durable, workspace-scoped state — shared across machines, CI, and the console.

It is four things behind one versioned wire contract:

- **Run coordination** — runs and their job DAGs, with atomic job claims, heartbeat leases, and idempotent status transitions, so concurrent runners never race. Lapsed leases are re-queued or timed out server-side, and `state.run.*` events land on the event log.
- **A content-addressed object and log store** — plans, catalog snapshots, composition locks, and artifact manifests stored by `sha256:` digest (upload negotiation asks only for missing digests; PUTs are verified and idempotent), plus append-only job logs with sequence-based live tail.
- **The catalog of record** — the entity inventory your platform intent declares, projected from the latest published snapshot per workspace and browsable in the console.
- **Workspace links** — the mapping from a git remote to a `(workspace, project)` pair, which is also the allow-list that gates CI access.

Everything is path-scoped: state routes live under `/v1/organizations/{orgId}/projects/{projectId}/state/…`, so tenancy is in the URL like every other Orun Cloud surface. A project *is* a repo.

:::note Rolling out
The state plane is actively rolling out. Run coordination, the object/log plane, workspace links, CI auth, the GitHub write-back bridge, and the catalog and Runs console surfaces are live; the managed secrets surface is still in development, and object garbage-collection reclamation ships in report-only mode by default. Expect this area to grow; the wire contract itself is frozen and versioned (see below).
:::

## Connect a repo

Configuration lives in your repo's `intent.yaml`, and the workflow lives in the `orun` CLI — both are documented in the [orun docs](https://orun-docs.pages.dev/cli/orun-cloud); the short version:

```yaml
# intent.yaml
execution:
  state:
    backendUrl: https://api.orun.dev
    org: acme            # your workspace slug or ws_… ref — declared, enforced tenancy
```

Then, on a dev machine:

1. `orun auth login` — authenticate the CLI against Orun Cloud (browser or device flow).
2. `orun cloud link` — pick the workspace and project for this repo's git remote. This creates the **workspace link** server-side (creating the project on demand) and is the explicit step that allow-lists the repo.

From that point `orun plan` and `orun run` read and write remote state transparently. See the [orun remote state concepts](https://orun-docs.pages.dev) for how the CLI resolves scope and caches links — this page documents the Orun Cloud side only.

## CI without credentials

GitHub Actions jobs don't need a stored secret. The workflow's native OIDC token is exchanged at `POST /v1/auth/oidc/exchange` for a short-lived workflow actor token bound to exactly one `(workspace, project)` — determined by the repo's workspace link. No link, no token: a repo that was never linked is denied by design (as a resource-hiding `404`), and CI cannot allow-list itself from inside the gated workflow.

- Allow-list a repo once, deliberately — `orun cloud link` from a dev machine, or add it from the console.
- Diagnose before CI runs with `orun cloud check`, which answers "is this repo allow-listed for the resolved workspace?" locally.

Details of the exchange and trust configuration are on [CLI & CI authentication](/platform/identity/cli-and-ci-auth).

## What the console shows

The console renders the state plane per workspace:

- **Runs** — plan/run history per project with job status and live log tail.
- **Catalog** — the entity inventory from the latest published snapshot, searchable and filterable across the workspace.
- **Workspace overview** — linked repos, recent activity, and state storage usage.

The same data is available from the API and SDK — e.g. listing a project's runs:

```bash
curl "https://api.orun.dev/v1/organizations/org_2f8a1c9e/projects/prj_4b3a2c1d/state/runs?limit=20" \
  -H "Authorization: Bearer $ORUN_CLOUD_API_KEY"
```

```ts
const { runs } = await client.state.listRuns("org_2f8a1c9e", "prj_4b3a2c1d");
```

Responses use the standard envelope (`{ "data": …, "meta": { "requestId", "cursor" } }`) and cursor pagination. State access is governed by the deny-by-default policy actions `state.run.read|write`, `state.object.read|write`, and `catalog.read|publish`.

## Contract versioning

The state API is a frozen, versioned contract shared with the orun CLI — neither side may break it unilaterally. Clients advertise their contract major on every request:

```
Orun-Contract-Version: 1
```

A server that does not understand the requested major rejects it with `409 contract_version_unsupported`, and the error `details` carry the supported range (`{ "requested": …, "supported": { "min": 1, "max": 2 } }`) — so version skew fails loud and actionable at the CLI instead of silently mis-parsing. A missing header is tolerated and treated as current.

The same contract is implemented by the OSS single-tenant backend (`orun backend init`), serving identical paths with a fixed local scope — adopting or leaving Orun Cloud is a `backendUrl` change, not a migration.

## Related

- [CLI & CI authentication](/platform/identity/cli-and-ci-auth)
- [Projects & environments](/platform/projects/projects-and-environments)
- [State API reference](/api/resources/state)
- [What is Orun Cloud?](/getting-started/what-is-orun-cloud)
