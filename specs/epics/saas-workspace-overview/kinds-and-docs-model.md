# saas-workspace-overview — Kinds, Docs pointers, and the fetch-live state model

Status: Draft (supersedes `wiring.md §3`'s "push markdown into the snapshot"
recommendation). Grounded against `orun` `internal/catalogmodel/*` and orun-cloud
`apps/integrations-worker/*`, `apps/state-worker/src/catalog-projection.ts`,
`packages/db/src/migrations/*` as of 2026-06-30.

This defines the **optimum model** for: (1) an intent-spec `docs` convention that
spans **every** entity kind, (2) two new declared kinds — **`Repo`** and
**`Product`** — that point at an overview, (3) a **repo-level top layer** on
catalog state that drives the Git Repos list, and (4) **render-time markdown
fetch from the repo via the GitHub integration** — state stores the *pointer*,
never the prose.

## 0. The two decisions this locks

| Decision | Choice |
|----------|--------|
| **Where does markdown live in the platform?** | **As its own content-addressed object in the state plane (base); fetch-live is an optional freshness overlay.** `orun plan` walks each referenced `docs.overview` into the object **closure** as a separate `doc` object (kind `doc`); the entity's `doc_ref` becomes `{path, ref, sha, digest}`. orun-cloud renders the body from R2 **by digest** — no GitHub call, works for **any git remote** (honours the `18-state.md` "no App required" invariant), and is point-in-time-consistent with the catalog head it shipped with. Set-difference sync means an unchanged doc is never re-uploaded. Fetch-live via the GitHub App is kept only as an optional "latest-on-branch / drift" overlay where the App is linked. **(Supersedes the earlier fetch-live-as-base and the still-earlier inline-`narrativeMarkdown` ideas.)** |
| **How do repo/product identity enter the catalog?** | As **first-class declared entity kinds** (`Repo`, `Product`) emitted from `intent.yaml`, riding the **existing** snapshot → catalog-head → projector path. `kind` is free-text TEXT server-side, so this needs **no DB/enum migration** for the kind itself. |

## 1. Grounding — what exists today (verified)

- **Entity kinds** (`orun/internal/catalogmodel/entity_ref.go`): `Component, API,
  Resource, System, Domain, Group, User, Composition, Environment, Deployment`
  (+ legacy `Owner`→`Group`), validated by the `allEntityKinds` array.
  `System`/`Domain` are **derived** from component `spec.system`/`spec.domain`;
  `Groups`/`Environments`/`Components` are **declared** in `intent.yaml`. There is
  **no** top-level `repos`/`products`/`systems` map today.
- **Docs are already pointers**: `EntityDocs = { techdocs: <path>, runbooks:
  [<path>], adrs: [<path>] }` (`entity_envelope.go`), shared by every kind,
  authored on `component.yaml spec.docs`. No inline bodies anywhere.
- **Snapshot layout**: `catalog.json` (summary) + `entities/<Kind>/<name>.json` +
  `relations.json`, pushed as one `catalog-snapshot` CAS object; the head advance
  triggers the projector.
- **Cloud projector** (`state-worker/src/catalog-projection.ts`): walks the blob,
  DELETE-then-UPSERTs `state.org_catalog_entities` with per-row provenance
  (`source_project_id, source_environment, source_commit, head_digest`). It
  **accepts any `kind` string** — no server-side enum. Frontend kind styling is a
  fixed array in `web-console-next/src/lib/catalog-kind.ts`.
- **GitHub integration** (`apps/integrations-worker`): `integrations.connections`
  (account-level App connection), `github_installations` (`permissions` JSONB),
  `repo_links` (`org_id, project_id, connection_id, repo_external_id,
  repo_full_name, default_branch, branch_env_map`), `installation_tokens`
  (AES-256-GCM cache). `github-app.ts` mints App JWTs + scoped installation
  tokens; the **token-broker** issues short-lived repo-scoped tokens with
  permissions ⊆ App grant (`contents:read` is already a requested permission).
  **Missing:** any `GET /repos/{owner}/{repo}/contents/{path}` call — net-new.
