# saas-catalog-docs — Design (UX / IA)

Status: Draft (normative once CD0 lands)

The console surfaces for the catalog doc system. The **data/wire model** (doc
set, enrichment, projection, endpoints) is normative in `model.md`; this doc
covers the surfaces. Written against console reality as of 2026-07-05: the
sidebar Workspace section is `Overview · Catalog · Activities · Git Repos ·
Integrations` (`components/shell/nav-items.ts`); the catalog service page ships
five tabs (Overview · Docs · Dependencies · Activity · Scorecard,
`components/catalog/portal/service-page.tsx:31`) with a **synthesized** Docs tab
(`lib/catalog-portal/page.ts docsFor()`); the sanitizing markdown pipeline is
shipped (`components/overview/markdown.tsx`); the Workspace Overview renders the
primary repo's `docs.overview` by digest.

## 0. Glossary (one sentence, because "docs" is now three things)

- **Product docs** — `apps/web-docs` (Docusaurus): documentation *about Orun
  Cloud*, authored in this repo, public. Untouched by this epic.
- **Catalog docs** — this epic: documentation *about the customer's entities*,
  authored in *their* repos, carried in catalog snapshots, rendered by digest.
- **Derived cards** — computed summaries of catalog facts, rendered with a
  visible "derived" badge, never presented as files.

## 1. Where it lives

Three surfaces, one new nav item:

- **Docs hub** — `/orgs/{slug}/docs`. New **Docs** entry in the Workspace nav
  section, after **Catalog** (icon `BookOpen`). The org-wide library of every
  attached doc.
- **Doc reader** — `/orgs/{slug}/docs/{entityKey}/{docKey}`. Deep-linkable,
  stable across content changes (identity is `(entity, key)`, `model.md §2c`).
- **Entity Docs tab** — the existing `catalog/[entityKey]` service-page tab,
  now fed by real data (CD4). Same reader components, embedded.

The Workspace Overview is unchanged except its right rail finally gains the
**docs card** WO's design promised (§5).

## 2. Docs hub (`/orgs/{slug}/docs`)

A library, not a wiki. Reads `GET …/catalog/docs` (keyset, filterable) — one
query, no body fetches.

- **Header:** title + total count + the search field (`q` → title/path/entity
  ILIKE, server-side).
- **Filter row:** kind chips (reusing the catalog kind styling from
  `lib/catalog-kind.ts` — Repos · Components · APIs · Resources · Systems ·
  Domains · Groups · Environments) + role chips (well-known roles get icons:
  `runbook` siren, `architecture` blueprint, `adr` gavel, `reference` book,
  `changelog` clock, `guide` default; unknown roles render neutrally).
- **Body:** grouped by **entity kind**, then by entity — an entity with 4 docs
  is one card with 4 rows, not 4 scattered rows. Each doc row: title · role
  badge · `path@short-commit` provenance · synced-at. Row click → reader.
- **Sorting:** entity name asc; within an entity, declared `position`.
- **Degradation:** filters compose with URL params (shareable), consistent with
  the catalog portal's URL-driven scope.

## 3. Doc reader (`/orgs/{slug}/docs/{entityKey}/{docKey}`)

- **Left rail (the shelf):** the entity's full doc set — overview first, then
  pages in declared order; the active doc highlighted; role icons. Entity
  identity block above it (kind icon, name, owner) linking back to the entity
  page. This rail is the same component the entity Docs tab embeds.
- **Body:** the sanitized markdown render (existing pipeline: no raw HTML,
  `rel="noopener nofollow ugc"`, no auto-loaded remote images, width-
  constrained prose, console type scale). Auto-built ToC for long docs (the
  affordance WO specified for the narrative band).
- **Provenance line:** `From <repo> · <path> @ <short-commit> · <relative time>`
  + **View source** (plain hyperlink to the file at that commit — display, not
  integration). When the platform knows the latest linked commit, append
  "N commits behind `<default-branch>`" (CD6, same mechanism WO specified).
- **Sibling links (CD6):** a relative link that resolves to another attached
  page's `path` navigates within the reader; everything else keeps the
  sanitized external-link treatment. Never a render-time git call.
- **Body fetch:** `GET …/catalog/doc?digest=…` — the shipped endpoint; the
  digest comes from the doc row, so the reader is two reads, both cacheable by
  digest (content-addressed bodies are immutable — cache forever).

## 4. Entity Docs tab goes real (CD4) — and the synthesis honesty rule

The current tab fabricates `README.md` / `ARCHITECTURE.md` / `RUNBOOK.md` /
`API.md` / `PROVISIONING.md` from catalog fields (`page.ts:217-248`). That
framing — file names, file icons — asserts provenance that doesn't exist. The
replacement:

| State | What the Docs tab shows |
|-------|--------------------------|
| **Entity has attached docs** | The shelf (left) + reader body (right) — identical components to §3, embedded. `docs[0]` = overview when present. |
| **Entity has digestless declarations** (file missing / over cap / dirty at push) | The declared entries listed greyed with the logged reason ("declared but not attached at `<commit>`") — visible, not silently absent, so authors can fix the manifest. |
| **Entity has no docs** | One **derived card** — "About this `<kind>`" — computed from real catalog facts (description, system, owner, dependencies), *visibly badged* `derived — not a repo file`, followed by the empty-state nudge: *"Document this `<kind>` from its repo"* + a copy-paste `docs.pages` snippet pre-filled with the entity's manifest location. |

**The honesty rule (normative):** computed content never carries a file name,
file icon, or `.md` suffix; git-authored content always carries its provenance
line. There is no third category.

The derived-card generators keep the useful parts of today's `genReadme`/
`genArch` fact tables and drop the prose theater. `docsFor()`'s synthetic
entries are deleted, not hidden behind a flag — CP's design-fidelity goal is
served by the layout, not by fictional files.

## 5. Workspace Overview — the docs card (right rail)

WO `design.md §3` specified a "Pinned docs / Important information" card that
never shipped (single-doc ceiling — review F5). CD5 ships it against real
data: the **primary repo's** doc set (top ~5 by position, role icons) → each
row into the reader; footer link "All docs →" into the hub filtered to that
repo. Hidden entirely when the primary repo has only the overview (the hero
already renders it) — the card earns its place only with content.

## 6. Empty & first-run states (the hub lives or dies here)

| State | What the hub shows |
|-------|--------------------|
| **No repo linked / no catalog** | The same CTA chain the Overview uses (link a repo → run `orun plan`) — never a blank library. |
| **Catalog, but zero attached docs** | A worked example: a rendered mini-preview of what a doc row looks like + the `docs.pages` snippet + a link to the reference adopter pattern. One screen, copy-paste, done. |
| **Docs exist, filter matches none** | Standard empty filter state (consistent with the catalog portal). |
| **Populated** | §2. |

## 7. Security & rendering

Unchanged from WO, now applied to N docs: repo markdown is untrusted-ish —
sanitized pipeline, no raw HTML, forced `rel`, no auto-loaded remote images, no
author-controlled fonts/colors. Bodies are immutable by digest → aggressive
client caching is safe. The list endpoint is gated `catalog.read`; the body
endpoint additionally resolves the digest through the org's read model
(`model.md §5b`) — a digest outside the org's projected docs 404s.

## 8. What deliberately does NOT change

- The Overview hero, `repo_facet`, and `doc_ref` reads — untouched.
- The sanitizing pipeline — reused, not forked.
- The catalog portal's index/board/map views — the hub is a sibling surface,
  not a replacement.
- `apps/web-docs` — different system, different audience (§0).
- No console doc authoring of any kind — the empty states teach the manifest,
  they never offer a textbox.
