# saas-catalog-docs — Model (normative, shared across repos)

Status: Draft (normative once CD0 lands). Grounded against `orun`
`internal/catalogmodel/entity_envelope.go`, `internal/catalogresolve/{resolve_full,intent,types}.go`,
`internal/objplan/catalog.go`, `internal/nodes/{assemble,model}.go` and orun-cloud
`apps/state-worker/src/{catalog-projection.ts,handlers/repo-facets.ts}`,
`packages/db/src/migrations/{460_state_repo_facet,570_state_catalog_projection}`
as of 2026-07-05. This is the shared contract; `orun`'s
`specs/orun-catalog-docs/` references it and owns the CLI half.

Defines: (1) the **doc set** — `docs.pages` on the shared docs struct, so every
entity kind carries an ordered set of named, role-tagged documents (with
`overview` remaining the reserved front page), (2) **per-doc commit provenance**
and the pinned-commit read that makes it trustworthy (closing WO review F3/F4),
(3) the **`catalog.entities` enrichment block** that gives *derived* kinds
(System, Domain) a declaration site for metadata + docs without un-deriving
them, (4) the **`state.catalog_docs` projection** — the org-wide doc index the
browsing surface reads, and (5) the read surface (one new single-context list
endpoint; the body read reuses the shipped digest endpoint).

Everything rides the spine `saas-workspace-overview` proved: doc bytes are
content-addressed **`blob`s in the catalog snapshot closure**, set-difference
synced, reachability-GC'd, rendered by digest from R2 with **no git-provider
coupling at render time**. This epic adds **no object kind, no wire call, and
no cross-context endpoint**.

## 0. The decisions this locks

| Decision | Choice |
|----------|--------|
| **How do multiple docs attach to an entity?** | A **`pages` list on the existing shared docs struct** — ordered, each `{path, key?, title?, role?}`. `overview` stays the single reserved front page (a `pages` entry may not use key `overview`). One convention, every kind: `Repo`, `Component`, `API`, `Resource`, `Group`, `Environment` declare it where they already declare `docs`; `System`/`Domain` receive it via enrichment (§3). No per-kind doc schema. |
| **A new object kind for pages?** | **No — pages ride `blob`**, identical to the WO overview. GC is closure-based, the CHECK already admits `blob` (migration `250`), and the WO architecture review's reasoning holds for N docs exactly as for one. No CHECK migration, no CLI↔platform release ordering. |
| **Do the legacy `techdocs`/`runbooks`/`adrs` pointers change?** | **No.** They stay bodyless path pointers, wire-compatible. `pages` is the one way to ship doc **bodies**. A later, separate decision may fold `runbooks`/`adrs` into role-tagged pages; nothing here forecloses it (risks Q2). |
| **How do derived kinds get docs?** | The **`catalog.entities` enrichment block** in `intent.yaml` (§3): metadata + docs keyed `<kind>/<name>`, **merged onto entities the resolver already derives**. Enrichment never *creates* an entity — a target that doesn't materialize is a validation warning. "Derived" stays honest. |
| **Where does the console read the doc list?** | A new **`state.catalog_docs` projection** (one row per doc, per scope — §4) behind `GET /v1/organizations/{org}/catalog/docs`. Single bounded context (state), so no api-edge composition question arises. The **body** read reuses the shipped `GET …/catalog/doc?digest=…`, whose authorization resolve is extended to match `catalog_docs` rows (§5). |
| **Does the console ever author or synthesize docs?** | **Never as files.** Real doc sets replace the fabricated `README.md`/`ARCHITECTURE.md`/… (`lib/catalog-portal/page.ts docsFor()`, WO review F2). A computed summary may render only as a visibly-badged **derived card** — never with a file name, never merged into git-authored content. |
| **Provenance** | Every attached doc records **`commit`** — the commit the catalog head is advanced at — next to `path` and `digest`. Bytes are read **at that commit** (git object) or attachment is refused on a dirty path with a logged warning (§2d). This closes WO review F3/F4 and makes "From `<repo>@<sha>`" true by construction. |
| **Bounds (closes WO Q4)** | Per-doc **256 KiB** (skip + warn above), **≤ 24 pages per entity**, **8 MiB doc budget per closure** (stop attaching + warn). Enforced at resolve time; never fails the plan; never silent. |

## 1. Grounding — what already exists (verified)

