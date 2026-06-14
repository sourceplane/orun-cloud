# saas-orun-platform — Design

Status: Draft. The server-side design for Orun Cloud. The wire contract that
both repos implement is normative in [`state-api-contract.md`](./state-api-contract.md);
this doc explains the model behind it.

## 1. Product framing

**Orun compiles and executes. Orun Cloud remembers, authorizes, and renders.**

The CLI stays offline-first: every Orun feature works with no account and no
network, against the local object store. Connecting to Orun Cloud is additive —
it unlocks the things a *team* needs that a laptop cannot provide:

- **Shared, durable run state** — runs survive laptops, are visible to the
  whole org, and coordinate concurrent runners (CI + humans) without races.
- **One catalog of record** — the content-addressed entity graph Orun resolves
  from git, rendered as a portal the whole company can browse.
- **A secret manager** — org/project/environment-scoped secrets injected into
  runs at execution time, never written to local state.
- **Platform stack management** — what is deployed where, by which run, and
  how it drifts from the catalog head.
- **Governance for free** — every mutation lands in the existing audit log,
  event log, webhooks, metering, and billing pipelines.

The graduation path is the moat: `orun` (local) → `orun backend deploy`
(self-host, single tenant, same contract) → Orun Cloud (multi-tenant SaaS,
same contract). Adopting or leaving the SaaS is a URL change. We win on the
surfaces, not on lock-in.

## 2. Tenancy mapping — one spine, no new nouns

Orun's client types speak of "namespaces" (`SessionResponse.allowedNamespaceIds`,
`orun cloud link` → namespace). We do **not** introduce a namespace entity.
The platform's existing spine *is* the mapping:

| Orun concept | Platform entity | Notes |
|---|---|---|
| tenant / namespace | **Organization** (`membership.organizations`) | the billing + RBAC boundary |
| linked repo / workspace | **Project** (`projects.projects`) | one git repo (one `intent.yaml` root) ↔ one project; created on first link |
| environment / stack (`environments:` in intent) | **Environment** (`projects.environments`) | `dev` / `staging` / `production` etc.; auto-registered from pushed plans |
| run / plan / job / log / catalog snapshot | **state-worker** rows + R2 objects | always carry `org_id + project_id` (+ `environment_id` where scoped) |

Per `core/domain-model.md`, every state route is path-scoped:
`/v1/organizations/{orgId}/projects/{projectId}/state/...`. The CLI resolves
`{orgId, projectId}` once at `orun cloud link` time and caches the IDs + slugs
in its local `RepoLink`. Orun's `allowedNamespaceIds` field is satisfied by
returning the user's org IDs; the CLI-side epic (OC0) renames the field at the
next client-contract rev.

**Repo links.** `saas-integrations` (IG3) defines `integrations.repo_links`
for GitHub-App-attributed events. Orun linking is a different trust object — it
must work for any git remote with no GitHub App installed — so state-worker owns
its own `state.workspace_links` (org, project, normalized git remote URL,
created_by, last_seen_at). When an IG connection exists for the same repo the
console cross-links them; neither depends on the other.

## 3. Auth — three doors, one ActorContext

All three of Orun's existing `TokenSource` implementations get a first-class
server. Everything resolves to the platform's single `ActorContext` and flows
through deny-by-default policy. No new auth model — new *doors* into the
existing one.

### 3.1 Humans: CLI sessions (browser loopback + device flow)

Owner: identity-worker. New session kind `cli` alongside console sessions.

- `POST /v1/auth/cli/start` — begins a loopback flow: returns an authorize URL
  (console page) + one-time `cli_code`; the CLI opens the browser and listens on
  `127.0.0.1:<port>`. The console page authenticates the user with the normal
  login (magic link / OAuth), shows **"Orun CLI on <host> wants access"** with
  the requesting org scope, and on approval redirects to the loopback with a
  single-use grant.
