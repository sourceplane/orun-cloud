# saas-workspace-overview — Implementation plan

Status: Draft (revised 2026-07-01 to adopt `architecture-review.md`). Each
milestone lists its repo and a concrete **done when**.

**Delivery is phased so the front door ships before the cross-repo chain:**

- **Phase 1 — the landing (orun-cloud only, no CLI release, no new object kind).**
  Two of the page's three bands read data the platform already has. Ship them now:
  flip `/orgs/{slug}` from a redirect to a real Overview, with the signal row, the
  right-rail summaries, and the empty/first-run states. This delivers the epic's
  actual thesis — *a Workspace finally has a home* — immediately.
- **Phase 2 — the git-authored narrative (cross-repo).** Land the CLI half (WO3),
  then the projection (WO4), then the narrative render + repo-facet surfaces (WO5)
  **behind the page that is already live**. A slip here never holds the landing
  hostage.
- **Phase 3 — deferred.** `Product` + explicit primary-project selection (WO6),
  only when multi-product/multi-repo workspaces are real.

Landing order: **WO2 → WO3 → WO4 → WO5**; WO6 is independent and later. WO3 (CLI)
and WO4 (platform) need **no object-kind coordination**: docs ride the existing
`blob` kind (legal since migration `250_state_refs`), so WO3 can push before WO4
projects — unreferenced doc blobs are inert until then.

---

## WO1 — Design + decision lock (both repos) · 🔵 Proposed

The cross-repo epic (`README.md`, `design.md`, `model.md`, this plan,
`risks-and-open-questions.md`, `architecture-review.md`, the mockup) and its
`orun` mirror.

**Done when:** both repos carry the epic; `model.md` is agreed; the `intent.yaml`
surface (`model.md §2`), the `Repo`-ref-from-project-id decision, and the `doc`
object kind are ratified.

---

## Phase 1

### WO2 — The Overview landing (`sourceplane/orun-cloud`) · Phase 1

No CLI dependency, no new object kind, no migration. Reuses shipped data.

1. **Route:** `app/(app)/orgs/[orgSlug]/page.tsx` renders the Overview instead of
   `redirect()`-ing to `/projects`. (`/projects` stays reachable and linked.)
2. **Nav:** `components/shell/nav-items.ts` gains an **Overview** link as the first
   Workspace-section entry (icon `LayoutDashboard`); update breadcrumbs.
3. **Identity band (v1 form):** product name (`metadata.name` via the org),
   namespace chip, description, quick-facts row (component count, environments,
   primary repo link), contextual primary actions.
4. **Signal row:** reuse the catalog `rollup()` + `MetricTiles`
   (`components/catalog/portal/*`) for Components / Health / Production-ready;
   **compose** the fourth **Activity** tile from the runs feed (runs last 7d +
   success rate + last-run status icon) — `MetricTiles` does not include it, so
   this tile is new composition over reused tokens.
5. **Right rail:** Components-at-a-glance (needs-attention/top systems → Catalog),
   Recent activity (reuse `components/activity/{run-rows,run-status-icon}` →
   Activities), Repositories (linked projects from `projects` + `workspace_links`
   → Git Repos).
6. **Empty/first-run states** (`design.md §4`): no-repo-linked CTA, repo-linked-no-
   plan hint, plan-but-no-overview nudge. These are the entire "never blank"
   story — there is no console-authored override.

**Done when:** navigating to a workspace lands on the Overview (not `/projects`);
the sidebar shows Overview as the home row; a populated workspace shows identity +
tiles + right-rail; a brand-new workspace shows the link-a-repo CTA. All from
existing endpoints — no snapshot, projection, or CLI change.

---

## Phase 2

### WO3 — CLI: `Repo` kind, `docs.overview`, doc blobs (`sourceplane/orun`)

See the `orun` repo's `specs/orun-workspace-overview/implementation-plan.md` for
the step-by-step; summary of the platform-relevant output:

1. `Overview string` on the shared docs structs (`ComponentDocs`/`EntityDocs`/
   `ComponentYAMLDocs`).
2. `EntityKindRepo` (constant + `allEntityKinds`) + `RepoSpec`; top-level `Repo`
   in `internal/model/intent.go`; **emit** `entities/Repo/*.json`; wire relations
   into `catalogresolve/graph.go buildGraphs()`. **`Repo` ref = repo-local
   `<namespace>/<repo>/<name>`** (`model.md §2c`; no cloud project id at resolve
   time), not `CatalogSnapshot.Repo`.
3. Walk each entity's `docs.overview` into the closure as a content-addressed
   **blob**, reading bytes **at the pinned commit** (or refusing on a dirty tree)
   — `model.md §3a`; set `doc_ref = {path, ref, sha, digest}` on the entity JSON.
4. `objremote.Sync` uploads doc blobs via the existing set-difference sync with
   header `Orun-Object-Kind: blob`. No new wire call, **no new object kind**.
   `Product`/`products` are **deferred to WO6**.

