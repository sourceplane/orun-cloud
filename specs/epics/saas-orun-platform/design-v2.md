# Orun Cloud — Design v2: the control plane as a projection of pushed state

> Status: Proposed (supersedes the OP5+ sections of `design.md`). OP0–OP4 stay
> as the shipped substrate; this document re-anchors the platform from OP5 on.
> Paired CLI design: `orun/specs/orun-cloud/design-v2.md`.

## 0. Why a v2

v1 built the cloud as a place you *define* structure (orgs, projects,
environments) that the CLI then syncs into, anchored on the run-coordination
contract (`statebackend.Backend`: InitRun/Claim/Heartbeat). That shipped OP0–OP4
and works. But four pressures, worked through in design review, point past it:

1. **Git is the source of truth.** The state plane is downstream of the repo —
   runs, plans, catalogs all originate there. The cloud should be a *projection*
   of pushed state, not a parallel registry you hand-maintain.
2. **The CLI is moving to the object model.** `orun`'s newer content-addressed
   object model (`specs/orun-object-model/`) already defines how the TUI *and* a
   hosted SaaS consume one seam (`ModelReader`/`RunStarter`). v1's coordination
   contract is a narrower seam that can host runs but not the source → catalog →
   history graph the TUI reads locally.
3. **Tenancy is per-repo.** "A project is a repo" collapses the binding problem:
   the repo *is* the project identity, materialized from what's pushed.
4. **GitHub is the native surface.** The `saas-integrations` GitHub App
   (IG0–IG4, code-complete) is the right trust keystone and the natural
   ingestion + write-back bridge — but nothing wires it to the object graph yet.

v2 is the single inversion that subsumes all four: **the state store is the
source of truth, and the control plane is a read-projection plus a settings
layer over it.**

## 1. The governing principle: identity is materialized, attributes are authored

The discipline that makes "git is the source of truth" precise and safe is a
clean split:

| Concern | Source of truth | Authored where |
|---|---|---|
| **Org** | authored | console — the billing + identity + RBAC + trust root |
| **Project (= repo)** | materialized from push / installation | identity = the repo; per-repo settings authored |
| **Environment** | materialized from the `environment` on pushed runs/catalog | identity = the name; per-env settings authored |
| **Component / service** | materialized from catalog push | identity = catalog key + provenance; ownership authored |
| CI trust, secrets, RBAC, allowlist | authored | console settings, attached to the above |

**Rule:** *first reference materializes the node; its natural key is its
identity; console authoring is optional pre-creation, never the source of
truth.* You can delete the entire projection and rebuild it by replaying the
object store + refs + the separately-stored settings. That property *is* "the
state store is the source of truth."

One concession to pure materialize-only: a node may be **pre-declared** (so an
admin can attach a secret or a CI guardrail to `env=prod` before the first prod
push). Declare and push converge on the same natural key — whichever comes
first creates it, the other confirms. This closes the secrets/env chicken-and-egg
without weakening the rule.

## 2. Pillar A — the cloud is the hosted object model

### 2.1 Three layers, one seam

Orun's state store is a git/Nix-shaped model (`specs/orun-object-model/`):

- **L0 `ObjectStore`** — immutable blobs + trees named by `sha256(content)`
  (`PutBlob/PutTree/Get/Has/Walk`). Identity is content; the same object has the
  same id locally and in the cloud.
- **L2 `RefStore`** — the mutable layer: CAS pointers = the **heads**
  (`Read/Update(name, old, new)/List`).
- **L3 index** — derived, rebuildable query tables (by-time, by-status,
  component → revisions → executions).

The node graph is `Source → Catalog → Revision → Trigger → Execution
(→ jobs → attempts → steps)`, every edge an ObjectID. `remote-and-consumers.md`
§2 already *defines* the cloud as exactly this, hosted: object bucket (R2) +
CAS ref store (KV) + index service, routed
`orgs/<org>/projects/<project>/{objects,refs}/…`.

### 2.2 The read seam the console and TUI share

The cloud's primary read API is the object model's `ModelReader`
(`remote-and-consumers.md` §4):

```go
type ModelReader interface {
  ResolveRef(name) ObjectID
  Catalog(id) CatalogView          // catalog + components + graph
  Revision(id) RevisionView
  Execution(id) ExecutionView      // sealed or live
  ComponentHistory(key) HistoryView
  ListExecutions(filter) []ExecSummary
}
```

The **console becomes a `ModelReader` consumer, exactly like the TUI.** This is
the load-bearing v2 change: today the cloud implements the narrower
`statebackend.Backend` (runs/logs) plus partial CAS + `(project, environment)`
catalog heads, and `bridge.Source` exposes only `LoadRun`/`ListRuns` (remote
`ListRuns` is still a stub). v2 exposes the full `ModelReader` over the hosted
object graph so the console can serve source/head selection, catalog browsing,
and component history through the *same* seam the local object model serves —
no second read path.

