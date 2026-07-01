# saas-workspace-overview — Model (normative, shared across repos)

Status: Draft (normative once WO1 lands). Grounded against `orun`
`internal/catalogmodel/*`, `internal/model/intent.go`, `internal/remotestate/*`,
`internal/objremote/*` and orun-cloud `apps/state-worker/src/catalog-projection.ts`,
`packages/db/src/migrations/*` as of 2026-06-30. This is the shared contract; the
`orun` repo's `specs/orun-workspace-overview/` references it and owns the CLI half.

Defines: (1) an `intent.yaml` `docs` convention spanning **every** entity kind,
(2) two new declared kinds — **`Repo`** and **`Product`** — that point at an
overview, (3) how repo-authored docs travel as **content-addressed `doc`
objects** in the catalog snapshot and render **by digest** with no git-provider
coupling, and (4) a **repo-level top layer** (`state.repo_facet`) that drives the
Git Repos list.

## 0. The decisions this locks

| Decision | Choice |
|----------|--------|
| **How does markdown reach the platform?** | As its **own content-addressed `doc` object** in the catalog snapshot closure. `orun plan` reads each referenced `docs.overview` at HEAD and adds it to the object closure (kind `doc`); the entity's `doc_ref` is `{path, ref, sha, digest}`. orun-cloud renders the body from R2 **by digest** — no live git call, works for **any git remote**, self-host-portable, and pinned to the commit the catalog head was advanced at. Set-difference sync means an unchanged doc is never re-uploaded. **No GitHub App, no token broker, no render-time provider coupling.** |
| **How do repo/product identity enter the catalog?** | As **first-class declared entity kinds** (`Repo`, `Product`) emitted from `intent.yaml`, riding the **existing** snapshot → catalog-head → projector path. `kind` is free-text TEXT server-side, so this needs **no kind-enum migration**. |

## 1. Grounding — the verified push spine

`orun plan` (only `plan`; `run` never pushes) publishes the catalog on a clean
default branch (`--push-catalog` or `execution.state.autopushCatalog: true`):

```
intent.yaml + component.yaml*                    ── repo (the source of truth)
   │  LoadIntent()  internal/loader/loader.go
   │  metadata.{name,description,namespace} + execution.state.{backendUrl, workspace|org, project?}
   ▼
CatalogSnapshot  internal/catalogmodel/catalog_snapshot.go
   catalog.json + entities/<Kind>/*.json + relations.json   (a Merkle tree of objects)
   │  resolveScope():  flags > env > intent > cached link  → Scope{orgId, projectId}
   ▼
object sync — set-difference, only missing blobs
   POST …/state/objects/missing     { digests:[...] }
   PUT  …/state/objects/{digest}     header Orun-Object-Kind: <kind>
   ▼
advance the head
   PUT  /v1/organizations/{orgId}/projects/{projectId}/state/catalog/head  { digest, environment, commit }
   → emits catalog.head.advanced
   ▼
orun-cloud state-worker
   • blob bytes → R2  state/{orgId}/{projectId}/objects/{digest}   (index → state.objects; kinds: plan|catalog-snapshot|composition-lock|artifact-manifest)
   • projector  apps/state-worker/src/catalog-projection.ts  (on catalog.head.advanced)
        walk blob → DELETE-then-UPSERT  state.org_catalog_entities   keyed (org_id, source_project_id, source_environment, entity_ref)
```

Verified facts this model relies on:

- **Base path is per-project**: `/v1/organizations/{orgId}/projects/{projectId}/state`.
  A repo **is** a project; the repo↔project binding is `state.workspace_links`
  (`remote_url` normalized; 1:1 active per `(org, project)` and per `(org,
  remote_url)`), created on first `orun cloud link`. This works for **any git
  remote with no GitHub App** — the invariant this epic preserves.
- **Entity kinds** (`orun/internal/catalogmodel/entity_ref.go`): `Component, API,
  Resource, System, Domain, Group, User, Composition, Environment, Deployment`
  (+ legacy `Owner`→`Group`), validated by the `allEntityKinds` array.
  `System`/`Domain` are **derived** from component `spec.system`/`spec.domain`;
  `Groups`/`Environments`/`Components` are **declared** in `intent.yaml`. No
  top-level `repos`/`products` map today.
- **Docs are already pointers**: `EntityDocs = { techdocs: <path>, runbooks:
  [<path>], adrs: [<path>] }` (`entity_envelope.go`), shared by every kind,
  authored on `component.yaml spec.docs`. No inline bodies anywhere today.
- **Cloud projector accepts any `kind` string** — no server-side enum;
  `org_catalog_entities.kind` is TEXT. Frontend kind styling is a fixed array in
  `web-console-next/src/lib/catalog-kind.ts`.
