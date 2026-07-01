# saas-workspace-overview — Design (UX / IA)

Status: Draft (normative once WO1 lands)

The information architecture and section layout for the Workspace **Overview** —
the page that becomes the Workspace landing. The **data/wire model** (how docs
travel, the kinds, the state tables) is normative in `model.md`; this doc covers
the surface. Written against repo reality as of 2026-06-30: a Workspace is an
`organizations` row (`saas-workspaces`); `/orgs/{slug}` currently `redirect()`s
to `/projects`; the sidebar Workspace section is `Catalog · Activities · Git
Repos · Integrations` (`components/shell/nav-items.ts`); the catalog ships a
`rollup` + `MetricTiles` (`saas-catalog-portal`); the runs feed renders via
`components/activity/*`.

## 1. Where it lives

The Overview **is** the Workspace landing. Two changes:

- `app/(app)/orgs/[orgSlug]/page.tsx` stops redirecting to `/projects` and
  renders the Overview. (`/orgs/{slug}/overview` may exist as a canonical alias,
  but the bare org root is the page — the shortest, most-linked URL should be the
  answer to "what is this Workspace", not a repo list.)
- `nav-items.ts` gains an **Overview** link as the first entry in the Workspace
  section, above Catalog (icon `LayoutDashboard`). It is the rail's home row.

Nothing else in the nav model moves; the "Manage" footer (Usage, Settings) is
untouched.

> **Ships in two passes** (`implementation-plan.md`): **WO2 (Phase 1)** stands the
> page up from orun-cloud alone — the route flip, identity band, signal row,
> right-rail, and empty states, all from data the platform already has. **WO5
> (Phase 2)** lights up the git-authored narrative band once the CLI (WO3) and
> projection (WO4) land. The layout below is the fully-populated end state; §4
> notes what each pass renders.

## 2. What feeds the page (summary — see `model.md` for the normative model)

Identity and narrative are **git-authored and carried in the catalog snapshot**,
never typed into the console. The console **never authors** overview content —
there is **no `override_overview`** and **no `/overview` endpoint** (the page is
assembled at the read edge from per-context reads — `model.md §4c/§4e`).
Resolution for the hero, most-authoritative first:

1. **Primary `Repo`.** The primary project (the most-recently-synced active
   `workspace_links` project — no authored `primary_project_id` at v1) supplies
   its `repo_facet` identity: name, description, owner, and the `docs.overview`
   pointer, unioned with `intent.yaml metadata`. (A first-class `Product` hero is
   deferred to WO6; until then the workspace *is* the product.)
2. **Narrative.** The `docs.overview` blob, read from R2 **by digest** and
   rendered sanitized. Pinned docs (extra `docs`) render as a small list.
3. **No repo linked yet → the empty-state CTA** (§4), never console-typed
   placeholder prose. This keeps the "console never authors catalog" invariant
   verbatim and is a better first impression than a blank textbox.

There is **no render-time git-provider call** — the body is always the pinned
doc blob (`model.md §3`).

### Rendering & security

No markdown renderer exists in the console today (`grep react-markdown` → none).
Add `react-markdown` + `remark-gfm` + `rehype-sanitize`. Repo markdown is
untrusted-ish (anyone who can PR the repo can edit it), so the pipeline:

- disallows raw embedded HTML (sanitized via `rehype-sanitize`),
- forces `rel="noopener nofollow ugc"` + `target="_blank"` on links,
- does not auto-load remote images by default,
- renders inside a width-constrained prose container with the console's type
  scale (no author-controlled fonts/colors).

## 3. Layout (section by section)

A single scrollable page, max-width prose, on the warm `--background` with the
existing faint grid. Three bands:

### Band 1 — Identity

- **Breadcrumb:** `<Account> › <Workspace>` (uses the WS vocabulary).
- **Product name** as the H1, a **namespace** chip, and the one-line
  **description** beneath.
- Quick facts row: maturity summary chip, component count, environments count,
  primary repo link.
- **Primary actions** (contextual): `Open catalog` · `View activity` ·
  (empty-state) `Link a repository`.
- May use the existing primary radial-gradient accent for the band background.

### Band 2 — Signal row (metric tiles)

