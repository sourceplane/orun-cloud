# saas-workspace-overview — Wiring: `orun` → orun-cloud → Overview

Status: Draft (grounded against `orun` @ `internal/catalogmodel`,`internal/remotestate`
and orun-cloud @ `apps/state-worker`,`packages/db/src/migrations` as of 2026-06-30)

This answers two questions precisely, then proposes how the Overview is fed:

1. **How is `orun` wired to read `intent.yaml` and push it to orun-cloud?**
2. **With multiple repos, should the product identity/overview live in the
   catalog under the state file — and how does it aggregate?**

Everything here is verified against the actual code paths, not the spec prose.

## 1. The push flow, end to end (verified)

`orun plan` (and only `plan` — `run` never pushes) does this when the catalog is
published (explicit `--push-catalog`, or `execution.state.autopushCatalog: true`
on a clean **default branch** with a changed digest):

```
intent.yaml + component.yaml*                      ── repo (the source of truth)
   │  LoadIntent()  internal/loader/loader.go
   │  metadata.{name,description,namespace}
   │  execution.state.{backendUrl, workspace|org, project?, requireOrg, autopushCatalog}
   ▼
CatalogSnapshot                                    ── internal/catalogmodel/catalog_snapshot.go
   { repo, sourceScope, headRevision, treeHash, authoritative,
     summary, objects:[ManifestRef...] }           (component manifests, content-addressed)
   │  resolveScope():  flags > env (ORUN_WORKSPACE/ORUN_ORG) > intent > cached link
   │  → Scope{ orgId, projectId }                  internal/remotestate, cmd/orun/remote_config.go
   ▼
(1) object sync — set-difference, only missing blobs
   POST …/state/objects/missing      { digests:[...] }
   PUT  …/state/objects/{digest}      header Orun-Object-Kind: catalog-snapshot
   ▼
(2) advance the head
   PUT  /v1/organizations/{orgId}/projects/{projectId}/state/catalog/head
        { digest:"sha256:…", environment:null, commit:"…" }
   →    emits  catalog.head.advanced
   ▼
orun-cloud state-worker
   • blob bytes → R2  state/{orgId}/{projectId}/objects/{digest}
   • index row → state.objects        (org_id, project_id, digest, kind)
   • head row  → state.catalog_heads   (org_id, project_id, environment?, digest, commit)  — history retained
   • projector → apps/state-worker/src/catalog-projection.ts  (on catalog.head.advanced, waitUntil)
        fetch blob → walk entities → DELETE-then-UPSERT
        state.org_catalog_entities  keyed (org_id, source_project_id, source_environment, entity_ref)
   ▼
console reads:  GET /v1/organizations/{orgId}/catalog/entities?project=&environment=&kind=&owner=&q=
```

Base path is **per-project**: `/v1/organizations/{orgId}/projects/{projectId}/state`.
Auth/tenancy: the **workspace (org) claim** rides every request (OIDC exchange in
CI, or API key); `requireOrg` makes a non-interactive run with no resolvable org
fail fast. Gates: `catalog.publish` to advance, `catalog.read` to list.

**A repo is a project.** The repo↔project binding is the `state.workspace_links`
row (`remote_url` normalized, 1:1 active link per `(org, project)` **and** per
`(org, remote_url)`), created on first `orun cloud link`. `projects.projects`
itself stores only `name/slug/status` — **no repo URL, no primary flag.**

## 2. Multi-repo: merge, don't partition (verified)

Each repo pushes **its own** catalog head + snapshot, scoped `(org, project)`.
The org-global catalog the console shows is the **merge** in
`state.org_catalog_entities`, where every row carries provenance:

| Column | Meaning |
|--------|---------|
| `source_project_id` | which repo published the entity |
| `source_environment` | env scope (null = project-wide) |
| `source_commit` | git commit the snapshot resolved at |
| `head_digest` | the snapshot digest the row was projected from |

So **repo and environment are filters over one merged graph, not storage
partitions** (per the `330_state_org_catalog_index` migration comment). The
projector does a scoped delete-then-upsert, so a repo's entities are idempotently
replaced on each head-advance and entities dropped from the snapshot disappear.

**What is NOT stored anywhere today:** the product *identity*
(`intent.yaml metadata.{name,description,namespace}`) and any `overview.md`. The
only git-authored fields that survive are **per-component** portal fields
(`description, system, language, tags`) projected from each component's `spec`
(`catalog-projection.ts → portalFields()`). There is no product-level or
workspace-level identity record. That is the gap the Overview must close.

## 3. Recommendation — ride the state file, project a thin read-model

