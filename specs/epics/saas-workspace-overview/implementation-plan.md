# saas-workspace-overview — Implementation plan

Status: Draft. Each milestone lists its repo and a concrete **done when**. The
CLI half (WO2a) lands in `sourceplane/orun`; the rest in `sourceplane/orun-cloud`.
Landing order is WO2a → WO2b → (WO3, WO4, WO5). WO3–WO5 can proceed in parallel
once WO2b projects rows.

## WO1 — Design + decision lock (both repos) · 🔵 Proposed

The cross-repo epic (`README.md`, `design.md`, `model.md`, this plan,
`risks-and-open-questions.md`, the mockup) and its `orun` mirror.

**Done when:** both repos carry the epic; the model in `model.md` is agreed; the
`intent.yaml` surface (§2b) and the `doc` object kind are ratified.

## WO2a — CLI: kinds, `docs.overview`, `doc` objects (`sourceplane/orun`)

1. Add `Overview string` to the shared docs structs — `ComponentDocs`,
   `EntityDocs`, `ComponentYAMLDocs` (`internal/catalogmodel/*`).
2. Add `EntityKindRepo`/`EntityKindProduct` to `entity_ref.go` (constants +
   `allEntityKinds`); add `RepoSpec`/`ProductSpec` to `entity_envelope.go`; bump
   `CatalogSummary` (`catalog_snapshot.go`).
3. Add top-level `Repo` + `Products` to `internal/model/intent.go` and resolve
   them into `entities/Repo/*.json` + `entities/Product/*.json` in the snapshot
   writer. `Repo` ref = `repo:<provider>/<owner>/<name>` (one per snapshot);
   `Product` ref = `product:<namespace>/<name>` (merges across repos).
4. During resolution, read each entity's `docs.overview` file bytes at HEAD, add
   the blob to the object closure, and set `docs.overview = {path, ref, sha,
   digest}` on the entity JSON. Bound to the single `overview` file by default; a
   `techdocs` *tree* is opt-in + size-capped.
5. Push path: `objremote.Sync` uploads the doc blobs via the existing set-
   difference sync with header `Orun-Object-Kind: doc`. No new wire call.

**Done when:** `orun catalog push` (or `plan --push-catalog`) on a repo with a
`repo:` block + `docs.overview` uploads the doc blob once (re-push with unchanged
doc is a no-op), the snapshot carries `Repo`/`Product` entities with
`doc_ref.digest`, and `orun catalog list --kind Repo|Product` shows them.

## WO2b — Platform: projection + resolver (`sourceplane/orun-cloud`)

1. Migration: add `'doc'` to the `state.objects.kind` CHECK
   (`packages/db/src/migrations/220_state_foundation` successor); create
   `state.repo_facet` (`model.md §4a`); add `doc_ref JSONB` to
   `state.org_catalog_entities`; add `primary_project_id UUID NULL` (+ optional
   `override_overview JSONB NULL`) to the org.
2. Projector (`apps/state-worker/src/catalog-projection.ts`): on
   `catalog.head.advanced`, project the `Repo` entity → `state.repo_facet`, the
   `Product` entities → `org_catalog_entities`, and each entity's `docs.overview`
   → its `doc_ref` (digest pointer). Idempotent, delete-then-upsert per scope.
3. A read path for the console to fetch a `doc` object body by digest
   (`GET …/state/objects/{digest}` already exists; expose a scoped console read /
   SDK helper).
4. `GET /v1/organizations/{orgId}/overview` — resolve primary project's `Product`/
   `repo_facet` ∪ `override_overview` (repo wins per field) + the repo list;
   contracts in `packages/contracts`.
5. Frontend enum: add `Repo`/`Product` to `web-console-next/src/lib/catalog-kind.ts`.

**Done when:** pushing a snapshot with `Repo`/`Product`/`doc_ref` yields a
`state.repo_facet` row and `doc_ref`s on entities; `GET …/overview` returns the
resolved identity + doc digest; the catalog portal renders the new kinds.

## WO3 — Route + nav (`sourceplane/orun-cloud`)

1. `app/(app)/orgs/[orgSlug]/page.tsx` renders the Overview instead of
   redirecting to `/projects`.
2. `nav-items.ts`: add the **Overview** link (first in the Workspace section);
   update breadcrumbs.

**Done when:** navigating to a workspace lands on the Overview; the sidebar shows
Overview as the home row; deep links to `/orgs/{slug}` resolve to it.

## WO4 — UI (`sourceplane/orun-cloud`)

1. Identity band + signal row (reuse `MetricTiles` + `rollup`).
2. Right-rail cards (reuse `run-rows`/`run-status-icon`; repos from `repo_facet`).
3. Narrative render: fetch the `doc` object by digest → `react-markdown` +
   `remark-gfm` + `rehype-sanitize`; provenance line + "View source".
4. Empty/first-run states (`design.md §4`).

**Done when:** a populated workspace shows identity + tiles + narrative + cards;
an empty workspace shows the link-a-repo CTA; markdown is sanitized.

## WO5 — Git Repos list reads `repo_facet` (`sourceplane/orun-cloud`)

Surface `display_name`/`description`/`owner` and an "has overview" badge per repo
in `app/(app)/orgs/[orgSlug]/projects/page.tsx`, read from `state.repo_facet`.

**Done when:** the Git Repos list shows a description + overview badge per linked
repo that has published a `Repo` entity.

## Rollout / back-compat

- Additive throughout: repos without a `repo:`/`products:` block or `docs.overview`
  simply have no `repo_facet`/`doc_ref`; the Overview falls back to the override
  or the empty-state CTA. No breaking change to the state contract (the `doc` kind
  and `doc_ref` are additive).
- The Overview replacing the `/projects` redirect (WO3) is the only user-visible
  navigation change; the old `/projects` route is unchanged and still linked.
