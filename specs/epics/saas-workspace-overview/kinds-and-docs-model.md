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
| **Where does markdown live in the platform?** | **Nowhere durable.** State stores a **doc reference** `{repo, path, ref, lastSeenSha}`; orun-cloud **fetches the body live** from the repo through the GitHub App at render time, with a short-TTL cache invalidated by `scm.push`. (Supersedes the earlier "project `narrativeMarkdown` into `project_overview`" idea.) |
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
  doc_ref           JSONB,                   -- {path, ref, lastSeenSha}  ← POINTER, not body
  head_digest       TEXT NOT NULL,
  source_commit     TEXT,
  synced_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, source_project_id)
);
```

Projected from the `Repo` entity in the snapshot. The repos list reads it
directly (description, owner, "has overview" badge); the Workspace Overview reads
the `Product` entity (or the primary repo's `repo_facet`).

### 3b. `doc_ref` on any entity — the pointer the fetch layer resolves

`org_catalog_entities` gains a nullable `doc_ref JSONB` projected from each
entity's `docs.overview` (path + resolved branch/ref + the commit sha the head
was advanced at). No markdown bytes land in Postgres or R2. The `Repo` facet
carries its own `doc_ref` (3a); components/systems/products carry theirs on their
`org_catalog_entities` row.

> `kind` is already TEXT and the projector is kind-agnostic, so `Repo`/`Product`
> rows need **no schema change**; only `repo_facet` + the `doc_ref` column are new.

## 4. Render-time fetch via the GitHub integration

The body is fetched live, on demand, when a surface renders an overview:

```
console renders Repo/Product/Component overview
   │  GET /v1/organizations/{orgId}/projects/{projectId}/repo/doc?entityRef=…   (new)
   ▼
integrations-worker  (new handler repo-content.ts)
   1. resolve doc_ref (path, ref) for the entity  ← from repo_facet / org_catalog_entities
   2. find the integrations.repo_links row for source_project_id
        └─ NONE (only a CLI workspace_link, no App)  →  422 needs_github_connection  (graceful fallback)
   3. token-broker: mint short-lived token, repos:[repo_external_id], contents:read   (⊆ App grant; never cached raw)
   4. github-app.getRepositoryFileContents(token, owner/repo, path, ref)   ← NEW: GET /repos/{owner}/{repo}/contents/{path}?ref=
   5. cache body in integrations.repo_content_cache  (AES-GCM, key (connection, repo, path, sha), short TTL)
   ▼
sanitize (rehype-sanitize) → render
```

- **Cache & freshness.** Reuse the `installation_tokens` AES-GCM pattern for a
  `repo_content_cache` table (or Cloudflare Cache API). The integration **already
  receives `scm.push` webhooks** — on a push to the doc's branch, bump
  `repo_facet.doc_ref.lastSeenSha` and evict the cache. So the overview is as
  fresh as the last push, with zero polling.
- **Access = the GitHub App.** Live fetch requires the repo linked via the App
  (`repo_links`). If only a CLI `workspace_link` exists, the pointer still shows
  (path + "connect GitHub to preview"), and the header degrades to the
  git-declared `metadata.description` already carried on `repo_facet`. This makes
  "connect GitHub" a concrete, motivated upsell on the Overview/repos surfaces.
- **Security.** Untrusted repo markdown → sanitizing pipeline (no raw HTML,
  `rel="nofollow ugc noopener"`, no auto-loaded remote images). Tokens are
  minted per-request, scoped to the one repo, `contents:read` only, never logged.

## 5. How every surface is fed

| Surface | Reads | Body |
|---------|-------|------|
| **Git Repos list** | `state.repo_facet` (per project) | none (description inline); overview badge |
| **Repo header/detail** | `repo_facet` + its `doc_ref` | live-fetched `docs/overview.md` |
| **Workspace Overview hero** | `Product` entity (primary) / primary `repo_facet` | live-fetched product `overview.md` |
| **Component / System / Domain page** | `org_catalog_entities` row + `doc_ref` | live-fetched `docs.overview` |
| **Signal tiles** | `org_catalog_entities` rollup (org-wide) + runs feed | none |

## 6. Why this is the optimum

- **One convention, every kind.** `docs.overview` extends the struct all kinds
  already share — no per-kind special-casing; a `Repo`, a `Product`, and a
  `Component` all point at their md the same way.
- **Repo vs Product scoping is principled**, not ad-hoc — it reuses the proven
  "repo is a segment / systems merge across repos" distinction, so a product that
  spans repos just *works* via the org-wide merge, and a repo stays one-per-project.
- **State remains a pure git-derived projection** — pointers + facets, never
  prose. The `18-state.md` "derived, never authored, drift-free" invariant holds
  verbatim; nothing in the console authors catalog content.
- **Fetch-live reuses what's built** — App JWT, scoped token-broker, `repo_links`,
  push webhooks. The only net-new code is `getRepositoryFileContents`, one
  handler, and a cache table. No kind enum migration.
- **Freshness for free** — push webhooks evict the cache; the overview tracks the
  repo without a plan re-run or a polling loop.
- **A built-in upsell** — surfaces that need the body make "connect GitHub" a
  concrete, in-context action, while never being empty (they fall back to the
  git-declared description already projected).

## 7. Milestone deltas (folds into the README)

| ID | Milestone |
|----|-----------|
| WO2a | `orun`: add `docs.overview` to the shared docs struct; add declared `repo` + `products` blocks; emit `Repo`/`Product` entities + `doc_ref`s into the snapshot |
| WO2b | orun-cloud projector: project `Repo`→`state.repo_facet`, `Product`→`org_catalog_entities`, and `doc_ref` (pointer only) on entities; add `Repo`/`Product` to `catalog-kind.ts` |
| WO2c | integrations-worker: `getRepositoryFileContents` + `repo-content.ts` handler over the token-broker; `repo_content_cache`; `scm.push` cache-eviction |
| WO3 | Git Repos list reads `repo_facet`; repo header renders the live overview; Workspace Overview hero renders the `Product`/primary-repo overview |
| WO4 | Empty/fallback states (no App link → description + "connect GitHub"); sanitizing markdown pipeline |