- `POST /v1/auth/cli/device/start` + `POST /v1/auth/cli/device/poll` — RFC-8628
  shaped device flow for headless boxes: short user code, console approval page,
  poll-to-token. (Orun's `DeviceLogin` currently drives GitHub's device flow;
  OC1 points it here so the platform owns the grant.)
- Token shape: **access token** (JWT, ~15 min, claims: `sub`, `actorKind`,
  `sessionId`, `orgIds`) + **rotating refresh token** (opaque, ~30 days,
  hashed in `identity.sessions`, single-use rotation with reuse detection →
  revoke family). `POST /v1/auth/cli/token` refreshes; `POST /v1/auth/cli/revoke`
  kills the session. This matches Orun's `SessionTokenSource` refresh loop.
- Console surface: **Settings → Sessions & devices** lists CLI sessions
  (host, last used, created) with revoke — reuses the session table.

### 3.2 CI: GitHub OIDC federation

Owner: identity-worker (verify + exchange) + console (trust config).

- `POST /v1/auth/oidc/exchange` — body: GitHub Actions OIDC JWT (audience
  `orun-cloud`). The worker verifies signature against GitHub's JWKS (cached in
  KV), then matches claims against the org's **trust bindings**:
  `identity.oidc_trust_bindings` (org_id, project_id?, issuer, repository,
  ref-pattern?, environment?). On match it mints a short-lived access token with
  `actorKind: "workflow"` scoped to that org/project. No stored secret in CI —
  this is the modern, credential-less path Orun's `OIDCTokenSource` already
  implements client-side.
- Trust bindings are configured in the console (project → Settings → CI access)
  and auto-suggested when a `state.workspace_links` remote is a github.com URL.
- `actorKind: "workflow"` joins `user | service_principal | system` in
  `packages/contracts/src/tenancy.ts` and the policy engine's subject model.

### 3.3 Machines: API keys (already shipped)

Existing `sk_` API keys (service principals, B-cluster) work unchanged —
`ORUN_TOKEN=sk_…` satisfies Orun's `StaticTokenSource` today. Policy decides
what the key may do; no new code beyond granting the new `state.*` actions to
key roles.

### 3.4 Policy actions

New deny-by-default actions, evaluated by policy-worker with the existing
membership facts:

```
state.run.read        state.run.write       state.object.read   state.object.write
catalog.read          catalog.publish       secret.read         secret.write
secret.value.use      org.cli.link          org.ci.trust.write
```

Default role mapping: `owner`/`admin` → all; `member` → run read/write, object
read/write, catalog read/publish, secret read (metadata), secret.value.use;
`viewer` → reads only. `secret.write` and `org.ci.trust.write` are admin-only.

## 4. The state store — two planes

The store mirrors Orun's own architecture (content-addressed object model +
mutable execution state), which is what makes sync seamless: the CLI pushes
**the same digests** it already has locally.

### 4.1 Immutable plane: CAS objects (R2 + Postgres index)

Content-addressed blobs, keyed by digest (`sha256:<hex>`), org/project-scoped:

- **Kinds:** `plan` (the checksummed plan JSON Orun already produces),
  `catalog-snapshot` (the resolved entity manifest from
  `orun-service-catalog`), `composition-lock`, `artifact-manifest` (future).
- **Storage:** blob bytes in **R2** (`state/{orgId}/{projectId}/objects/{digest}`,
  zstd as produced by the CLI); index row in Postgres `state.objects`
  (org_id, project_id, digest, kind, size_bytes, created_at, created_by).
  Same-digest re-upload is a no-op (idempotent PUT).
- **Digest negotiation:** `POST …/state/objects/missing` takes a digest list,
  returns the subset the server lacks — the CLI pushes only missing blobs,
  exactly like its local object-store sync. Uploads above the single-request
  budget use the chunked-upload sub-protocol (contract §3.3).
- **Heads (the only mutable pointers in this plane):** `state.catalog_heads`
  (org, project, environment?, digest, advanced_by, advanced_at, source commit).
  Advancing a head is a normal audited mutation; history is retained. This is
  what the console's Catalog surface renders — the platform **never edits**
  catalog content, preserving Orun's provenance property (derived from git,
  verifiably drift-free).

