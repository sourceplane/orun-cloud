# State

Status: In progress — OP0 foundation landed dormant (schema, contracts, repo layer, worker skeleton, R2 bucket; no live behavior). Owning work epic: specs/epics/saas-orun-platform/ + specs/roadmap.md.

Primary monorepo targets:
- `apps/state-worker`
- `infra/terraform/cloudflare-r2`

Primary dependencies:
- `specs/core/domain-model.md`
- `specs/core/contracts/event-envelope.schema.yaml`
- `specs/epics/saas-orun-platform/state-api-contract.md` (the normative wire contract, shared with the Orun CLI repo)
- `specs/components/01-edge-api.md` (the `state-facade` + service binding land here at OP2)
- `specs/components/04-organizations-membership.md`
- `specs/components/05-projects-environments.md`
- `specs/components/09-events-audit-observability.md`
- `specs/components/11-billing.md` (entitlement gating)
- `specs/components/17-integrations.md` (cross-link: an IG connection may cover the same repo as a workspace link)

## Intent

Own Orun Cloud's state bounded context: the shared, durable run-coordination
plane, the content-addressed object/log store, and the catalog of record. This
is the server side of Orun's `statebackend.Backend` interface — what lets a
team's runs survive laptops, lets concurrent runners (CI + humans) coordinate
without races, and renders one catalog and one set of stacks in the console.
The CLI stays offline-first; connecting to Orun Cloud is additive. We win on
the surfaces, not on lock-in: the OSS self-host backend implements the same
contract, so adopting or leaving the SaaS is a URL change.

## Scope

- run coordination (contract §2): idempotent create by client ULID, get/list,
  atomic conditional-UPDATE claim, lease heartbeat, idempotent sticky-terminal
  update, runnable frontier, cancel; the lease-sweep cron that re-queues lapsed
  claims (bounded attempts) or times them out and derives run terminal status
- the immutable object plane / CAS (contract §3, design §4.1): digest
  negotiation (`objects/missing`), digest-verified idempotent PUT, GET, index
  list, chunked upload over R2 multipart for blobs past the single-request
  budget
- append-only chunked logs (design §4.3): chunk append keyed by (run, job, seq)
  under a job lease, assembled read with a `fromSeq` cursor for live tail
- catalog heads (contract §3.1, design §4.1): advance/get/history — the only
  mutable pointers in the object plane — and the read-model projection
  (`catalog_entities`) rebuilt from the snapshot at head-advance time
- Orun workspace links (contract §5, design §2): (org, project) ↔ normalized
  git remote URL, created on first `orun cloud link`, with the resolve picker
- emission of `state.*` / `catalog.head.advanced` / `org.cli.linked` events

## Out Of Scope

- CLI session auth and OIDC federation (identity-worker owns `/v1/auth/cli/*`
  and `/v1/auth/oidc/exchange`; this component only consumes the resolved
  ActorContext) — OP1 / OP5
- the secret manager values + crypto (config-worker owns `config.secrets` and
  envelope encryption; this component declares the policy actions and consumes
  `secrets/resolve` semantics, but does not store secret values) — OP8
- platform-hosted runners — execution stays on customer compute (laptop, CI)
- catalog authoring — the console never writes catalog content; the platform
  renders what git produced (provenance is verifiably drift-free)
- a second state model — the OSS backend and Orun Cloud implement one contract;
  semantics are never forked for SaaS convenience

## Hard Contracts To Honor

- `specs/epics/saas-orun-platform/state-api-contract.md` is normative and the
  seam between the two repos. It freezes at OP2; changes after freeze are
  additive or versioned, never silently breaking. `Orun-Contract-Version` is
  enforced per request (unknown majors ⇒ `409 contract_version_unsupported`).
- `specs/core/contracts/event-envelope.schema.yaml` — every emitted event uses
  the standard envelope; `state.*` payload projections are versioned and
  additive-only.
- Tenancy + RBAC: every route is path-scoped
  (`/v1/organizations/{orgId}/projects/{projectId}/state/...`) and org-scoped at
  the data layer; policy actions are deny-by-default (`state.run.read|write`,
  `state.object.read|write`, `catalog.read|publish`,
  `secret.read|write|value.use`, `org.cli.link`, `org.ci.trust.write`).
- Entitlement gating: `feature.remote_state`, `feature.secret_manager`,
  `limit.state.runs_per_month`, `limit.state.retention_days`,
  `limit.secrets.count`, `limit.state.storage_gb` via the billing entitlement
  seam; 412 + upgrade UX on deny.
- Idempotency: run create is keyed by client ULID; job transitions by
  (runId, jobId, runnerId, status); object PUTs by digest. Terminal run/job
  states are sticky.
- Audit coverage: run create, cancel, head advance, link/unlink, and (at OP8)
  secret access all emit through event_log.

## Required Capabilities

### Public/Internal Methods