- **repo_links ↔ workspace_links** federate on `(provider, provider_repo_id)`
  (rename-stable). A CLI `workspace_link` alone (no App) cannot mint a token.

## 2. The intent spec — one `docs` convention across all kinds

### 2a. Universal docs pointer (extend the shared struct)

Add `overview` to the existing docs struct so **every** kind carries one canonical
"front page" md, as a **path pointer** (never content):

```yaml
# component.yaml (existing spec.docs — now with `overview`)
spec:
  docs:
    overview: docs/overview.md        # NEW: the single front-page md for this entity
    techdocs: docs/                   # existing
    runbooks: [ops/runbook.md]        # existing
    adrs: [docs/adr/0001.md]          # existing
```

CLI change: add `Overview string` to `ComponentDocs`/`EntityDocs`/
`ComponentYAMLDocs` (`orun/internal/catalogmodel/*`). Every kind inherits it via
the shared envelope — components, systems, domains, and the two new kinds below.

### 2b. Two new **declared** kinds in `intent.yaml`

The scoping difference is the crux and mirrors a distinction the model already
makes (repo is an identity *segment*; systems *merge* across repos):

| Kind | Scope | Ref | Cardinality | Merges across repos? |
|------|-------|-----|-------------|----------------------|
| **`Repo`** | repo-scoped | `repo:<provider>/<owner>/<name>` | exactly one per `intent.yaml` (the repo describing itself) | No — one per project |
| **`Product`** | namespace-scoped | `product:<namespace>/<name>` | zero or more | **Yes** — same product declared in N repos merges, like a `System` |

```yaml
# intent.yaml — new top-level blocks
metadata:
  name: lumen
  description: Multi-tenant SaaS baseline…
  namespace: sourceplane

repo:                                  # singular — self-describes THIS repo
  displayName: Lumen Platform
  owner: group:platform
  docs:
    overview: docs/overview.md         # → the Git Repos list + repo header
  links:
    - { title: Runbook, url: https://… }
  tags: [saas, baseline]

products:                              # a repo may define 0..N products; products may span repos
  lumen:
    displayName: Lumen
    description: The Lumen SaaS product
    owner: group:platform
    systems: [identity, billing, metering]   # which systems compose it
    docs:
      overview: docs/product/lumen.md   # → the Workspace Overview hero
```

CLI change (bounded, ~5 sites per the kind-extensibility path): add
`EntityKindRepo`/`EntityKindProduct` constants + to `allEntityKinds`; add
`RepoSpec`/`ProductSpec` (`overview` ref, `owner`, `links`, `systems`, derived
`members`); add top-level `Repo`/`Products` to `internal/model/intent.go`; emit
`entities/Repo/*.json` + `entities/Product/*.json`; bump `CatalogSummary` counts.
No new wire call — they ride the existing `catalog-snapshot` object.

## 3. The state model — a repo top layer + doc references (not bodies)

Two additive, **derived-never-authored** pieces, both projected on
`catalog.head.advanced` alongside the existing entity upsert:

### 3a. `state.repo_facet` — the repo-level top layer (drives the repos list)

The Git Repos list is driven by `projects.projects` + `workspace_links`, not the
catalog. Give it an O(1) companion projection, keyed per project:

```sql
CREATE TABLE state.repo_facet (
  org_id            UUID NOT NULL,
  source_project_id UUID NOT NULL,          -- the project (repo)
  display_name      TEXT,
  description       TEXT,                    -- from repo block / intent metadata.description
  owner             TEXT,
  default_branch    TEXT,
  links             JSONB DEFAULT '[]'::jsonb,
  doc_ref           JSONB,                   -- {path, ref, sha, digest}  ← digest = the doc object in CAS
  head_digest       TEXT NOT NULL,
  source_commit     TEXT,
  synced_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, source_project_id)
);
```