### 2.3 Selecting source/head = resolving a ref

Selection is ref resolution, not a bespoke API (`internal/objplan/refs.go`):

```
refs/sources/{current,main,branches/<b>,prs/<pr>}     ← pick a source (branch / PR / commit)
refs/catalogs/{current,main,branches/<b>,prs/<pr>}    ← the catalog at that source
refs/revisions/latest, refs/named/<name>              ← compiled plans
refs/executions/{latest, live/<id>, by-id/<id>}       ← execution history
```

Select a source/head → `ResolveRef` → read the `Catalog` at that head →
`ListExecutions` filtered by its revision. The cloud holds every branch/PR/commit
across the org, so source/head selection is a *richer* console feature than the
local TUI (which only shows the current checkout) — hosted git-ref browsing.

### 2.4 Coordination is demoted to a write-path

Run coordination (claims, leases, heartbeats — the OP2 plane) stays, because
distributed multi-runner execution needs it and the pure object model does not
cover it. But it is demoted: its *results land as execution objects + refs/
executions/*, so reading history is uniform whether a run was local, CI, or
cloud-scheduled. The existing frozen coordination contract is retained as the
execution write-path under the object plane, not the primary seam.

## 3. Pillar B — materialized tenancy (project == repo, env == pushed name)

- **Project is the repo, 1:1.** `state.workspace_links` already enforces one
  active project per repo *per org* (`uq_state_workspace_link_remote ON
  (org_id, remote_url) WHERE active`). v2 adds the reverse — `UNIQUE
  (org_id, project_id) WHERE active` — for a bijection, and stores rename-stable
  provider identity (`provider`, `provider_repo_id`, `provider_owner_id`,
  `provider_owner_login`). Federation matches on `provider_repo_id`, never on
  `owner/name`.
- **Environment is keyed `(project, name)` and upserted on ingest** — never
  created in console. The intent.yaml env name === cloud env name === the GitHub
  Actions `environment` claim: one identifier across all three planes. This is
  what makes env mapping seamless and what lets a `prod` GHA deployment-environment
  gate map onto the `prod` orun environment for per-env secrets and CI guardrails.
- **Monorepo = one project** (services via the catalog, targets via
  environments). Multi-repo app = multiple projects. These follow directly from
  project == repo.

## 4. Pillar C — credential-agnostic CI auth

Both credentials resolve to one `ActorContext{org, project}`; all `state.*`
routes accept either. CI selection order is unchanged (`design.md` §3): OIDC if
`ACTIONS_ID_TOKEN_REQUEST_URL` present, else `ORUN_TOKEN` (`sk_` key), else
session.

- **The GitHub App installation is the org binding.** `integrations.connections`
  carries an `installation_id ↔ org_id` binding via a signed, single-use,
  fail-closed state (no auto-claim of unsolicited installs). This *is* the
  allowlist we reached for — managed in GitHub's own UI, audited. The
  installation's `repository_selection` enumerates the trusted repos.
- **OIDC path** (`POST /v1/auth/oidc/exchange`, audience `orun-cloud`, frozen
  D1): verify the GitHub JWKS signature → resolve `(provider, repository_id)` →
  active workspace_link → `(org, project)` → check `repository_id ∈ installation`
  repos and the per-link CI settings (allowed refs/environments) → mint a
  short-lived `actorKind: "workflow"` token. The `workspace_link` *is* the trust
  binding; the separately-planned `oidc_trust_bindings` table is **dropped** —
  folded into the link + installation + per-link settings.
- **API-key path** (shipped: `service_principals` + `api_keys`): project-scoped
  key = repo-scoped; org-scoped key declares project via intent.yaml, enforced
  `project ⊆ key scope`. The non-GitHub-runner fallback (GitLab, self-hosted).
- **intent.yaml declares `org`** as a *checked claim*, not a grant — it
  disambiguates when a repo is linked across orgs and routes for org-scoped
  keys, and must be ⊆ what the link/installation authorizes. **This reverses
  `design.md:163`** ("org/project come from the RepoLink, never from intent"):
  intent declares the target; the server-side link/installation authorizes it.

## 5. Pillar D — the GitHub App bridge (integrations ↔ object graph)

The `saas-integrations` GitHub App is the bidirectional bridge between GitHub
and the object graph. The foundation (IG0–IG4) is code-complete; v2 adds the two
consumers that connect it to the state plane, across the bounded-context seam
that is the event_log (inbound) and the token broker / write-back proxy
(outbound). **state-worker never holds GitHub credentials.**

```
GitHub ─webhook─▶ edge ─raw─▶ integrations-worker (HMAC verify, inbox, idempotent)
                                   │ normalize → scm.* on event_log
                                   ▼
              state-worker scm.* INGESTION CONSUMER  (new)
                scm.push → mint contents:read token (broker) → read repo@sha →
                  write Source + Catalog objects → move refs/sources|catalogs/* →
                  (opt) record Trigger + auto-run
                scm.pull_request → catalog diff (Merkle base↔head) → record Trigger
                                   │
                                   ▼ (hosted object graph = ModelReader)
              ┌────────────────────┴────────────────────┐
              ▼                                          ▼
        console + orun tui --remote            run/plan/catalog results
        (ModelReader consumers)                         │
              WRITE-BACK PROXY (new) ◀── state emits result event ┘
              Check Run · commit status · Deployment status
              (App perms already granted: checks/statuses/deployments:write)
```

- **Inbound (materialize):** a new state-worker consumer of `scm.push` /
  `scm.pull_request` reads the repo at the commit (via a broker-minted
  `contents:read` token) and writes Source + Catalog objects, moving
  `refs/sources|catalogs/*`. The org-global catalog populates itself from git.
  Auto-run is opt-in per project. *This is the one genuinely new platform
  behavior — the integrations epic deliberately scoped out "CI/CD on SCM
  events"; v2 makes source/catalog ingestion (not full execution) first-class.*
- **Outbound (project):** the deferred write-back proxy in integrations-worker
  (the worker that owns the App creds) posts Check Runs (affected components from
  the Merkle catalog diff, drift, plan result, deep link to the cockpit), commit
  statuses, and Deployment statuses, driven by state-worker result events.
- **Reconcile the two repo-links onto the project spine:**
  `integrations.repo_links` (App-backed: webhooks, token, `branch_env_map`,
  write-back) *enriches* a project; `state.workspace_links` (CLI, any git host,
  no App) is the App-less fallback. Both point at the same project (= repo),
  keyed on `repo_external_id`. A project materializes from whichever comes first:
  App installation repo-selection, `orun cloud link`, or first OIDC/key push
  (TOFU under the installation). The console already cross-links them
  (`design.md:56`).
- **Environments:** `repo_links.branch_env_map` → orun environments → GitHub
  Deployments + Environments UI (required reviewers gate prod), closing the
  env-identifier loop from Pillar B.

## 6. The org-global catalog

Default catalog view is **one org-wide component graph** across all projects.
`catalog_heads` stay as the immutable per-`(project, environment)` publish
pointers (write path, history, rollback); on head-advance the snapshot's
components are **indexed into an org-level read model with provenance** (source
project, environment, commit). "Repo" is a provenance *filter* over that merged
graph, not a storage partition. A second surface — the repo/project list — is
the settings entry point (per-repo CI/auth/secrets) and shows that repo's
component sublist (the catalog filtered to its provenance). Components are
namespaced by source project to keep ingestion collision-free, presented merged;
cross-project deps use explicit fully-qualified refs. The catalog *model* stays
owned by `orun/specs/orun-service-catalog`; only the projection is in scope.

## 7. Decisions locked (v2)

- **DV1 — Re-anchor on the object-model seam.** The cloud exposes
  `ObjectStore` + `RefStore` + `ModelReader`; coordination is a write-path under
  it, not the primary contract.
- **DV2 — Console = `ModelReader` consumer**; `bridge.Source` widens to the full
  `ModelReader` so console and TUI share one read seam over local or cloud.
- **DV3 — Identity materialized, attributes authored** (§1); nodes may be
  pre-declared but the state store is the source of truth.
- **DV4 — Project == repo (bijection on the tightened `workspace_links`);** the
  installation/link *is* the CI trust binding; `oidc_trust_bindings` is dropped.
- **DV5 — intent.yaml declares `org`/`env` as checked claims** (supersedes
  `design.md:163`).
- **DV6 — The GitHub App is the inbound ingestion + outbound write-back bridge,
  across the event_log / token-broker seam;** state-worker never holds GitHub
  creds.
- **DV7 — Org-global catalog; repo/env are index projections with provenance.**

## 8. What stays unchanged

OP0–OP4 (foundation, CLI session auth, run coordination, object/log plane,
tenancy & workspace links) remain the shipped substrate. The frozen wire
identifiers — OIDC audience `orun-cloud`, JWT issuer `https://api.orun.dev` —
do not churn. Local-first and the degradation table (`design.md` §7) are
unchanged: cloud is additive, never required.
