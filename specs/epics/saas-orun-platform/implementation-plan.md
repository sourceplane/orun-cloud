# saas-orun-platform — Implementation Plan (OP0–OP9)

Status: Draft. Milestones are PR-sized coherent units; the Orchestrator
sequences them. OP0 is dormant and safe to land any time. Stage is the
integration environment: every milestone's "done when" that involves the CLI is
verified with a real `orun` binary from the paired branch
(`orun/specs/orun-cloud/`, milestones OC0–OC6) against stage.

## OP0 — Foundation (dormant) — 🗓️ Planned

The contract-and-schema slice with zero live behavior (the IG0 pattern).

- `specs/components/18-state.md` — durable bounded-context contract for
  state-worker (intent, scope, capabilities, events, data ownership,
  extraction seam), distilled from `design.md`.
- `packages/contracts/src/state.ts` — `Run`, `RunJob`, `JobClaim`, `LogChunk`,
  `StateObjectRef`, `CatalogHead`, `WorkspaceLink`, request/response shapes
  from `state-api-contract.md`; error codes (`already_claimed`, `lease_lost`,
  `deps_not_ready`, `run_terminal`, `object_missing`,
  `contract_version_unsupported`); `actorKind: "workflow"` added to
  `tenancy.ts`. Exports wired in `package.json` + `index.ts`.
- `packages/db`: migration `190_state_foundation` — schema `state`, tables
  `runs`, `run_jobs`, `objects`, `log_chunks`, `catalog_heads`,
  `catalog_entities`, `workspace_links`; all org/project-denormalized with
  composite FKs per house rules; manifest entry + checksum;
  `src/state/{types,repository,index}.ts` repo layer (branded `Uuid`,
  `Result<T>`, org-scoped queries); fixtures in `packages/testing`.
- `apps/state-worker` skeleton: router, `/health`, env typing, id prefixes
  (`run_` display alias over ULID, `wsl_`), component.yaml, wrangler.jsonc
  (dev/stage/prod, Hyperdrive + R2 bindings, cron stub), Orun discovery wiring.
- `infra/terraform/cloudflare-r2`: the `orun-state` bucket per environment.
- Policy actions registered in policy-worker's action registry (deny-by-default
  means registering them is safe before any route exists).

**Done when:** typecheck/lint/test green across the workspace; migration
applies + rolls back on stage; `/health` responds on a deployed dormant
state-worker; R2 bucket provisioned; no public route reachable.

## OP1 — CLI session auth — 🗓️ Planned

Owner: identity-worker, api-edge auth-facade, console.

- Session kind `cli`: loopback flow (`/v1/auth/cli/start` + console approval
  page + single-use grant redeem), device flow (start/poll), rotating refresh
  (`/v1/auth/cli/token`, reuse-detection ⇒ family revoke), revoke.
- Access JWT (~15 min) with `sub/actorKind/sessionId/orgIds` claims; signing
  key as Worker secret; bearer resolution extended to accept it.
- Console: approval page ("Orun CLI on <host> wants access") and Settings →
  Sessions & devices (list + revoke CLI sessions).
- Rate limits on start/poll endpoints (existing DO limiter).

**Done when:** on stage, `orun auth login` (browser) and `orun auth login
--device` (headless) both yield a working session; `orun auth status` shows
user + orgs; refresh works past access expiry; refresh-token reuse kills the
family; console revoke locks the CLI out within one refresh; every grant and
revoke is in the audit log. (Pairs with OC1.)

## OP2 — Run coordination plane — 🗓️ Planned

Owner: state-worker, api-edge `state-facade`.

- Routes per contract §2: create (idempotent by client ULID), get, list,
  claim (atomic conditional UPDATE), heartbeat (lease extension), update
  (idempotent, sticky terminal states, `lease_lost` on lapsed lease), list
  jobs, runnable frontier, cancel.
