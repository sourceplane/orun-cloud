# saas-workspace-overview — Design

Status: Draft (normative once WO1 lands)

The information architecture, the markdown-sourcing model, and the section
layout for the Workspace **Overview** — the page that becomes the Workspace
landing. Written against repo reality as of 2026-06-30: a Workspace is an
`organizations` row (`saas-workspaces`); `/orgs/{slug}` currently
`redirect()`s to `/projects`; the sidebar Workspace section is
`Catalog · Activities · Git Repos · Integrations` (`components/shell/nav-items.ts`);
the catalog already ships a `rollup` + `MetricTiles` (`saas-catalog-portal`); the
org Activities feed renders runs via `components/activity/*`.

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

## 2. The markdown-sourcing model — "the repo is the homepage"

A Workspace can have many repos (projects), but its **product identity** is the
Workspace's. Resolution is layered, most-authoritative first:

1. **Primary repo.** A Workspace designates a *primary* project (explicit
   setting; default = the most-recently-synced repo whose `intent.yaml`
   `execution.state.{workspace|org}` resolves to this Workspace). Its
   `intent.yaml` `metadata.{name, description, namespace}` is the structured
   identity.
2. **Narrative markdown.** The first existing of `./.orun/overview.md` →
   `./docs/overview.md` → `./README.md` in the primary repo. This is the
   "what is this product" centerpiece — the md file the user asked for.
3. **Pinned docs (optional).** Additional docs declared in intent, e.g.
   `overview.docs: [{ title, path }]` — runbooks, "important information",
   onboarding. Rendered as a small list of links / expandables in the right rail.
4. **Console override (escape hatch).** A Workspace admin may set a name +
   description + narrative directly on the org for the case where **no repo is
   connected yet** (a freshly created Workspace) — so the Overview is never an
   empty void. Repo-sourced content always wins when present; the override is a
   fallback, surfaced with a "set in console" provenance note.

### How the markdown gets to the console

Two paths; **(A) is the source of truth**, (B) is an optional later augment.

| Path | Mechanism | Verdict |
|------|-----------|---------|
| **(A) Synced at plan time** | `orun plan`/`run` already pushes the resolved catalog to orun-cloud (see lumen `intent.yaml` `pushCatalog`). Extend that payload to carry the resolved identity + rendered narrative + provenance (`sourceRepo`, `sourceSha`, `syncedAt`). | **Chosen.** Orun-native, works for private repos without the console holding git read scope, deterministic, and versioned with the run that produced it — exactly how the catalog already arrives. Refreshes on the next plan. |
| (B) Live git fetch | Read the doc on demand through the GitHub integration (`saas-integration-tenancy`). | **Optional (WO6).** Always-fresh, but needs repo-read scope, rate-limit handling, and private-repo auth. Use to augment "last synced N days ago", not as the base. |

This mirrors `saas-workspaces`' **relabel/relayer, don't remodel** discipline:
the Overview is a **projection** over data the platform already holds, plus one
small additive synced field and one optional override column — **no new entity.**

### Rendering & security

No markdown renderer exists in the console today (`grep` for `react-markdown`
returns nothing). WO5 adds `react-markdown` + `remark-gfm` + `rehype-sanitize`.
Repo markdown is **untrusted-ish** — anyone who can open a PR to the repo can
edit it — so the pipeline:

- disallows raw embedded HTML (or sanitizes it via `rehype-sanitize`),
- forces `rel="noopener nofollow ugc"` + `target="_blank"` on links,
- does not auto-load remote images by default (or proxies them),
- renders inside a width-constrained prose container with the console's type
  scale (no author-controlled fonts/colors).

## 3. Layout (section by section)

A single scrollable page, max-width prose, on the warm `--background` with the
existing faint grid. Three bands:

### Band 1 — Identity

- **Breadcrumb:** `<Account> › <Workspace>` (uses the WS vocabulary).
- **Product name** (`metadata.name`) as the H1, a **namespace** chip, and the
  one-line **description** beneath.
- Quick facts row: maturity summary chip, environments count, primary repo link.
- **Primary actions** (contextual): `Open catalog` · `View activity` ·
  (empty-state) `Connect a repository`.
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

- **Left (~2/3): Product narrative.** The rendered `overview.md`/README. A
  provenance line — `Synced from <repo>@<short-sha> · <relative time>` — and an
  **"Edit on GitHub"** / **"View source"** link, reinforcing repo-is-truth. An
  optional auto-built table of contents for long docs.
- **Right rail (~1/3): live summaries**, stacked cards, each a link into its
  full surface:
  - **Components at a glance** — needs-attention list / top systems → Catalog.
  - **Recent activity** — last ~5 runs (reuse `run-rows` + `run-status-icon`) →
    Activities.
  - **Repositories** — connected projects with last-run/last-deploy → Git Repos.
  - **Integrations** — GitHub (+ roadmap) connection status → Integrations.
  - **Pinned docs / Important information** — the §2.3 extra md blocks.

## 4. Empty & first-run states (a landing page lives or dies here)

| State | What the Overview shows |
|-------|--------------------------|
| **No repo connected** | A centered CTA: *"Connect a repository to bring this Workspace to life."* + a one-paragraph explanation of the repo-is-homepage model and a `Connect repository` button. The console-override identity (if set) still renders as the header. |
| **Repo connected, no plan yet** | Identity from `intent.yaml` renders; signal tiles read "—"; a hint: *"Run `orun plan` to populate your catalog and overview."* with a copy-paste command. |
| **Repo + plan, but no `overview.md`** | Render `metadata.description` as the narrative and a gentle nudge: *"Add an `overview.md` to tell your team what this product is,"* with a copy-paste template and a "Create on GitHub" link. |
| **Fully populated** | The full three-band layout above. |

## 5. Data contract (WO2 sketch)

Additive only. The synced overview record, keyed by Workspace `ws_` id:

```
WorkspaceOverview {
  name?: string            // intent metadata.name
  description?: string     // intent metadata.description
  namespace?: string       // intent metadata.namespace
  narrativeMarkdown?: string
  pinnedDocs?: { title: string; path: string; markdown?: string }[]
  source?: { repo: string; ref: string; sha: string; path: string }
  syncedAt?: string        // ISO
}
```

Plus an optional `overrideOverview` (same shape, console-authored) on the org;
resolution = repo-synced ∪ override, repo wins field-by-field when present.

The console reads it through the existing SDK session client (a
`workspaces.overview(orgId)` call); the signal tiles continue to read the catalog
and runs endpoints they already use, so the page degrades gracefully if the
overview record is absent.

## 6. What deliberately does NOT change

- **No new entity.** The Overview is a projection + one additive synced field +
  one optional override column. No `overviews` table, no model rename.
- **No console CMS.** The narrative is repo-sourced; the console override exists
  only as the not-yet-connected escape hatch, never as the primary authoring
  surface.
- **No change to the catalog or activity models.** The signal row and summary
  cards *reuse* `saas-catalog-portal` and the runs feed; they read, they do not
  fork.
- **No renaming of `project`/`environment`** — the `Workspace → Project →
  Environment` hierarchy reads unchanged.