### 4.2 Mutable plane: run coordination

Owner: state-worker, schema `state`. Implements the server side of Orun's
`statebackend.Backend` interface verbatim (contract §2):

- `state.runs` — id (ULID, CLI-supplied for idempotent create), org_id,
  project_id, environment_id?, plan_digest → `state.objects`, status
  (`pending|running|succeeded|failed|canceled`), created_by (ActorContext),
  source (`cli|ci`), git facts (commit, ref, dirty), timestamps.
- `state.run_jobs` — run_id, job_id (from the plan DAG), component, deps[],
  status (`queued|claimed|running|succeeded|failed|timed_out|canceled`),
  runner_id, lease_expires_at, attempt, error_text, started/finished_at.
- **Claim semantics:** `claim` is a single conditional UPDATE
  (`status='queued' AND deps all terminal-success`) returning the claimed row —
  Postgres (via Hyperdrive) gives atomicity; two racing runners get exactly one
  winner, the loser gets the contract's `already_claimed` outcome. Heartbeat
  extends `lease_expires_at`; a state-worker **cron sweep** re-queues (attempt+1,
  up to plan policy) or times out jobs whose lease lapsed — this is what makes
  runs survive killed laptops.
- **Transitions are idempotent:** `update` with the same (run, job, runner,
  status) replays safely; terminal states are sticky; an `update` from a runner
  that lost its lease is rejected with `lease_lost` (the runner stops, the job
  already re-queued).
- `…/runnable` computes the frontier (queued jobs whose deps succeeded) — the
  same query the CLI uses to drive its local scheduler.
- Run-level status is derived (all terminal → run terminal) by the same sweep,
  emitting `state.run.completed|failed` events.

### 4.3 Logs

Append-only, chunked: `POST …/logs/{jobId}` appends a chunk; chunks land in R2
(`state/{org}/{project}/runs/{runId}/logs/{jobId}/{seq}`) with a Postgres index
row (seq, byte_range, created_at). Reads return assembled content with a
`nextSeq` cursor, which gives the console **live tail by polling** (SSE on
Workers is a documented seam, not a v1 requirement; the CLI already streams
incrementally). Retention is plan-entitled (§7).

### 4.4 Why a new worker (and the DO seam)

State is a real bounded context: its write rates (heartbeats, log chunks), data
shape (CAS + leases), and lifecycle (retention/GC) are unlike any existing
worker. It owns schema `state`, is reached only via api-edge facade + service
binding, and emits domain events like every other context. Claim/heartbeat
contention is fine in Postgres at launch volumes; if a hot run ever needs it,
a **per-run Durable Object** can serialize claims behind the same contract —
documented as a seam, not built now.

## 5. Catalog surface — the portal reads derived truth

`orun-service-catalog` (CLI repo) defines the entity envelope: Components,
APIs, Resources, Systems, Domains, Groups + live-plane data, resolved from git
and content-addressed. Orun Cloud's job is **distribution and rendering**, not
authorship:

- CLI pushes a `catalog-snapshot` object (the resolved manifest at a commit)
  and advances the head for (project, environment?).
- state-worker maintains a small **read-model** (`state.catalog_entities`:
  org, project, head digest, entity ref, kind, name, owner, lifecycle,
  relations jsonb) projected from the snapshot at head-advance time, so the
  console can list/search/filter without parsing blobs per request.
- Console renders: entity list with kind/owner/lifecycle facets, entity detail
  (spec, relations graph, provenance commit, which environments run it), and
  diffs between heads ("what changed in the platform between Monday and now").
- Scorecards/health (live plane) join later from run events — the read-model
  has the columns reserved.

## 6. Secret manager — write-only values, audited grants

Owner: config-worker (which already owns `config.secret_metadata` from
`070_config_settings_flags`) — promoted, not duplicated. Extraction to a
dedicated worker is a documented seam.