- Lease sweep cron: re-queue lapsed claims (bounded attempts) or `timed_out`;
  derive run terminal status; emit `state.run.created|completed|failed`,
  `state.job.failed` into event_log.
- `Orun-Contract-Version` enforcement; policy checks (`state.run.read|write`)
  on every route; plan-digest existence check returns `412 object_missing`
  (clients land OP3 first in practice — the check is still correct alone).

**Done when:** on stage, a real `orun run --remote-state` executes a multi-job
DAG to completion; two concurrent runners against one run never double-claim
(verified by a contention test in `tests/`); killing a runner mid-job re-queues
the job within one sweep and a second runner finishes the run; replayed
create/update calls are no-ops; run lifecycle events appear in the org audit
log and deliver to a customer webhook. (Pairs with OC3.)

## OP3 — Object & log plane — 🗓️ Planned

Owner: state-worker.

- CAS: `objects/missing` negotiation, digest-verified PUT (idempotent),
  GET, index list; R2 layout per design §4.1; chunked-upload sub-protocol for
  blobs over the single-request budget.
- Logs: chunk append keyed by (run, job, seq) with lease check, R2 storage,
  assembled read with `fromSeq` cursor for live tail.
- Catalog heads: PUT/GET/history per contract §3.1 (entity read-model
  projection deferred to OP7); `catalog.head.advanced` event.

**Done when:** on stage, the CLI pushes a plan blob once and a re-push is a
verified no-op; a 100 MiB synthetic object round-trips via multipart; `orun
logs --follow` tails a live job; log bytes and object bytes show up as usage
records (metering wiring may stub until OP9 but the records flow).
(Pairs with OC3/OC4.)

## OP4 — Tenancy resolution & workspace links — 🗓️ Planned

Owner: state-worker, membership/projects workers, console.

