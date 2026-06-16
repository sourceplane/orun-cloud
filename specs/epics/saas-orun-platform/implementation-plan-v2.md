# Orun Cloud v2 — implementation plan

> Status: Proposed. Supersedes the OP5+ milestones of `implementation-plan.md`.
> OP0–OP4 stay shipped; v2 milestones are numbered **OV1–OV9** to avoid
> collision. Each is a PR-sized coherent unit; the Orchestrator sequences them.
> Stage is the integration environment; CLI-side gates verify against a real
> `orun` binary from `orun/specs/orun-cloud/` (milestones OCv2).

## Substrate (unchanged, shipped)

OP0 foundation · OP1 CLI session auth · OP2 run coordination · OP3 object & log
plane · OP4 tenancy & workspace links. v2 builds strictly on top; it does not
reopen these.

## Milestones

### OV1 — ModelReader read seam — re-anchor (DV1/DV2)

- Expose the hosted object model as the primary read API: `ObjectStore`
  (Has/Put/Get over R2, same digests) + `RefStore` (CAS KV:
  `refs/sources|catalogs|revisions|executions`, per project) + the `ModelReader`
  surface (`ResolveRef/Catalog/Revision/Execution/ComponentHistory/ListExecutions`).
- Build the L3 index (by-time, by-status, component → revisions → executions),
  derived and rebuildable from objects + refs.
- CLI/contract: widen `bridge.Source` to the full `ModelReader` (paired OCv2-1).
- **Done when:** on stage, `orun tui --remote` and the console render source →
  catalog → execution history off the *same* `ModelReader`, with source/head
  selection by ref; remote `ListExecutions`/`Catalog` no longer stubbed.

### OV2 — Materialized tenancy (DV3/DV4)

- Tighten `state.workspace_links` to a project == repo bijection: add
  `UNIQUE (org_id, project_id) WHERE active`; add `provider`,
  `provider_repo_id`, `provider_owner_id`, `provider_owner_login`. Additive
  migration first; backfill provider IDs and lone links; flip to NOT
  NULL/strict once data is clean.
- Environment upsert on ingest keyed `(project, name)`; the pre-declare path so
  settings can attach before first push.
- **Done when:** on stage, a repo resolves to exactly one project; a push
  referencing a new env materializes it; a pre-declared env accepts a secret
  before its first run; a second repo cannot claim an in-use project.

### OV3 — Credential-agnostic CI auth (DV4/DV5) — replaces old OP5

- `POST /v1/auth/oidc/exchange` (audience `orun-cloud`, JWKS-cached): resolve
  `(provider, repository_id)` → active link → `(org, project)`; gate on
  `repository_id ∈ installation` repo-selection + per-link CI settings (allowed
  ref pattern, environments); mint short-lived `actorKind: "workflow"` token.
- Per-link CI settings columns (`oidc_enabled`, `api_key_enabled`,
  `allowed_ref_pattern`, `allowed_environments`); org owner-allowlist derives
  from the installation. **Drop the planned `oidc_trust_bindings` table.**
- Extend API-key resolution to honor intent-declared `project ⊆ key scope`.
- CLI (paired OCv2-2): intent.yaml `execution.state.org`; `OIDCTokenSource`
  audience `orun`→`orun-cloud`; add the real exchange call.
- **Done when:** on stage, a GHA workflow with no stored secret runs
  `orun run --remote-state` via exchange; an unbound repo / non-matching ref /
  repo outside the installation is denied with a safe, audited error; an
  org-scoped `sk_` key routes by intent.yaml org/project within its scope.

### OV4 — GitHub App bridge: inbound ingestion (DV6)

- New state-worker consumer of `scm.push` / `scm.pull_request` from event_log:
  mint a broker `contents:read` token, read repo@sha, write Source + Catalog
  objects, move `refs/sources|catalogs/*`; record a `TriggerOccurrence`
  (actor `github`); opt-in auto-run per project.