- **The attach seam is already generic.** `nodes.Entity.PendingDocs` is
  `map[string][]byte` (doc-key → bytes, `nodes/model.go:141-146`), and
  `assembleEntities` walks *every* key: writes each as a content-addressed blob,
  stamps `Docs[key].digest`, dedups closure entries (`nodes/assemble.go:451-477`).
  Nothing in assembly is overview- or Repo-specific. CD1 is mostly about
  **populating** this seam everywhere, not building it.
- **Only `Repo` populates it today** (`objplan/catalog.go:112-124`); components
  emit bare path strings via `docsBlock()` (`objplan/catalog.go:349-365`) — WO
  review F1.
- **The projector is already docs-aware but single-doc**: `docRefOf()` reads
  `docs.overview` only (`catalog-projection.ts:122`), projecting one `doc_ref`
  per entity (migration `460`).
- **The body read is shipped and tenant-safe**: `handleGetOrgCatalogDoc`
  (`handlers/repo-facets.ts:124`) gates on `catalog.read` and resolves the
  digest **through the org's read model** (`findCatalogDocProject`) before
  touching R2 — a digest not referenced by this org 404s. CD3 extends the
  resolve to `catalog_docs` rows; the endpoint shape is unchanged.
- **The renderer is shipped**: sanitizing pipeline
  (`components/overview/markdown.tsx` — no raw HTML, `rel="noopener nofollow
  ugc"`, no auto-loaded remote images, width-constrained prose).
- **Projection reliability is solved generally**: the `state.catalog_projection`
  outbox + cron sweep (migration `570`) re-projects any lagging scope;
  `catalog_docs` inherits it by being written in the same projection pass.

## 2. The intent surface

### 2a. `docs.pages` — the doc set (every kind)

```yaml
# component.yaml / intent.yaml repo: / catalog.entities enrichment — the same struct everywhere
spec:
  docs:
    overview: docs/overview.md            # existing — the reserved front page
    pages:                                # NEW — ordered additional documents
      - path: docs/architecture.md        # required; repo-relative, forward slashes
        key: architecture                 # optional slug; default = filename stem
        title: Architecture               # optional; default = first `# H1` in the doc, else the filename
        role: architecture                # optional slug; default `guide`
      - { path: ops/runbook.md, role: runbook, title: On-call runbook }
      - { path: docs/api.md, role: reference }
    techdocs: docs/                       # legacy pointers — unchanged, bodyless
    runbooks: [ops/runbook.md]
    adrs: [docs/adr/0001.md]
```

Validation (resolve time, per entity):

- `key` is a slug (`[a-z0-9][a-z0-9-]*`, ≤ 64 chars); `overview` is **reserved**
  (declaring it in `pages` is an error). Keys are unique per entity (error on
  collision, including a collision between two defaulted filename stems — the
  author then names one explicitly).
- `role` is a slug; the well-known set is `guide` (default) · `architecture` ·
  `runbook` · `adr` · `reference` · `changelog` · `faq` · `onboarding`. Unknown
  slugs are **allowed** (free taxonomy, same posture as the kind column) — the
  console styles well-known roles and renders others neutrally.
- Order is declaration order (`position` on the wire). ≤ 24 pages per entity.

### 2b. Wire shape (entity JSON `docs` block)

```json
"docs": {
  "overview": { "path": "docs/overview.md", "commit": "<head-commit-sha>",
                "sha": "<content-sha256>", "digest": "sha256:…" },
  "pages": [
    { "key": "architecture", "title": "Architecture", "role": "architecture",
      "path": "docs/architecture.md", "commit": "<head-commit-sha>",
      "digest": "sha256:…", "size": 18234 }
  ],
  "techdocs": "docs/", "runbooks": ["ops/runbook.md"], "adrs": ["docs/adr/0001.md"]
}
```

- **`commit` is new on both `overview` and pages** — the commit the head is
  advanced at (F3). `sha` (the WO content-sha256) keeps being emitted on
  `overview` for wire compat but is **deprecated**: it duplicates `digest`'s
  guarantee. Pages never carry it.
- A page whose bytes could not be attached (missing file, over cap, dirty path
  — §2d) is emitted **without `digest`** (path pointer only) and the resolve
  logs why. Consumers treat digestless entries as unrenderable declarations.
- `size` is the byte length (drives list-surface display + storage attribution
  without a CAS round-trip).

### 2c. Doc identity

A doc is identified by **`(entity_ref, doc_key)`** — stable across content
changes — while `digest` identifies the **content**. The reader URL uses the
identity (`/orgs/{slug}/docs/{entityKey}/{docKey}`), so links survive edits;
the render always fetches the digest currently projected for that identity.
Two entities (or two pages) declaring byte-identical files share one blob —
content addressing dedups across the whole org, as it already does for the
snapshot.

### 2d. Read at the pinned commit — now enforced (was WO §3a, unimplemented)

When attaching any doc body, the resolver:

1. resolves the commit the head will be advanced at (the same commit recorded
   on the snapshot);
2. reads the bytes **from the git object at that commit** (`git cat-file`-
   equivalent) — not the working tree — when the repo is available;
3. if the path is **dirty or untracked** at that commit (or the repo state
   can't be established), **refuses to attach** — the entry is emitted as a
   path pointer without `digest`, with a logged warning naming the path and
   the reason. The plan never fails over a doc.

On the autopush path the clean-default-branch gate already guarantees
working-tree == HEAD, so the fast path (working-tree read) remains valid there
as an optimization — but the guarantee no longer *depends* on it.

## 3. `catalog.entities` — enrichment for derived kinds

`System` and `Domain` are derived from component `spec.system`/`spec.domain`
strings and today carry nothing else — the catalog renders pages that **cannot
be documented** (WO review F6). The enrichment block gives them a declaration
site without changing how they come to exist:

```yaml
# intent.yaml
catalog:
  namespace: sourceplane
  entities:                        # enrichment only — merged onto derived/declared entities
    domain/identity:
      description: Sign-in, sessions, and workforce identity.
      owner: group:platform
      docs:
        overview: docs/domains/identity.md
        pages:
          - { path: docs/domains/identity-threat-model.md, role: architecture }
    system/billing:
      docs: { overview: docs/systems/billing.md }