- `POST /v1/organizations/{orgId}/cli/links` (normalize remote URL, create
  project on demand under `org.cli.link` policy) and
  `GET /v1/cli/links/resolve` (actor's candidate orgs/projects for a remote).
- Environment auto-registration on first run/plan referencing it.
- Console: project Settings → CLI page (linked remotes, connect snippet,
  unlink); cross-link to an IG connection when one covers the same repo.
- `org.cli.linked` event; link/unlink audited.

**Done when:** on stage, `orun cloud link` in a fresh clone lists the user's
orgs, creates/selects a project, and subsequent `orun run --remote-state` needs
no flags; a member without `org.cli.link` gets a safe 403; unlink from console
breaks the next CLI call with an actionable error. (Pairs with OC2.)

## OP5 — OIDC federation for CI — 🗓️ Planned

Owner: identity-worker, console.

- `POST /v1/auth/oidc/exchange`: GitHub JWKS verification (KV-cached), claim
  matching against `identity.oidc_trust_bindings` (org, project?, issuer,
  repository, ref pattern?, environment?), short-lived `workflow` token mint.
- Migration for `oidc_trust_bindings`; CRUD under
  `/v1/organizations/{orgId}/ci/trust-bindings` (policy `org.ci.trust.write`).
- Console: project Settings → CI access — binding editor, copyable GHA snippet
  (`permissions: id-token: write` + exchange step), suggested binding when the
  workspace link is a github.com remote.

**Done when:** on stage, a GitHub Actions workflow with no stored secret runs
`orun run --remote-state` via OIDC exchange; a workflow from an unbound repo or
non-matching ref is denied with a safe error; every exchange is audited with
issuer/repo/ref claims; binding mutations are admin-only. (Pairs with OC6.)

## OP6 — Console: Runs & Stacks — 🗓️ Planned

Owner: web-console-next, packages/sdk.

- SDK methods for runs/jobs/logs/stacks reads (contract-driven, like every
  other context).
- Runs list (status/env/actor/duration, filters, cursor pagination), run
  detail: DAG visualization from job deps, job table with attempts/leases,
  live log tail (fromSeq polling), plan provenance (digest, commit, dirty).
- Stacks grid (per-environment cards: status, last run, drift badge once OP7
  lands — placeholder until then) and stack detail (run timeline, deployed
  component table from job results).
- Cmd-K: "Go to run…", "Open stack…"; designed empty states that teach
  `orun auth login` / `orun cloud link` / `orun run --remote-state`.

**Done when:** the surface passes the PX buyer-credibility bar (no stubs,
designed empty/loading/error, requestId disclosure, mobile-credible); a live
run started from a laptop is watchable end-to-end in the console with < 5 s
log lag; a verified-live walkthrough is recorded in `IMPLEMENTATION-STATUS.md`.

## OP7 — Console: Catalog — 🗓️ Planned

Owner: state-worker (read-model), web-console-next.

- Read-model projection at head-advance: `state.catalog_entities` rows from
  the snapshot envelope (`orun-service-catalog` schema); list/search/filter API
  (contract §3.1 `catalog/entities`).
- Console: entity browser (kind/owner/lifecycle facets, search), entity detail
  (spec, relations, provenance commit, environments running it), head history
  with entity-level diff between two heads.
- Drift badge wiring into OP6's stack cards (deployed digest vs head).

**Done when:** on stage, `orun catalog push` (OC4) makes the org's components
browsable in the console within seconds; search and facets work against a
500-entity synthetic catalog without pagination jank; a head advance shows a
correct entity diff; the platform demonstrably never mutates catalog content
(read-model rebuild from blobs is idempotent and tested). (Pairs with OC4.)

## OP8 — Secret manager — 🗓️ Planned

Owner: config-worker, api-edge, console.

- Migration `200_config_secrets`: versioned `config.secrets` with envelope
  encryption (per-secret DEK, per-org KEK wrap, master key as Worker secret);
  scope columns (org/project?/environment?).
- Write-only management API (PUT/list-metadata/DELETE per contract §4);
  runtime `secrets/resolve` gated on live job lease + `secret.value.use`;
  `secret.created|rotated|accessed` events; rotation grace (previous version
  resolvable until outstanding leases expire).
- Console: Secrets manager at org and project/environment scope — entry-only
  values, version/rotation UI, last-used, inline access audit trail.

**Done when:** on stage, a secret set in the console is injected into a step
env by a real run and appears redacted in stored logs (OC5); the management
API provably cannot read a value back; resolve without a live lease fails
closed; every access is in the audit log with run/job attribution; rotation
mid-run lets the in-flight run finish on the old version. (Pairs with OC5.)

## OP9 — Metering, entitlements, retention, hardening — 🗓️ Planned

Owner: state-worker, metering-worker, billing-worker, console.

- Usage records flowing: run count, job minutes, log bytes, object bytes,
  secret count; rollups + quota definitions.
- Entitlements: `feature.remote_state`, `feature.secret_manager`,
  `limit.state.runs_per_month`, `limit.state.retention_days`,
  `limit.secrets.count`, `limit.state.storage_gb`; 412 + upgrade UX at the
  facade; free-tier defaults per design §7.
- Retention/GC cron: expire log chunks and unreferenced objects past plan
  retention (heads and their snapshots pinned); deletion is metered and
  audited.
- Hardening: per-route rate limits tuned for heartbeat/log write rates;
  contract freeze recorded; load test (50 concurrent runners, 1k-job run)
  with results in `IMPLEMENTATION-STATUS.md`.

**Done when:** an over-quota org gets 412 with upgrade UX on run create while
reads keep working; usage shows on the existing billing/usage console surface;
GC provably never collects an object referenced by a head or a retained run;
the load test meets p95 < 300 ms on claim/heartbeat at stage.

## Sequencing

```
OP0 ─→ OP1 ─→ OP2 ─→ OP3 ─→ OP6 ─→ OP7
         └──→ OP4 (after OP1; before OP2 ships to users)
                OP5 (after OP4)
                OP8 (after OP2; console part after OP6 shell)
                OP9 (last; metering records wired from OP3 onward)
```