- `createRun` (idempotent by client ULID) / `getRun` / `listRuns`
- `claimJob` (atomic conditional UPDATE) / `heartbeatJob` / `updateJob`
- `listJobs` / `runnableJobs` / `cancelRun`
- `appendLog` / `readLog` (assembled, `fromSeq` cursor)
- `objectsMissing` / `putObject` (digest-verified, idempotent) / `getObject` /
  `listObjects`; chunked upload (`uploads` / parts / complete → R2 multipart)
- `putCatalogHead` / `getCatalogHead` / `listCatalogHeadHistory` /
  `listCatalogEntities`
- `createWorkspaceLink` (creates project on demand under `org.cli.link`) /
  `resolveWorkspaceLinks`

### Events

- `state.run.created`
- `state.run.completed`
- `state.run.failed`
- `state.job.failed`
- `catalog.head.advanced`
- `org.cli.linked`

### Integration Rules

- **Claim is one conditional UPDATE** (`status='queued' AND deps all
  terminal-success`) returning the claimed row — Postgres via Hyperdrive gives
  atomicity, so two racing runners get exactly one winner and the loser gets
  the contract's `already_claimed` outcome.
- **Heartbeat extends the lease**; a state-worker cron sweep re-queues
  (attempt+1, up to plan policy) or times out jobs whose lease lapsed — this is
  what makes runs survive killed laptops. Run-level status is derived (all
  terminal → run terminal) by the same sweep.
- **Transitions are idempotent**: `update` with the same (run, job, runner,
  status) replays safely; terminal states are sticky; an `update` from a runner
  that lost its lease is rejected with `lease_lost`.
- **CAS is content-addressed and digest-verified**: PUT verifies the digest
  (mismatch ⇒ 400); a same-digest re-upload is a no-op. Blob bytes live in R2
  (`state/{orgId}/{projectId}/objects/{digest}`); Postgres holds only the index
  row. A run's `planDigest` must exist before create (else `412 object_missing`).
- **Catalog heads are the only mutable pointers** in the object plane; history
  is retained. Advancing a head is an audited mutation; the read-model
  (`catalog_entities`) is derived, never authored, and idempotently rebuildable
  from the snapshot blob — the platform never edits catalog content.
- **Workspace links are not repo links**: Orun linking must work for any git
  remote with no GitHub App installed, so this component owns
  `state.workspace_links` distinct from `integrations.repo_links`. When an IG
  connection covers the same repo, the console cross-links them; neither
  depends on the other.

## Data Ownership

This component owns (schema `state`): runs and run jobs (the mutable
coordination plane with leases), the content-addressed object index, the
append-only log-chunk index, catalog heads and the projected
`catalog_entities` read-model, and Orun workspace links. Object and log bytes
live in the `orun-state` R2 bucket; Postgres holds only the index and
coordination rows. Every table carries `org_id + project_id` and is queried
org-scoped; composite FKs are used within the schema (run_jobs/log_chunks →
runs, catalog_heads → objects). Secret values are owned by config-worker, not
here.

## Agent Freedom

- Claim/heartbeat contention is handled in Postgres at launch volumes; a
  per-run Durable Object can serialize claims behind the same contract if a hot
  run ever needs it — a documented seam, not built at v1.
- The lease sweep may use fixed batch sizes and a fixed lease default (60s) /
  heartbeat hint (20s) before adaptive tuning exists; the server returns both
  so the client never hardcodes them.
- SSE for live log tail is a documented seam; `fromSeq` polling is the v1
  mechanism for the console and `orun logs --follow`.
- Catalog read-model columns may start minimal as long as they are reserved
  for the live-plane (scorecards/health) join that lands later from run events.

## Acceptance Criteria

- A real `orun run --remote-state` executes a multi-job DAG to completion;
  two concurrent runners against one run never double-claim; killing a runner
  mid-job re-queues the job within one sweep and a second runner finishes it.
- Replayed create/update calls are no-ops; a re-pushed object blob is a
  digest-verified no-op; a 100 MiB object round-trips via multipart.
- `orun logs --follow` tails a live job; run lifecycle events appear in the org
  audit log and deliver to a customer webhook.
- `orun cloud link` in a fresh clone lists the user's orgs, creates/selects a
  project, and subsequent runs need no flags; a member without `org.cli.link`
  gets a safe 403; unlink from the console breaks the next CLI call actionably.
- The catalog read-model rebuild from blobs is idempotent; the platform
  demonstrably never mutates catalog content. All gates fail closed.

## Extraction Seam

The state surface is reached only via the api-edge `state-facade` + a service
binding, and emits domain events like every other context. The OSS self-host
backend implements the same wire contract with a fixed `_local/_local` scope,
so a single Orun client codepath serves both SaaS and self-host. The per-run
Durable Object is the documented seam for serializing hot-run claims; the
secret manager is the documented seam for promoting `config.secrets` to a
dedicated worker. Products consume run/catalog state through the SDK and
console (contract-driven reads) and `state.*` events through the existing
outbound-webhook surface — no component bypasses the contract.