- **CAS is content-addressed and set-difference-synced** (`objremote.Sync`):
  adding blobs to the closure only uploads the ones the backend is missing.

## 2. The intent spec — one `docs` convention across all kinds

### 2a. Universal docs pointer (extend the shared struct)

Add `overview` to the existing docs struct so **every** kind carries one canonical
"front page" md, as a **path** (never inline content):

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
the shared envelope.

### 2b. Two new **declared** kinds in `intent.yaml`

The scoping difference is the crux and reuses a distinction the model already
makes — a repo is an identity *segment*; systems *merge* across repos:

| Kind | Scope | Ref | Cardinality | Merges across repos? |
|------|-------|-----|-------------|----------------------|
| **`Repo`** | repo-scoped | `repo:<provider>/<owner>/<name>` | exactly one per `intent.yaml` (the repo describing itself) | No — one per project |
| **`Product`** | namespace-scoped | `product:<namespace>/<name>` | zero or more | **Yes** — same product declared in N repos merges, like a `System` |

```yaml
# intent.yaml — new top-level blocks
metadata: { name: lumen, description: "Multi-tenant SaaS baseline…", namespace: sourceplane }

repo:                                  # singular — self-describes THIS repo → Git Repos list + repo header
  displayName: Lumen Platform
  owner: group:platform
  docs: { overview: docs/overview.md }
  links: [ { title: Runbook, url: https://… } ]
  tags: [saas, baseline]

products:                              # 0..N; a product can span repos (merges by namespace key)
  lumen:
    displayName: Lumen
    description: The Lumen SaaS product
    owner: group:platform
    systems: [identity, billing, metering]
    docs: { overview: docs/product/lumen.md }   # → the Workspace Overview hero
```

CLI change (bounded, ~5 sites per the kind-extensibility path): add
`EntityKindRepo`/`EntityKindProduct` constants + to `allEntityKinds`; add
`RepoSpec`/`ProductSpec` (`overview` ref, `owner`, `links`, `systems`, derived
`members`); add top-level `Repo`/`Products` to `internal/model/intent.go`; emit
`entities/Repo/*.json` + `entities/Product/*.json`; bump `CatalogSummary` counts.
No new wire call — they ride the existing `catalog-snapshot` object.

## 3. Doc bytes — content-addressed objects, rendered by digest

The catalog snapshot is **already a Merkle tree** moved by set-difference sync.
Docs join it as blobs referenced by digest — the native pattern:

```
orun plan  (internal/catalogmodel + objremote.Sync)
   1. resolve each entity's docs.overview → read the file bytes at HEAD
   2. add each as an object in the closure:  digest = sha256(bytes)
      entity JSON gets  docs.overview = { path, ref, sha, digest }
   3. set-difference sync:  POST …/objects/missing → PUT only missing digests
      PUT …/state/objects/{digest}   header Orun-Object-Kind: doc
   4. advance the head  (the docs are in the closure the head pins)
   ▼
orun-cloud
   • doc bytes → R2  state/{org}/{project}/objects/{digest}   (index row kind='doc')
   • projector records doc_ref.digest on the entity / repo_facet
   ▼
console renders overview:  read the doc object by digest → sanitize → render
```

Why this is the model, not a live fetch:

- **Any git remote, no App.** Honours the explicit `18-state.md` invariant —
  "Orun linking must work for any git remote with no GitHub App installed." The
  CLI reads the working tree and pushes; GitLab/Gitea/bare-git and the OSS
  self-host backend all work identically. **No git-provider coupling exists in
  this feature at all.**
- **Point-in-time correct.** The doc is pinned to the exact commit the catalog
  head was advanced at — the overview always matches the catalog it shipped with.
  This is the *same* snapshot-at-plan freshness the rest of the catalog has.
- **Self-contained & fast.** Rendered from R2 (owned, low-latency); no external
  round-trip or rate limit on the hot path; no repo-read scope for private repos.
- **Nearly free on the CLI.** `objremote.Sync` already walks the closure and
  set-diffs; unchanged docs (same digest) are never re-uploaded; bytes are tiny
  and content-addressed (dedup across repos/pushes).

Bounds: push **only the single `docs.overview` file per entity** by default (KB-
scale). A `techdocs: docs/` *tree* is opt-in and size-capped. Storage counts
toward `limit.state.storage_gb` and obeys normal object retention/GC.

Migration cost: **one added value (`doc`)** in the `state.objects.kind` CHECK
constraint. Everything else (CAS, sync, R2 layout, retention) already exists.