```

Rules:

- Keys are `<kind>/<name>`, lowercase kind. Allowed kinds at v1: `system`,
  `domain`, `group`, `environment` (kinds that exist but have thin or no
  declaration surface). Declared kinds (`Component`, `Repo`, `API`, `Resource`)
  keep declaring docs where they live; an enrichment targeting them is a
  validation error (one declaration site per entity).
- **Enrich, never create.** An enrichment whose target entity does not
  materialize from the resolve is a **warning**, not an entity — the derived
  model stays honest (nothing appears in the catalog that no component
  references).
- Merge semantics: enrichment fills empty fields (`description`, `owner`,
  `links`, `tags`) and **owns** `docs` for its target (derived entities have
  none today, so there is no conflict to resolve at v1).
- Cross-repo: enrichment is scoped to the emitting repo's snapshot like every
  other entity field. If two repos enrich the same `domain/identity`, the
  org-global merge resolves exactly as it does for the derived entity rows
  today (per-scope rows with provenance; the org view is a merge with
  provenance-visible precedence). The WO6 `Product` conflict rule ("primary
  project wins, console notes the conflict") is reused when a doc conflict is
  actually observed — risks Q3.

## 4. State model — the org-wide doc index

### 4a. `state.catalog_docs` (new; derived, never authored)

One row per attached doc, per scope. Written in the same delete-then-upsert
projection pass as `org_catalog_entities` (and swept by the same
`catalog_projection` outbox), so it can never diverge from the entity rows:

```sql
CREATE TABLE state.catalog_docs (
  org_id             UUID NOT NULL,
  source_project_id  UUID NOT NULL,
  source_environment TEXT,
  entity_ref         TEXT NOT NULL,          -- e.g. component:sourceplane/ogpic/api-edge
  entity_kind        TEXT NOT NULL,          -- denormalized for kind-filtered browse
  entity_name        TEXT NOT NULL,
  doc_key            TEXT NOT NULL,          -- 'overview' | page key
  title              TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'guide',
  path               TEXT NOT NULL,
  commit_sha         TEXT,
  digest             TEXT NOT NULL,          -- CAS content address (render key)
  size_bytes         INTEGER,
  position           INTEGER NOT NULL DEFAULT 0,
  head_digest        TEXT NOT NULL,
  synced_at          TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX uq_state_catalog_docs_scope
  ON state.catalog_docs (org_id, source_project_id, COALESCE(source_environment, ''), entity_ref, doc_key);
CREATE INDEX ix_state_catalog_docs_browse ON state.catalog_docs (org_id, entity_kind, role);
CREATE INDEX ix_state_catalog_docs_digest ON state.catalog_docs (org_id, digest);
```

Only rows **with a digest** are projected (digestless declarations are visible
on the entity JSON but not browsable — there is nothing to read). Rows are
provenance-carrying like every state projection; repo/env are filters, not
partitions (`model.md` of WO, §5 — unchanged).

### 4b. What existing tables keep doing

- **`org_catalog_entities.doc_ref`** stays: the O(1) overview fast path the
  Workspace Overview and entity heroes already read. The full `docs` block
  also continues to ride the entity JSON, so the projector needs no second
  source.
- **`repo_facet`** unchanged; the repo's page set is `catalog_docs` rows where
  `entity_kind = 'Repo'`.
- **No org-level authored columns.** Nothing in this epic is console-authored.

### 4c. Storage accounting

Doc bytes already count toward `limit.state.storage_gb` as blobs. Per-doc
attribution is now a first-class join (`catalog_docs.size_bytes` /
`catalog_docs.digest → state.objects.size`) — the "how many GB are docs"
question the WO review deferred gets an answer without an object-kind change,
exactly as predicted.

## 5. Read surface

### 5a. `GET /v1/organizations/{org}/catalog/docs` (new; single-context)

Served by state-worker via the existing state-facade — the docs index is
state-owned data, so no api-edge composition is needed. Gate: `catalog.read`
(same as the entity list). Filters: `kind`, `project`, `environment`, `role`,
`entityRef`, `q` (ILIKE over `title`/`path`/`entity_name`); keyset cursor on
`(entity_ref, doc_key)`; ≤ 200/page. SDK: `state.listCatalogDocs(orgId, query)`.

### 5b. Body read — unchanged endpoint, widened resolve

`GET /v1/organizations/{org}/catalog/doc?digest=…` keeps its shape and gate.
`findCatalogDocProject` is extended to also match `state.catalog_docs.digest`
(indexed, §4a) so page bodies resolve exactly like overview bodies: **only a
digest the org's read model references is served.** No new authorization gate
(WO Q6's answer still holds).

### 5c. How every surface is fed

| Surface | List | Body |
|---------|------|------|
| **Docs hub** (`/orgs/{slug}/docs`) | `catalog_docs` (filter kind/role/q) | — |
| **Doc reader** (`/orgs/{slug}/docs/{entityKey}/{docKey}`) | the entity's `catalog_docs` rows (sibling rail) | blob by digest |
| **Entity page Docs tab** | `catalog_docs` where `entity_ref = …` | blob by digest |
| **Workspace Overview docs card** | primary repo's `catalog_docs` rows | — (links into reader) |
| **Overview hero narrative** | `repo_facet.doc_ref` (unchanged) | blob by digest (unchanged) |

Assembly stays at the read edge — pages compose from these per-context reads;
no `/docs-page` aggregate endpoint exists.

## 6. Cross-doc links

Relative markdown links inside a rendered doc resolve **within the entity's doc
set, at the pinned commit**: a link whose repo-relative resolution equals
another attached page's `path` rewrites to that page's reader route; everything
else renders as the existing sanitized external/view-source link. No render-time
git call, no image auto-loading (the WO pipeline's posture is unchanged; asset
blobs are deliberately out of scope — risks Q4).

## 7. Why this is the optimum

- **It is the WO model, finished.** Same closure, same blob kind, same digest
  render, same invariants — extended from `(1 kind × 1 doc)` to
  `(every kind × a bounded set)`, which is what the WO model already claimed to
  be.
- **The attach seam was built generic** (`PendingDocs`); CD1 populates it
  rather than inventing a parallel path.
- **One new table, one new endpoint, zero object-plane change.** The browse
  surface needs an org-wide index; everything else reuses shipped machinery
  (renderer, digest endpoint, projection sweep, sanitizer).
- **Derived kinds stay derived.** Enrichment adds prose to what components
  already prove exists — the catalog never grows console- or intent-authored
  phantom entities.
- **Honesty replaces synthesis.** The one invariant leak in the shipped system
  (fabricated doc files) is closed by giving the surface real content and a
  clearly-badged derived card.

## 8. What deliberately does NOT change

- **No new object kind** — pages are `blob`s in the existing closure.
- **No console-authored docs, ever** — no editor, no override, no CMS.
- **No git-provider coupling at render time** — any remote, self-host-portable.
- **No cross-context endpoint** — the one new route is state-owned.
- **No change to `doc_ref`, `repo_facet`, or the Overview hero** — additive
  throughout; a repo that declares no `pages` behaves exactly as today.
- **Legacy `techdocs`/`runbooks`/`adrs` pointers** — unchanged (Q2 tracks a
  possible later fold-in).
- **No renaming** of `project`/`environment`; no `Product` (still WO6).