**Yes: put the product identity + overview *inside the catalog snapshot* (the
state file) and project it, exactly as component portal fields already are.** This
keeps the platform invariant — *derived from git, never authored in the console* —
and needs **no new push endpoint**. Three additive pieces:

### 3a. CLI (`orun`) — extend the snapshot, reuse the push

Add a top-level block to `CatalogSnapshot` (`internal/catalogmodel/catalog_snapshot.go`):

```go
type CatalogSnapshot struct {
    // …existing fields…
    Product *ProductIntent `json:"product,omitempty"`
}
type ProductIntent struct {
    Name            string       `json:"name"`            // intent.yaml metadata.name
    Description     string       `json:"description"`     // metadata.description
    Namespace       string       `json:"namespace"`       // metadata.namespace
    OverviewMarkdown string      `json:"overviewMarkdown,omitempty"` // .orun/overview.md → docs/overview.md → README.md
    Docs            []ProductDoc `json:"docs,omitempty"`  // declared pinned docs (title, path, body)
}
```

`orun plan` already loads `intent.yaml` and has a `Docs` concept at the component
level (`ComponentManifest.Docs`); resolving the first existing of
`.orun/overview.md → docs/overview.md → README.md` and attaching it is a small,
local change. It pushes in the **same** `catalog-snapshot` object — no new wire
call, no new contract version (additive field).

### 3b. Cloud — a derived `project_overview`, projected on head-advance

New migration, a sibling of `org_catalog_entities`, **derived, never authored**:

```sql
CREATE TABLE state.project_overview (
  org_id            UUID NOT NULL,
  source_project_id UUID NOT NULL,
  name              TEXT,
  description       TEXT,
  namespace         TEXT,
  overview_markdown TEXT,
  docs              JSONB DEFAULT '[]'::jsonb,   -- [{title, path, markdown}]
  source_commit     TEXT,
  head_digest       TEXT NOT NULL,
  synced_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, source_project_id)
);
```

`apps/state-worker/src/catalog-projection.ts` already walks the blob on
`catalog.head.advanced`; it extracts `snapshot.product` and upserts this one row
in the same transaction as the entity upsert. Idempotent and rebuildable from the
blob, identical discipline to the catalog read-model.

### 3c. Workspace identity = a *pointer*, not authored content

A workspace (org) with N repos resolves its hero identity from a **primary
project** — the only authored bit is a pointer, never catalog content:

- Add `primary_project_id UUID NULL` to the org/workspace (an explicit setting;
  default = the most-recently-synced active `workspace_links` project).
- Optional `override_overview JSONB NULL` on the org — the **escape hatch** for a
  workspace with **no repo linked yet**, so the page is never empty. Repo-synced
  wins field-by-field when present; the override is pure fallback.

New read endpoint (resolution happens server-side):

```
GET /v1/organizations/{orgId}/overview
→ { product: project_overview[primary_project_id] ∪ override,   // repo wins per-field
    primaryProject: {...}, repos: [...], syncedAt, source:{repo,commit,head_digest} }
```

The signal tiles keep reading `org_catalog_entities` (org-wide) + the runs feed,
so the page degrades gracefully if no `project_overview` row exists yet.

## 4. Multi-product workspaces

Because identity is **per-project** and the catalog is **merged with provenance**,
a workspace with several unrelated repos is handled without a model change:

- **Default (one product, e.g. lumen):** primary project supplies the hero
  identity + narrative; other linked repos render in the "Repositories" card.
- **Genuinely multi-product:** render each `project_overview` row as a **product
  card**, each linking to its slice of the catalog
  (`?project=<source_project_id>`). No primary needed; the org merge already
  distinguishes them by provenance.

## 5. Why this over the alternatives

| Alternative | Why not |
|-------------|---------|
| Author product identity/overview in the console (CMS) | Breaks the *derived-from-git* invariant `18-state.md` is built on; creates a second source of truth that drifts from the repo. |
| Store identity on `projects.projects` (a new authored column) | Same drift problem, and projects are deliberately thin (name/slug/status); identity belongs to the reviewed `intent.yaml`. |
| A separate "overview push" endpoint | Unnecessary — the snapshot blob already travels the CAS + head path; an additive `product` field rides it for free and stays versioned with the run that produced it. |
| Live git-fetch as the base | Needs repo-read scope, rate limits, private-repo auth; good as a *freshness augment* (WO6), wrong as the foundation. |

The single authored bit in the whole design is `primary_project_id` — a pointer
to *which repo is the product*, which is a genuine workspace decision, not
content. Everything the user sees as "the product" is projected from git.