Security: repo markdown is rendered through a **sanitizing** pipeline (no raw
HTML, `rel="nofollow ugc noopener"`, no auto-loaded remote images), width-
constrained prose, console type scale.

## 4. State model — a repo top layer + digest pointers

Two additive, **derived-never-authored** pieces, projected on
`catalog.head.advanced` alongside the existing entity upsert:

### 4a. `state.repo_facet` — the repo-level top layer (drives the repos list)

The Git Repos list is driven by `projects.projects` + `workspace_links`, not the
catalog. Give it an O(1) companion projection, keyed per project:

```sql
CREATE TABLE state.repo_facet (
  org_id            UUID NOT NULL,
  source_project_id UUID NOT NULL,          -- the project (repo)
  display_name      TEXT,
  description       TEXT,                    -- from the repo block / intent metadata.description
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

### 4b. `doc_ref` on any entity — a digest pointer into CAS

`org_catalog_entities` gains a nullable `doc_ref JSONB` projected from each
entity's `docs.overview`: `{path, ref, sha, digest}`. The **digest** is the
content address of the doc object (§3); `path/ref/sha` are provenance (the "view
source" link). The body is read from R2 by digest — Postgres holds only the
pointer.

> `kind` is already TEXT and the projector is kind-agnostic, so `Repo`/`Product`
> rows need **no kind migration**. New: `state.repo_facet`, the `doc_ref` column,
> and one added value (`doc`) in the `state.objects.kind` CHECK constraint.

### 4c. Workspace identity — a pointer, not authored content

A workspace (org) with N repos resolves its hero identity from a **primary
project** — the only authored bit is a pointer:

- `primary_project_id UUID NULL` on the org (default = most-recently-synced
  active `workspace_links` project).
- Optional `override_overview JSONB NULL` on the org — the escape hatch for a
  workspace with **no repo linked yet**, so the page is never empty. Repo-synced
  wins field-by-field when present.

`GET /v1/organizations/{orgId}/overview` resolves: primary project's `Product`/
`repo_facet` ∪ override (repo wins), plus the repo list. Signal tiles keep
reading `org_catalog_entities` (org-wide) + the runs feed, so the page degrades
gracefully if no overview exists yet.

## 5. Multi-repo — merge, don't partition

Each repo pushes its own catalog head + snapshot, scoped `(org, project)`. The
org-global catalog is the **merge** in `state.org_catalog_entities`, every row
carrying provenance (`source_project_id, source_environment, source_commit,
head_digest`) — repo/env are **filters, not partitions**. So:

- **One product (e.g. lumen):** the primary project supplies the hero identity +
  narrative; other linked repos render in the "Repositories" card.
- **Multi-product workspace:** each `Product` entity renders as a product card,
  filtered by `?project=<source_project_id>`; the merge already distinguishes them
  by provenance. No model change.

## 6. How every surface is fed

| Surface | Reads | Body |
|---------|-------|------|
| **Git Repos list** | `state.repo_facet` (per project) | none (description inline); overview badge |
| **Repo header/detail** | `repo_facet` + its `doc_ref` | `doc` object from R2 by digest |
| **Workspace Overview hero** | `Product` entity (primary) / primary `repo_facet` | `doc` object from R2 by digest |
| **Component / System / Domain page** | `org_catalog_entities` row + `doc_ref` | `doc` object from R2 by digest |
| **Signal tiles** | `org_catalog_entities` rollup (org-wide) + runs feed | none |

## 7. Why this is the optimum

- **One convention, every kind** — `docs.overview` extends the struct all kinds
  already share; a `Repo`, a `Product`, and a `Component` point at their md the
  same way.
- **Repo vs Product scoping is principled** — reuses the proven "repo is a segment
  / systems merge across repos" distinction, so a product spanning repos just
  works via the org-wide merge.
- **State stays git-derived, and the doc is part of it** — the doc bytes are a
  content-addressed object pinned to the head, never console-authored; the
  `18-state.md` "derived, never authored, drift-free" invariant holds verbatim.
- **Zero git-provider coupling** — provider-agnostic, self-host-portable, no App,
  no token, no render-time external call; the OSS backend behaves identically.
- **Reuses what's built** — the CAS closure + set-difference sync already ship the
  snapshot; docs ride it as blobs. Net-new is one `state.objects.kind` value
  (`doc`) + `repo_facet` + the `doc_ref` column.

## 8. What deliberately does NOT change

- No new entity beyond `repo_facet` + a `doc_ref` column + the `doc` object kind.
- No console CMS; the console never authors catalog content.
- No change to the catalog/activity read models — the signal row and cards reuse
  them.
- No renaming of `project`/`environment`.
- **No git-provider integration** — this feature never depends on the GitHub App
  or any provider API.