- `scm.pull_request` computes the Merkle catalog diff (base↔head) for affected
  components.
- **Done when:** on stage, a push to an installed repo materializes its
  source + catalog in the object graph (no CLI), visible via `ModelReader`;
  redeliveries do not double-write (idempotent by commit + delivery id).

### OV5 — GitHub App bridge: outbound write-back (DV6)

- Write-back proxy in integrations-worker (owns App creds): on state-worker
  result events, post Check Run (affected components, drift, plan result, deep
  link to cockpit), commit status, Deployment status. App perms already include
  `checks/statuses/deployments:write` (IG D2).
- **Done when:** on stage, opening a PR on an installed repo produces a Check
  Run with affected components + a cockpit link; a run targeting an environment
  updates a GitHub Deployment.

### OV6 — Org-global catalog projection (DV7) — reframes old OP7

- Index merges every project's `refs/catalogs/main` into one org-wide component
  graph with provenance (project, env, commit); repo/env are filters.
- Console: org-global catalog browser (default) + repo/project list with
  per-repo settings and scoped component sublist.
- **Done when:** on stage, the console shows all org components in one graph,
  filterable by repo/env, each carrying provenance; `orun catalog push` (OCv2-3)
  appears merged within seconds.

### OV7 — Console: Runs & Stacks over ModelReader — reframes old OP6

- Runs list + detail, stacks, logs tail rendered as a `ModelReader` consumer
  (same viewmodels as the cockpit); source/head picker; per-repo settings entry.
- **Done when:** the surface passes the buyer-credibility bar over cloud data
  with no second read path.

### OV8 — Secrets (carried from OP8)

- Authored per `(project, env)`; bind to env on materialize; runtime grants +
  redaction unchanged. **Done when:** a console-set secret injects into a step
  on stage and never appears in state/objects/logs.

### OV9 — Metering, entitlements, retention, GC (carried from OP9)

- Env/project/component lifecycle (archive when no longer pushed); state
  entitlements + metering; object GC by reachability. **Done when:** an
  over-quota org gets 412 with upgrade UX; stale envs archive on schedule.

## Cross-repo dependency map (v2)

| Orun Cloud (this repo) | Orun CLI (`orun/specs/orun-cloud/`) | Seam |
|---|---|---|
| OV1 ModelReader seam | OCv2-1 bridge.Source → ModelReader | object graph ↔ `internal/cockpit/bridge` |
| OV2 materialized tenancy | OCv2-2 (link/scope) | workspace_links bijection ↔ `RepoLink` |
| OV3 credential-agnostic auth | OCv2-2 intent org + exchange | `/v1/auth/oidc/exchange` ↔ `OIDCTokenSource` |
| OV4/OV5 GitHub App bridge | OCv2-3 catalog/run push | `scm.*` ingestion + write-back ↔ object sync |
| OV6 org-global catalog | OCv2-3 catalog push | catalog heads + provenance index |

## Sequencing (recommended)

The critical path is **substrate → identity → auth → bridge → surfaces**:

1. **OV1** (ModelReader seam) — unblocks every read surface; do first.
2. **OV2** (materialized tenancy) — the project==repo identity everything keys on.
3. **OV3** (credential-agnostic auth) — pairs with OCv2-2; the CI golden path.
4. **OV4 → OV5** (GitHub App bridge, in → out) — needs OV1–OV3 + IG D1 (App
   registration; stage provisioned, prod pending).
5. **OV6, OV7** (catalog + Runs/Stacks console) — can parallelize once OV1
   lands; OV6 needs OV4 for auto-populated data.
6. **OV8, OV9** (secrets, metering/retention) — independent tails; schedule by
   demand.

Human gates carried from the integrations epic: **IG D1** (per-environment
GitHub App registration) blocks OV4/OV5 live paths (stage ready, prod unset);
worker-side fixtures are human-independent and can land ahead of the gate.
