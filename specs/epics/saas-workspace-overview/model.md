# saas-workspace-overview — Model (normative, shared across repos)

Status: Draft (normative once WO1 lands). Grounded against `orun`
`internal/catalogmodel/*`, `internal/catalogresolve/*`, `internal/model/intent.go`,
`internal/remotestate/*`, `internal/objremote/*` and orun-cloud
`apps/state-worker/src/{catalog-projection,object-store}.ts`,
`apps/state-worker/src/handlers/objects.ts`, `packages/db/src/migrations/*` as of
2026-07-01. This is the shared contract; the `orun` repo's
`specs/orun-workspace-overview/` references it and owns the CLI half.

Revised 2026-07-01 to adopt `architecture-review.md`: the `Repo` ref is minted
from the durable project id (not an un-normalized remote string), doc bytes are
read at the pinned commit, `Product` is deferred behind the single-per-repo
`Repo` kind, and there is no console-authored `override_overview`. The
architecture review is the rationale record for each of these.

Defines: (1) an `intent.yaml` `docs` convention spanning **every** entity kind,
(2) a new declared kind — **`Repo`**, one per `intent.yaml` — that points at an
overview (with **`Product`** specified but deferred to a later milestone), (3) how
repo-authored docs travel as **content-addressed `doc` objects** in the catalog
snapshot and render **by digest** with no git-provider coupling, and (4) a
**repo-level top layer** (`state.repo_facet`, keyed by project) that drives the
Git Repos list and the Overview identity.

## 0. The decisions this locks

| Decision | Choice |
|----------|--------|
| **How does markdown reach the platform?** | As its **own content-addressed `doc` object** in the catalog snapshot closure. `orun plan` reads each referenced `docs.overview` **at the commit the catalog head is advanced at** and adds it to the object closure (kind `doc`); the entity's `doc_ref` is `{path, ref, sha, digest}`. orun-cloud renders the body from R2 **by digest** — no live git call, works for **any git remote**, self-host-portable, and pinned to that commit. Set-difference sync means an unchanged doc is never re-uploaded. **No GitHub App, no token broker, no render-time provider coupling.** |
| **Why a `doc` object kind and not a plain `blob`?** | The closure already moves `blob`/`tree` objects, so mechanically a doc *could* ride as a blob. `doc` is a distinct kind because repo-authored prose is **user-sized and user-controlled** (a `techdocs` tree can be MBs) and must be **accounted, capped, and GC'd separately** from machine-generated plan/tree internals — it is the quota/retention boundary for `limit.state.storage_gb`, and it lets the console enumerate docs without walking every tree. This costs exactly **one reconciled value** in the `state.objects.kind` CHECK (§4d). |
| **How does repo identity enter the catalog?** | As a **first-class declared kind (`Repo`)** emitted from `intent.yaml`, riding the **existing** snapshot → catalog-head → projector path. `kind` is free-text TEXT server-side (verified: no CHECK on `org_catalog_entities.kind`; the projector stores it as-is), so this needs **no kind-enum migration**. The `Repo` ref is minted from the **durable project id**, not a remote string (§2c). |
| **What about `Product` / multi-product?** | **Deferred to WO6.** In the common single-product workspace the workspace *is* the product; identity is derived from `metadata` + the primary `Repo`. The `Product` kind (namespace-scoped, merges across repos) is fully specified in §7 but ships only when multi-product/multi-repo workspaces are real — the same judgment the epic applies to an explicit primary-project setting. |
| **Does the console ever author overview content?** | **No.** There is no `override_overview`. A not-yet-linked workspace shows the empty-state CTA (`design.md §4`), which is a better first impression than console-typed placeholder prose and keeps `18-state.md`'s *"the console never writes catalog content; derived, never authored, drift-free"* invariant **verbatim**. |

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
   • blob bytes → R2  state/{orgId}/{projectId}/objects/{digest}   (index → state.objects)
   • projector  apps/state-worker/src/catalog-projection.ts  (on catalog.head.advanced)
        walk blob → DELETE-then-UPSERT  state.org_catalog_entities   keyed (org_id, source_project_id, source_environment, entity_ref)