- **Model:** `config.secrets` — org_id, project_id?, environment_id?, key,
  version, ciphertext, dek_wrapped, created_by, rotated_at, last_used_at.
  Scope precedence at resolve time: environment > project > org.
- **Crypto:** envelope encryption — per-secret DEK (AES-256-GCM) wrapped by a
  per-org KEK derived from a platform master key held as a Worker secret
  (Terraform-provisioned). BYO-KMS is a roadmap item (risks doc D4).
- **Write-only API:** values can be created/rotated, never read back through
  the management API. Reads happen one way: a runner holding a valid job claim
  calls `POST …/runs/{runId}/secrets/resolve` with the keys the plan's steps
  declare; the worker checks `secret.value.use` policy + the claim lease,
  decrypts, returns values with a short TTL hint, and emits `secret.accessed`
  (actor, run, job, key — never the value) to the audit log. The CLI injects
  into the step env and redacts in logs (OC5).
- **Console:** Settings → Secrets per org/project/environment — create, rotate
  (versioned, old version readable by in-flight runs until lease expiry),
  scope badges, last-used, and the access audit trail inline. Values are
  entry-only fields; no reveal.

## 7. Stacks surface, events, metering, billing

**Stacks.** No new noun: a *stack* is a project environment rendered with its
live state — latest run per environment, deployed component set (from run job
results), catalog head vs deployed digest (**drift**), recent failures. Console:
org → project → Stacks grid (one card per environment: status, last run, drift
badge) → stack detail (run timeline, component table, environment secrets and
CI trust shortcuts). This is the "platform stack management" surface, and it is
pure projection over §4 — no extra write path.

**Events.** state-worker and config-worker emit through the existing pipeline:
`state.run.created|completed|failed`, `state.job.failed`,
`catalog.head.advanced`, `secret.created|rotated|accessed`, `org.cli.linked`.
Audit, customer webhooks, and notification rules apply with zero new plumbing —
"notify on production run failure" is a webhook subscription, day one.

**Metering & entitlements.** Usage records: `state.runs` (count),
`state.job_minutes`, `state.log_bytes`, `state.object_bytes`,
`secrets.count`. Entitlements: `feature.remote_state`, `feature.secret_manager`,
`limit.state.runs_per_month`, `limit.state.retention_days`,
`limit.secrets.count`, `limit.state.storage_gb`. Free tier gets a generous
solo allowance (remote state for one project, 7-day retention) because the
free CLI user is the funnel; team plans pay for seats + retention + volume.
Over-limit returns the platform's standard 412 + upgrade UX.

## 8. Console information architecture

Org-scoped, URL-driven (per `saas-console-ux`):

```
/{org}/projects/{project}/
  runs/                 # run list (status, env, actor, duration) + filters
  runs/{runId}          # DAG view, job table, live log tail, plan provenance
  stacks/               # environment cards (status, last run, drift)
  stacks/{env}          # stack detail: timeline, deployed components, drift
  catalog/              # entity browser (kind/owner/lifecycle facets)
  catalog/{entityRef}   # entity detail: spec, relations, environments, history
  settings/secrets      # secret manager (org-level twin under /{org}/settings)
  settings/ci-access    # OIDC trust bindings
  settings/cli          # workspace links + connect instructions
```

Cmd-K verbs: "Go to run…", "Open stack…", "Find component…", "Create secret",
"Connect a repo". Empty states teach the CLI commands (`orun auth login`,
`orun cloud link`, `orun run --remote-state`) — the console is also the
onboarding surface for the CLI.

## 9. What this epic deliberately does not do

- **No platform-hosted runners.** Execution stays on customer compute (laptop,
  CI). Hosted runners are a future epic with its own security model.
- **No catalog authoring.** The console never writes catalog content; it
  renders what git produced. (Annotations/ownership overrides, if ever, are a
  separate decision — risks D6.)
- **No second state model.** The OSS backend and Orun Cloud implement one
  contract; we do not fork semantics for SaaS convenience.
