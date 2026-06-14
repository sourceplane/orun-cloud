# state-worker

Orun Cloud's state bounded context: the shared, durable run-coordination plane
plus the content-addressed object/log store and the catalog of record. This is
the server side of Orun's `statebackend.Backend` interface — the seam that lets
a team's runs survive laptops, coordinate concurrent runners without races, and
render one catalog and one set of stacks in the console.

Contract: `specs/components/18-state.md`. Wire contract (normative, shared with
the Orun CLI repo): `specs/epics/saas-orun-platform/state-api-contract.md`.

## Status — OP0 (dormant)

This is the IG0-style foundation: schema, contracts, repo layer, and worker
skeleton land **dormant**. The only reachable route is `/health`; everything
else is a clean 404. No run coordination, no object/log I/O, no catalog
projection, no workspace-link resolution runs yet.

What is in place:

- **Schema** (`packages/db` migration `220_state_foundation`, schema `state`):
  `runs`, `run_jobs`, `objects`, `log_chunks`, `catalog_heads`,
  `catalog_entities`, `workspace_links` — all org/project-denormalized with
  tenant-safe composite FKs.
- **Contracts** (`packages/contracts/src/state.ts`): `Run`, `RunJob`,
  `JobClaim`, `LogChunk`, `StateObjectRef`, `CatalogHead`, `CatalogEntity`,
  `WorkspaceLink`, the request/response shapes, the new error codes, and the
  `state.*` / `catalog.*` event + policy + entitlement constants.
- **Repo layer** (`packages/db/src/state`): branded-`Uuid`, `Result<T>`,
  org-scoped queries mirroring `packages/db/src/integrations`.
- **Policy actions** (`packages/policy-engine`): `state.run.*`,
  `state.object.*`, `catalog.read|publish`, `secret.read|write|value.use`,
  `org.cli.link`, `org.ci.trust.write` — deny-by-default, granted by role.
- **Bindings** (`wrangler.template.jsonc`): Hyperdrive `PLATFORM_DB` and the
  R2 bucket `ORUN_STATE` (`orun-state`, provisioned by
  `infra/terraform/cloudflare-r2`).

## What lands next (OP2+)

- **OP2 — run coordination**: routes per contract §2 (create/get/list, atomic
  claim, heartbeat lease extension, idempotent update, runnable frontier,
  cancel) + the lease-sweep cron (re-queue lapsed claims / time out, derive run
  terminal status, emit `state.run.*`). The `scheduled` handler and its cron
  trigger are reinstated here.
- **OP3 — object & log plane**: CAS `objects/missing` negotiation, digest-
  verified PUT/GET, chunked upload (R2 multipart), log chunk append/read with
  `fromSeq` live tail.
- **OP4 — workspace links**: `POST /v1/organizations/{orgId}/cli/links` and
  `GET /v1/cli/links/resolve` (the `orun cloud link` picker).
- **OP7 — catalog read-model**: project `catalog_entities` from the snapshot
  envelope at head-advance and serve list/search/filter.

## Design notes

- **Two planes** (design §4): an immutable content-addressed object plane
  (objects + the only mutable pointers, catalog heads) and a mutable run-
  coordination plane (runs + run_jobs + log chunks). Blob bytes live in R2;
  Postgres holds only the index/coordination rows.
- **One contract, two backends**: the OSS self-host backend serves the same
  paths with a fixed `_local/_local` scope, so one Orun client codepath serves
  both. Adopting or leaving the SaaS is a URL change.
- **DO seam**: claim/heartbeat contention is fine in Postgres at launch
  volumes; a per-run Durable Object can serialize claims behind the same
  contract if a hot run ever needs it — documented as a seam, not built now.