**Done when:** `orun catalog push` on a repo with a `repo:` block + `docs.overview`
uploads the doc blob once (unchanged re-push is a no-op), the snapshot carries a
`Repo` entity with `doc_ref.digest`, and `orun catalog list --kind Repo` shows it.

### WO4 — Platform: projection (`sourceplane/orun-cloud`) · no `/overview` endpoint

1. **Migration:** create `state.repo_facet` (`model.md §4a`, keyed `(org_id,
   source_project_id)`); add `doc_ref JSONB` to `state.org_catalog_entities`.
   **No `state.objects.kind` change** — docs ride the existing `blob` kind (legal
   since migration `250_state_refs`; `model.md §4d`). **No** `primary_project_id` /
   `override_overview` columns (deferred / dropped — `model.md §4c`, §7).
2. **Projector** (`apps/state-worker/src/catalog-projection.ts`): on
   `catalog.head.advanced`, project the `Repo` entity → `state.repo_facet`, and
   each entity's `docs.overview` → its `doc_ref` (digest pointer). Idempotent,
   delete-then-upsert per scope, keyed by `source_project_id`.
3. **Console doc read:** expose a scoped console read / SDK helper over the
   existing `GET …/state/objects/{digest}` (already gated `state.object.read`) so
   the console can fetch a `doc` body by digest. No new authorization gate
   (`catalog.read`/`state.object.read` suffice — risks Q6, closed).
4. **Frontend enum:** add `Repo` to `web-console-next/src/lib/catalog-kind.ts`.

**Done when:** pushing a snapshot with a `Repo` entity + `doc_ref` yields a
`state.repo_facet` row and `doc_ref`s on entities; the console can read the doc
body by digest; the catalog portal renders the `Repo` kind. No cross-context
endpoint was added.

### WO5 — Narrative render + repo-facet surfaces (`sourceplane/orun-cloud`)

1. **Overview identity (upgrade WO2's band):** resolve the primary project
   (most-recently-synced active `workspace_links` project — `model.md §4c`) and
   render its `repo_facet` identity ∪ `metadata`. Assembled **client-side** from
   the `repo_facet` read + the reads WO2 already makes; **no bespoke `/overview`
   endpoint** (`model.md §4e`).
2. **Narrative band:** fetch the doc blob by digest → render with
   `react-markdown` + `remark-gfm` + `rehype-sanitize` (new deps; none exist
   today). Sanitizing pipeline per `design.md §2`: no raw HTML, `rel="noopener
   nofollow ugc"`, no auto-loaded remote images, width-constrained prose.
3. **Provenance + staleness:** "From `<repo>@<short-sha>` · <relative time>" +
   "View source" link; when the platform knows the latest linked commit (push
   events / `workspace_links.last_seen_at`), surface "overview is N commits behind
   `<default-branch>`" so staleness is actionable, not just visible.
4. **Git Repos list + repo header** read `state.repo_facet` (`display_name`,
   `description`, `owner`, "has overview" badge) in
   `app/(app)/orgs/[orgSlug]/projects/page.tsx` and the repo detail header.

**Done when:** a populated workspace shows the git-authored narrative with
provenance + staleness; the Git Repos list shows a description + overview badge per
linked repo that published a `Repo` entity; markdown is sanitized; the not-yet-
populated workspace still shows WO2's empty states.

---

## Phase 3 (deferred)

### WO6 — `Product` kind + explicit primary selection (both repos) · later

Only when multi-product/multi-repo workspaces are real. `model.md §7`:

- CLI: `products` block + `EntityKindProduct` + `ProductSpec`; emit
  `entities/Product/*.json` with `partOf`/`hasPart` to listed systems.
- Platform: project `Product` → `org_catalog_entities`; add `primary_project_id
  UUID NULL` on the org to replace the derived primary; product cards filtered by
  `?project=<source_project_id>`; resolve which-doc-wins on a cross-repo product
  (primary project's, with a conflict note — risks Q3).
- Frontend: add `Product` to `lib/catalog-kind.ts`.

**Done when:** a workspace declaring two products renders a card per product with
the right narrative; a product spanning two repos merges and resolves its overview
deterministically.

---

## Rollout / back-compat

- **Phase 1 is a pure console change** — the only user-visible navigation change
  (Overview replacing the `/projects` redirect) lands here; `/projects` is
  unchanged and still linked.
- **Phase 2 is additive throughout:** repos without a `repo:` block or
  `docs.overview` simply have no `repo_facet`/`doc_ref`; the Overview falls back to
  WO2's identity + empty states. Doc blobs and `doc_ref` are additive to the state
  contract; an older orun-cloud already accepts `blob` objects and simply ignores
  unreferenced ones until WO4 projects them.
- **No object-kind coordination:** docs ride the existing `blob` kind, so there is
  no CHECK migration and no CLI↔platform release ordering — WO3 can push doc blobs
  before WO4 lands. (The doc push still rides the normal publish path — clean
  default branch, best-effort — so it never fails a plan.)