```

Verified facts this model relies on (revalidated 2026-07-01):

- **Base path is per-project**: `/v1/organizations/{orgId}/projects/{projectId}/state`.
  A repo **is** a project; the repo↔project binding is `state.workspace_links`
  (`remote_url` normalized server-side; 1:1 active per `(org, project)` and per
  `(org, remote_url)`), created on first `orun cloud link`. Works for **any git
  remote with no GitHub App** — the invariant this epic preserves.
- **Entity kinds** (`orun/internal/catalogmodel/entity_ref.go`): `Component, API,
  Resource, System, Domain, Group, User, Composition, Environment, Deployment`
  (+ legacy `Owner`→`Group`), validated by the `allEntityKinds` array.
  `System`/`Domain` are **derived** from component `spec.system`/`spec.domain`;
  `Groups`/`Environments`/`Components` are **declared** in `intent.yaml`. There is
  **no** existing "emit a declared top-level entity" path, and adding a kind that
  carries relations also needs graph wiring in `catalogresolve/graph.go`
  `buildGraphs()` — see the CLI plan for the real site list.
- **Docs are already pointers**: `EntityDocs = { techdocs: <path>, runbooks:
  [<path>], adrs: [<path>] }` (`entity_envelope.go`), shared by every kind. No
  inline bodies anywhere today.
- **`CatalogSnapshot.Repo` is an un-normalized passthrough** of
  `ResolverInputs.Repo` (`internal/catalogresolve/catalog_snapshot.go`) — a human
  string like `sourceplane/orun`, **not** the normalized `workspace_links.remote_url`.
  This is why the `Repo` ref is minted from the durable project id, not from it
  (§2c).
- **The cloud projector is kind-agnostic** — no server-side enum;
  `org_catalog_entities.kind` is TEXT with no CHECK; the projector reads `kind`
  from the entity JSON and stores it as-is. Frontend kind styling is a fixed array
  in `web-console-next/src/lib/catalog-kind.ts`
  (`Component|API|Resource|System|Domain|Group` today).
- **CAS is content-addressed and set-difference-synced** (`objremote.Sync`):
  adding blobs to the closure only uploads the ones the backend is missing.
  Single-shot PUT ≤25 MiB, multipart beyond (`internal/remotestate/objsync.go`).
- **`GET …/state/objects/{digest}` already exists** and gates on
  `state.object.read`, 404-ing cross-tenant (`handlers/objects.ts`). The console
  can read a `doc` body by digest today; only the render layer is new.

## 2. The intent spec

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

### 2b. The `Repo` kind (declared, one per `intent.yaml`)

`Repo` is **the self-description of the repo/project you already have** — not a
new parallel concept. It is 1:1 with the `intent.yaml`, 1:1 with the project, and
its projection (`state.repo_facet`, keyed by project) is the identity facet of
that existing repo. The user-facing noun stays **"repo"** (the vocabulary
`saas-unified-onboarding` locks); this kind is what fills it in.

```yaml
# intent.yaml — one new top-level block
metadata: { name: lumen, description: "Multi-tenant SaaS baseline…", namespace: sourceplane }