Four tiles that read as one product with the catalog. The shipped `MetricTiles`
(`components/catalog/portal/metric-tiles.tsx`) renders
Services/Ownership/Production-ready/Needs-attention, so the first three below
**reuse its tokens/components** while the **Activity** tile is a **new
composition** over the runs feed (it is not in `MetricTiles`) — WO2 is "reuse 3 +
compose 1", not a drop-in:

| Tile | Value | Source |
|------|-------|--------|
| **Components** | catalog total (`rollup.total`), "across N systems" | catalog `rollup` |
| **Health** | % healthy / needs-attention count | `healthOf` + `needsAttention` over the catalog |
| **Production-ready** | `rollup.readyPct` with a Gold/Silver/Bronze mini-bar | catalog `rollup` + `tierOf` |
| **Activity** | runs last 7d + success rate + last-run status icon | runs feed (composed tile) |

### Band 3 — Two-column body

- **Left (~2/3): Product narrative.** The rendered `docs.overview` doc. A
  provenance line — `From <repo>@<short-sha> · <relative time>` — and a
  **"View source"** link to the file at that commit (a plain hyperlink, not an
  integration). When the platform knows the latest linked commit (push events /
  `workspace_links.last_seen_at`), the line also shows **"N commits behind
  `<default-branch>`"** so staleness is *actionable*, not just visible — the doc
  self-heals on the next `orun plan`. An optional auto-built table of contents for
  long docs.
- **Right rail (~1/3): live summaries**, stacked cards, each a link into its
  full surface:
  - **Components at a glance** — needs-attention list / top systems → Catalog.
  - **Recent activity** — last ~5 runs (reuse `run-rows` + `run-status-icon`) →
    Activities.
  - **Repositories** — linked projects (from `state.repo_facet`) with description
    + last-run → Git Repos.
  - **Pinned docs / Important information** — the extra `docs` blocks.

## 4. Empty & first-run states (a landing page lives or dies here)

| State | What the Overview shows |
|-------|--------------------------|
| **No repo linked** | A centered CTA: *"Link a repository to bring this Workspace to life."* + a one-paragraph explanation of the repo-is-homepage model and a `Link a repository` action (`orun cloud link`). This is the whole "never blank" story — there is no console-authored override header. (This state is also the post-onboarding destination for `saas-unified-onboarding`.) |
| **Repo linked, no plan yet** | Identity from `intent.yaml` renders; signal tiles read "—"; a hint: *"Run `orun plan` to populate your catalog and overview."* with a copy-paste command. |
| **Repo + plan, but no `docs.overview`** | Render the declared `description` as the narrative and a gentle nudge: *"Add a `docs/overview.md` and point `docs.overview` at it to tell your team what this product is,"* with a copy-paste `intent.yaml` snippet. |
| **Fully populated** | The full three-band layout above. |

## 5. Data contract

Normative in `model.md §4` — `state.repo_facet` (keyed by project) and the
`doc_ref` (`{path, ref, sha, digest}`) column. Docs ride the existing `blob`
object kind, so there is **no object-kind migration**. There is **no
`primary_project_id`/`override_overview`** column and **no `GET …/overview`
endpoint** at v1: the primary project is *derived* (most-recently-synced link),
and the Overview is **assembled client-side** from the reads the console already
makes (catalog rollup, runs, repos) plus the primary `repo_facet` read and the
doc-by-digest read (`GET …/state/objects/{digest}`, already gated
`state.object.read`). The signal tiles keep reading the catalog + runs endpoints
they already use, so the page degrades gracefully if no overview exists yet.

## 6. What deliberately does NOT change

- **No new entity** beyond `repo_facet` + a `doc_ref` column, and **no new object
  kind** — docs ride the existing `blob` closure (and, in WO6, the deferred
  `Product` rows on the existing table).
- **No console CMS and no console-authored overview.** The narrative is
  repo-authored; a not-yet-linked workspace shows the empty-state CTA, not an
  editable field — there is no `override_overview`.
- **No cross-context `/overview` endpoint** — the page is composed at the read
  edge.
- **No change to the catalog or activity models** — the signal row and cards
  reuse `saas-catalog-portal` and the runs feed; they read, they do not fork.
- **No git-provider coupling** — the page never calls a provider API at render.
- **No renaming of `project`/`environment`.**