Projected from the `Repo` entity in the snapshot. The repos list reads it
directly (description, owner, "has overview" badge); the Workspace Overview reads
the `Product` entity (or the primary repo's `repo_facet`).

### 3b. `doc_ref` on any entity — a digest pointer into CAS

`org_catalog_entities` gains a nullable `doc_ref JSONB` projected from each
entity's `docs.overview`: `{path, ref, sha, digest}`. The **digest** is the
content address of the doc object the CLI pushed into the closure (§4); `path/ref/
sha` are provenance (the "edit on GitHub" link and the drift check). The body is
read from R2 **by digest** — Postgres holds only the index/pointer. The `Repo`
facet carries its own `doc_ref` (3a); components/systems/products carry theirs on
their `org_catalog_entities` row.

> `kind` is already TEXT and the projector is kind-agnostic, so `Repo`/`Product`
> rows need **no kind migration**. New: `repo_facet`, the `doc_ref` column, and
> one added value (`doc`) in the `state.objects.kind` CHECK constraint (§4).

## 4. Doc bytes: content-addressed objects (base) + optional live overlay

### 4a. Base — push each referenced doc as its own `doc` object

The catalog snapshot is **already a Merkle tree**: `catalog.json` +
`entities/<Kind>/*.json` leaves, transferred by the CLI's **set-difference**
object sync (`objects/missing` → PUT only the missing digests). Docs join that
tree as blobs referenced by digest — the native pattern, not a bolt-on:

```
orun plan  (internal/catalogmodel + objremote.Sync)
   1. resolve each entity's docs.overview → read the file bytes at HEAD
   2. add each as an object in the closure:  digest = sha256(bytes)
      entity JSON gets  docs.overview = { path, ref, sha, digest }
   3. set-difference sync:  POST …/state/objects/missing  → PUT only missing digests
      PUT …/state/objects/{digest}   header Orun-Object-Kind: doc
   4. advance the head as usual  (the docs are in the closure the head pins)
   ▼
orun-cloud
   • doc bytes → R2  state/{org}/{project}/objects/{digest}   (index row kind='doc')
   • projector records doc_ref.digest on the entity / repo_facet
   ▼
console renders overview:  GET the doc object by digest → sanitize → render
```

Why this is the base:
- **Any git remote, no App.** Honours the explicit `18-state.md` invariant —
  "Orun linking must work for any git remote with no GitHub App installed." The
  CLI reads the working tree and pushes; GitLab/Gitea/bare-git and the OSS
  self-host backend all work identically. Fetch-live would make the overview a
  GitHub-only, SaaS-only feature.
- **Point-in-time correct.** The doc is pinned to the exact commit the catalog
  head was advanced at — the overview always matches the catalog it shipped with,
  never skewed by a later push to `main`. This is the *same* freshness model the
  rest of the catalog already has (snapshot-at-plan), so it is consistent, not a
  regression.
- **Self-contained & fast.** Rendered from R2 (owned, low-latency) — no GitHub
  round-trip, token mint, or rate limit on the hot path. No cloud-side repo-read
  scope needed for private repos.
- **Nearly free on the CLI.** `objremote.Sync` already walks the closure and
  set-diffs; adding doc blobs to the closure reuses it. Unchanged docs (same
  digest) are never re-uploaded. Bytes are tiny and content-addressed (dedup
  across repos/pushes).

Bounds: push **only the single `docs.overview` file per entity** by default (KB-
scale). A `techdocs: docs/` *tree* is opt-in and size-capped, so nobody
accidentally mirrors a large folder into state. Storage counts toward
`limit.state.storage_gb` and obeys the normal object retention/GC.

Migration cost: one added value (`doc`) in the `state.objects.kind` CHECK
constraint. Everything else (CAS, sync, R2 layout, retention) already exists.

### 4b. Optional overlay — live "latest on branch / drift" via the GitHub App

Where the repo **is** linked via the GitHub App (`integrations.repo_links`), a
thin overlay can fetch HEAD of the doc's branch to show freshness, **without**
being the source of record:

```
GET /v1/organizations/{orgId}/projects/{projectId}/repo/doc/head?entityRef=…   (optional)
   → token-broker mints repos:[repo_external_id], contents:read  (⊆ App grant)
   → github-app.getRepositoryFileContents(token, owner/repo, path, ref)   (NEW)
   → compare sha to doc_ref.sha:  equal → "up to date";  differ → "changed since last plan — re-plan to update"
```

- Value is a **drift signal + an always-current preview toggle**, not the base
  render. The base render is the pinned CAS object, so the page never depends on
  GitHub being reachable or the App being present.
- Reuses the shipped App JWT + token-broker; `scm.push` webhooks can flip the
  drift flag without polling. Net-new is only `getRepositoryFileContents` + a
  small handler; no persistent content cache is required (the CAS object is the
  cache).

### 4c. Security (both paths)

Untrusted repo markdown → sanitizing pipeline (no raw HTML,
`rel="nofollow ugc noopener"`, no auto-loaded remote images), width-constrained
prose, console type scale. Overlay tokens are minted per-request, scoped to one
repo, `contents:read` only, never logged.

## 5. How every surface is fed

| Surface | Reads | Body |
|---------|-------|------|
| **Git Repos list** | `state.repo_facet` (per project) | none (description inline); overview badge |
| **Repo header/detail** | `repo_facet` + its `doc_ref` | `doc` object from R2 by digest (+ optional drift badge) |
| **Workspace Overview hero** | `Product` entity (primary) / primary `repo_facet` | `doc` object from R2 by digest |
| **Component / System / Domain page** | `org_catalog_entities` row + `doc_ref` | `doc` object from R2 by digest |
| **Signal tiles** | `org_catalog_entities` rollup (org-wide) + runs feed | none |

## 6. Why this is the optimum

- **One convention, every kind.** `docs.overview` extends the struct all kinds
  already share — no per-kind special-casing; a `Repo`, a `Product`, and a
  `Component` all point at their md the same way.
- **Repo vs Product scoping is principled**, not ad-hoc — it reuses the proven
  "repo is a segment / systems merge across repos" distinction, so a product that
  spans repos just *works* via the org-wide merge, and a repo stays one-per-project.
- **State stays git-derived, and the doc is part of it** — the doc bytes are a
  content-addressed object pinned to the head, never console-authored. The
  `18-state.md` "derived, never authored, drift-free" invariant holds *more*
  faithfully than fetch-live, which would render live HEAD that can differ from
  the plan commit.
- **Provider-agnostic & self-host-portable** — the overview works for any git
  remote with no GitHub App, exactly like the rest of the catalog; the OSS
  self-host backend needs zero integration code. Fetch-live is demoted to an
  optional GitHub-only *freshness overlay*, not a dependency.
- **Reuses what's built** — the CAS closure + set-difference sync already move
  the snapshot; docs ride it as blobs. Net-new is one `state.objects.kind` value
  (`doc`) + `repo_facet` + the `doc_ref` column. The optional overlay adds only
  `getRepositoryFileContents` + a small handler — no persistent content cache.
- **Consistent freshness** — the overview is as fresh as the last plan (like the
  catalog), with an optional drift badge where the App is linked to nudge a
  re-plan; never empty and never dependent on GitHub being reachable.

## 7. Milestone deltas (folds into the README)

| ID | Milestone |
|----|-----------|
| WO2a | `orun`: add `docs.overview` to the shared docs struct; add declared `repo` + `products` blocks; **walk each `docs.overview` into the object closure as a `doc` object** and record `doc_ref={path,ref,sha,digest}`; emit `Repo`/`Product` entities |
| WO2b | orun-cloud: add `doc` to the `state.objects.kind` CHECK constraint; projector projects `Repo`→`state.repo_facet`, `Product`→`org_catalog_entities`, and `doc_ref` (digest pointer) on entities; add `Repo`/`Product` to `catalog-kind.ts`; expose a read-doc-by-digest path for the console |
| WO2c | *(optional overlay)* integrations-worker: `getRepositoryFileContents` + a small `repo/doc/head` handler over the token-broker for the live "drift / latest-on-branch" badge; `scm.push` flips the drift flag. No persistent content cache — the CAS object is the base render |
| WO3 | Git Repos list reads `repo_facet`; repo header renders the live overview; Workspace Overview hero renders the `Product`/primary-repo overview |
| WO4 | Empty/fallback states (no App link → description + "connect GitHub"); sanitizing markdown pipeline |
