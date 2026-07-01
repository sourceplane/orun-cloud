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

## 2. What feeds the page (summary — see `model.md` for the normative model)

Identity and narrative are **git-authored and carried in the catalog snapshot**,
never typed into the console. Resolution for the hero, most-authoritative first:

1. **Primary `Product` / `Repo`.** The workspace's `primary_project_id` selects a
   project; its declared `Product` (or the project's `Repo` facet) supplies name,
   description, namespace, and the `docs.overview` pointer.
2. **Narrative.** The `docs.overview` `doc` object, read from R2 **by digest** and
   rendered sanitized. Pinned docs (extra `docs`) render as a small list.
3. **Console override (escape hatch only).** For a workspace with no repo linked
   yet, an admin may set name/description on the org so the page is never empty;
   repo-authored content wins field-by-field when present.

There is **no render-time git-provider call** — the body is always the pinned
`doc` object (`model.md §3`).

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

Four tiles, visually identical to the catalog's `MetricTiles` (reuse the
component / its tokens) so the surfaces feel like one product:

| Tile | Value | Source |
|------|-------|--------|
| **Components** | catalog total (`rollup.total`), "across N systems" | catalog `rollup` |
| **Health** | % healthy / needs-attention count | `healthOf` + `needsAttention` over the catalog |
| **Production-ready** | `rollup.readyPct` with a Gold/Silver/Bronze mini-bar | catalog `rollup` + `tierOf` |
| **Activity** | runs last 7d + success rate + last-run status icon | runs feed |

### Band 3 — Two-column body

- **Left (~2/3): Product narrative.** The rendered `docs.overview` doc. A
  provenance line — `From <repo>@<short-sha> · <relative time>` — and a
  **"View source"** link to the file at that commit (a plain hyperlink, not an
  integration). An optional auto-built table of contents for long docs.
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
| **No repo linked** | A centered CTA: *"Link a repository to bring this Workspace to life."* + a one-paragraph explanation of the repo-is-homepage model and a `Link a repository` action (`orun cloud link`). The console-override identity (if set) still renders as the header. |
| **Repo linked, no plan yet** | Identity from `intent.yaml` renders; signal tiles read "—"; a hint: *"Run `orun plan` to populate your catalog and overview."* with a copy-paste command. |
| **Repo + plan, but no `docs.overview`** | Render the declared `description` as the narrative and a gentle nudge: *"Add a `docs/overview.md` and point `docs.overview` at it to tell your team what this product is,"* with a copy-paste `intent.yaml` snippet. |
| **Fully populated** | The full three-band layout above. |

## 5. Data contract

Normative in `model.md §4` — `state.repo_facet`, the `doc_ref` (`{path, ref, sha,
digest}`) column, the `doc` object kind, `primary_project_id` (+ optional
`override_overview`) on the org, and `GET /v1/organizations/{orgId}/overview`. The
console reads the resolver through the existing SDK session client; the signal
tiles keep reading the catalog + runs endpoints they already use, so the page
degrades gracefully if no overview exists yet.

## 6. What deliberately does NOT change

- **No new entity** beyond `repo_facet` + a `doc_ref` column + the `doc` object
  kind.
- **No console CMS.** The narrative is repo-authored; the override is only the
  not-yet-linked escape hatch.
- **No change to the catalog or activity models** — the signal row and cards
  reuse `saas-catalog-portal` and the runs feed; they read, they do not fork.
- **No git-provider coupling** — the page never calls a provider API at render.
- **No renaming of `project`/`environment`.**