repo:                                  # singular — self-describes THIS repo → Git Repos list + Overview identity
  displayName: Lumen Platform
  owner: group:platform
  docs: { overview: docs/overview.md }
  links: [ { title: Runbook, url: https://… } ]
  tags: [saas, baseline]
```

CLI change (WO3): add `EntityKindRepo` (constant + `allEntityKinds`); add
`RepoSpec` (`overview` ref, `owner`, `links`, `tags`, derived `members`); add a
top-level `Repo` to `internal/model/intent.go`; **emit** `entities/Repo/*.json`
(a net-new emit path — `System`/`Domain` are derived, so there is nothing to
reuse) and wire any `Repo` relations into `buildGraphs()`. Defaults
`displayName`/`description` from `metadata` when omitted. No new wire call — it
rides the existing `catalog-snapshot` object.

`Product` (namespace-scoped, merges across repos) is specified in §7 and deferred
to WO6.

### 2c. The `Repo` ref — minted from the durable project id

The `Repo` entity ref is **derived from the durable project identity the platform
already trusts as the join key** (`saas-workspace-id`'s `ws_`/project id), not
from `CatalogSnapshot.Repo` (which is an un-normalized display string, §1). This:

- avoids inventing a CLI-side remote-normalization that would have to match the
  server's `workspace_links.remote_url` normalization byte-for-byte and become a
  frozen cross-repo contract;
- is stable across renames and remote-URL changes;
- matches how the projection actually joins — `state.repo_facet` is keyed
  `(org_id, source_project_id)`, and every projected entity already carries
  `source_project_id`, so **the repos list and the identity resolve by project,
  not by the ref string**.

The `path/ref/sha` provenance on `doc_ref` still carries the human remote + commit
for the "view source" link; that is display, not a key.

## 3. Doc bytes — content-addressed objects, read at the pinned commit, rendered by digest

The catalog snapshot is **already a Merkle tree** moved by set-difference sync.
Docs join it as blobs referenced by digest — the native pattern:

```
orun plan  (internal/catalogresolve + objremote.Sync)
   1. resolve each entity's docs.overview → read the file bytes AT THE COMMIT THE
      HEAD IS ADVANCED AT (a git object, not the working tree — §3a)
   2. add each as an object in the closure:  digest = sha256(bytes), kind = doc
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

### 3a. Read at the pinned commit, not the working tree

The resolver reads the **working tree** today (`internal/catalogresolve/*` walks
files from the workspace root; there is no checkout step). On the autopush path
(clean default branch) working-tree == HEAD, so the "pinned to the commit the head
advanced at" claim holds. To make it hold **unconditionally** — including
`plan --push-catalog` on a dirty tree — the CLI MUST, when walking `docs.overview`
into the closure, either read the bytes from the **git object at the resolved
commit**, or **refuse to attach doc objects when the tree is dirty** (the same
gate the autopush path already enforces) and log why. Otherwise the pushed bytes
could reflect uncommitted edits while `doc_ref.{ref,sha}` and the rendered
provenance line ("From `<repo>@<sha>`") point at a commit that never contained
them — silent drift on the one surface whose entire pitch is *drift-free*.

### 3b. Why this is the model, not a live fetch

- **Any git remote, no App.** Honours the explicit `18-state.md` invariant. The
  CLI reads the repo and pushes; GitLab/Gitea/bare-git and the OSS self-host
  backend all work identically. No git-provider coupling exists in this feature.
- **Point-in-time correct.** The doc is pinned to the exact commit the catalog
  head was advanced at (§3a makes this true even on `--push-catalog`).
- **Self-contained & fast.** Rendered from R2 (owned, low-latency); no external
  round-trip, no repo-read scope for private repos.
- **Nearly free on the CLI.** `objremote.Sync` already walks the closure and
  set-diffs; unchanged docs (same digest) are never re-uploaded; content-addressed
  dedup across repos/pushes.

Bounds: push **only the single `docs.overview` file per entity** by default (KB-
scale). A `techdocs: docs/` *tree* is opt-in and size-capped (per-object and
per-closure byte caps; truncation is `log()`-ed, never silent). Doc storage counts
toward `limit.state.storage_gb` **as its own `doc` kind** (§0), so it is
accountable and GC-able independently of plan/tree internals.

Security: repo markdown is rendered through a **sanitizing** pipeline (no raw
HTML, `rel="nofollow ugc noopener"`, no auto-loaded remote images), width-
constrained prose, console type scale.

## 4. State model — a repo top layer + digest pointers

Additive, **derived-never-authored** pieces, projected on `catalog.head.advanced`
alongside the existing entity upsert. No org-level authored columns
(`primary_project_id`/`override_overview`) are introduced at v1 — see §4c.

### 4a. `state.repo_facet` — the repo-level top layer (drives the repos list + identity)

The Git Repos list is driven by `projects.projects` + `workspace_links`. Give it
an O(1) companion projection, **keyed per project** (which sidesteps the ref-
normalization issue entirely — the key is the project, §2c):

```sql
CREATE TABLE state.repo_facet (
  org_id            UUID NOT NULL,
  source_project_id UUID NOT NULL,          -- the project (repo) — the join key
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

Projected from the `Repo` entity in the snapshot. The repos list reads it directly
(description, owner, "has overview" badge); the Workspace Overview identity reads
the **primary repo's** `repo_facet` (§4c).

### 4b. `doc_ref` on any entity — a digest pointer into CAS

`org_catalog_entities` gains a nullable `doc_ref JSONB` projected from each
entity's `docs.overview`: `{path, ref, sha, digest}`. The **digest** is the
content address of the `doc` object (§3); `path/ref/sha` are provenance (the "view
source" link). The body is read from R2 by digest — Postgres holds only the
pointer. `kind` is already TEXT and the projector is kind-agnostic, so `Repo` rows
need **no kind migration**.

### 4c. Workspace identity — resolved, never authored, no override

A workspace (org) with N repos resolves its hero identity from a **primary
project**, computed with **no authored column at v1**:

- **Primary project = the most-recently-synced active `workspace_links` project.**
  This is a pure derivation over existing rows — no `primary_project_id` column is
  added at v1. (An explicit setting is specified in §7 and ships with WO6, when a
  workspace actually has multiple repos and the default is ambiguous.)
- The overview identity = that project's `repo_facet` (`display_name`,
  `description`, `owner`, `doc_ref`) ∪ `metadata`. There is **no
  `override_overview`**: a workspace with no repo linked shows the empty-state CTA
  (`design.md §4`), never console-authored placeholder content.

The Overview is assembled **client-side** from reads the console already makes
(catalog rollup, runs feed, repos list) plus two genuinely new reads (the primary
`repo_facet` and the `doc` body by digest). There is **no bespoke
`GET …/overview` endpoint** at v1 — see §4e. Signal tiles keep reading
`org_catalog_entities` (org-wide) + the runs feed, so the page degrades gracefully
if no overview exists yet.

### 4d. `doc` in the `state.objects.kind` CHECK — reconcile, don't just append

The migration CHECK today allows `plan | catalog-snapshot | composition-lock |
artifact-manifest`, but the write-time validator (`object-store.ts` `OBJECT_KINDS`)
already accepts more (`job-result | log | run-record | blob | tree`) — the schema
already lies about what it stores. WO4's migration adds `doc` **as a
reconciliation**: bring the CHECK in line with the actual `OBJECT_KINDS` set and
add `doc`, so the constraint stops drifting from reality.

### 4e. No `/overview` endpoint at v1 — assemble at the read edge

`GET …/overview` would be a **cross-bounded-context aggregation** (membership org
+ state `repo_facet`/catalog + the runs feed), and `18-state.md` forbids one
worker owning another context's data. So v1 adds **no server endpoint**: the
console assembles the page from the per-context SDK reads it already makes, plus
the primary `repo_facet` read and the doc-by-digest read. If a server-side
resolver is ever wanted for latency, it is defined as an **api-edge composition**
that fans out to those per-context reads — never a state- or membership-worker
route reaching across domains.

## 5. Multi-repo — merge, don't partition

Each repo pushes its own catalog head + snapshot, scoped `(org, project)`. The
org-global catalog is the **merge** in `state.org_catalog_entities`, every row
carrying provenance (`source_project_id, source_environment, source_commit,
head_digest`) — repo/env are **filters, not partitions**. So at v1:

- **Single-repo / single-product workspace (the common case):** the primary
  project's `repo_facet` supplies the hero identity + narrative; other linked
  repos render in the "Repositories" card. No `Product` kind needed.
- **Multi-repo workspace:** the primary-project derivation still yields one
  identity; the other repos are listed. First-class **per-product** cards arrive
  with the `Product` kind in WO6 (§7).

## 6. How every surface is fed

| Surface | Reads | Body |
|---------|-------|------|
| **Git Repos list** | `state.repo_facet` (per project) | none (description inline); overview badge |
| **Repo header/detail** | `repo_facet` + its `doc_ref` | `doc` object from R2 by digest |
| **Workspace Overview hero** | primary project's `repo_facet` (∪ `metadata`) | `doc` object from R2 by digest |
| **Component / System / Domain page** | `org_catalog_entities` row + `doc_ref` | `doc` object from R2 by digest |
| **Signal tiles** | `org_catalog_entities` rollup (org-wide) + runs feed | none |

## 7. Deferred — `Product` and explicit primary selection (WO6)

Specified now so WO3/WO4 don't foreclose it, but **not built at v1**:

- **`Product` kind** — namespace-scoped, ref `product:<namespace>/<name>`, zero or
  more per repo, **merges across repos** by the namespace key (like `System`).
  ```yaml
  products:
    lumen:
      displayName: Lumen
      description: The Lumen SaaS product
      owner: group:platform
      systems: [identity, billing, metering]
      docs: { overview: docs/product/lumen.md }
  ```
  Emits `entities/Product/*.json` with `partOf`/`hasPart` relations to the listed
  systems; projects into `org_catalog_entities`; renders as a product card
  filtered by `?project=<source_project_id>`. When the same product is declared in
  two repos, the primary project's `docs.overview` wins, with a console note on
  conflict (the resolution the risks doc's Q3 lands on).
- **Explicit `primary_project_id UUID NULL`** on the org — replaces the
  most-recently-synced derivation (§4c) only when multi-repo workspaces make the
  default ambiguous.

Both are additive to everything WO2–WO5 ship; nothing here blocks on them.

## 8. Why this is the optimum

- **One convention, every kind** — `docs.overview` extends the struct all kinds
  already share; a `Repo` and a `Component` point at their md the same way (and a
  `Product` will, in WO6).
- **State stays git-derived, and the doc is part of it** — the doc bytes are a
  content-addressed object pinned to the head (§3a), never console-authored; the
  `18-state.md` "derived, never authored, drift-free" invariant holds verbatim
  because there is **no** `override_overview`.
- **The `Repo` ref keys off identity the platform already trusts** — no CLI-side
  remote-normalization contract to freeze and keep in sync.
- **Zero git-provider coupling** — provider-agnostic, self-host-portable, no App,
  no token, no render-time external call; the OSS backend behaves identically.
- **Reuses what's built** — the CAS closure + set-difference sync already ship the
  snapshot; docs ride it as `doc` blobs, accountable against the storage limit.
  Net-new is one reconciled `state.objects.kind` value (`doc`) + `repo_facet` +
  the `doc_ref` column.
- **Ships in the right order** — the landing (WO2) delivers the "front door" from
  orun-cloud alone; the cross-repo narrative chain (WO3–WO5) lands behind a page
  that is already live.

## 9. What deliberately does NOT change

- No new entity beyond `repo_facet` + a `doc_ref` column + the `doc` object kind
  (and, in WO6, the `Product` rows that ride the existing `org_catalog_entities`).
- No console CMS; the console never authors catalog content — **no
  `override_overview`.**
- No change to the catalog/activity read models — the signal row and cards reuse
  them.
- No renaming of `project`/`environment`.
- **No git-provider integration** — this feature never depends on the GitHub App
  or any provider API.
