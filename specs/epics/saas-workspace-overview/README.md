# Epic: saas-workspace-overview

**Give every workspace a per-repo landing page that answers "what is this product,
is it healthy, what do I do next" — with the narrative authored in the repo and
rendered by the console, never fetched from a git provider.** The overview markdown
lives in the repo (`docs/overview.md`), rides `orun catalog push` into state as a
content-addressed blob, and the console assembles the page at the read edge.

This is the **platform half** (cluster **WO**). The **CLI half** is
[`orun/specs/orun-workspace-overview/`](../../../../orun/specs/orun-workspace-overview/)
(milestone **WO3**, landed): the `Repo` kind, `docs.overview`, and the doc blob.
The **normative cross-repo model** is [`model.md`](./model.md) — read it first.

## Status

| Field | Value |
|-------|-------|
| Status | **⏳ In progress** — epic scaffolded (this PR). WO3 (CLI) landed in `orun`. WO2/WO4/WO5 planned; WO6 deferred. |
| Cluster | **WO** (workspace overview — the console landing) |
| Owner(s) | `apps/web-console-next` (WO2, WO5) · `apps/state-worker` + `packages/db` + `packages/contracts` (WO4 projection + facet) |
| Target branch | `main` (PRs merged incrementally) |
| Normative model | [`model.md`](./model.md) — kinds, refs, `doc_ref` shape, state tables, push/read flow. Both repos conform. |
| Cross-repo review | [`architecture-review.md`](./architecture-review.md) — the full review; the CLI-half findings are mirrored in `orun`'s `architecture-review.md`. |
| Builds on | [`saas-orun-platform/`](../saas-orun-platform/) (the hosted object model + catalog head/projection), [`saas-catalog-portal/`](../saas-catalog-portal/) (the org-catalog projection + console catalog surface this reuses), `components/18-state.md` (the object store + `blob` kind, tenant scoping) |
| Pairs with | `orun` **WO3** (the `Repo` entity + overview blob it pushes) |

## The read-model invariant (inherited, non-negotiable)

Per `components/18-state.md` and `saas-catalog-portal`, catalog/overview content is
**derived from git, never authored in the console**. The overview markdown is
git-authored (`docs/overview.md`), carried as pushed bytes. There is **no
`/overview` write endpoint and no console override** — the console renders what the
repo pushed (`model.md §6`). No console write authors the overview.

## Thesis

The platform already has the hard parts: a provenance-correct catalog snapshot, a
hosted object store that scopes bytes by tenant, and an idempotent catalog
projection. The overview is the last mile — a repo-authored front page that the
console can render without ever reaching back into a provider. WO3 already puts the
`Repo` entity and the overview blob into the pushed snapshot; this epic projects the
repo facet, dereferences the doc by digest at the read edge, and draws the landing.

## Read order

1. `README.md` (this file) — status, invariant, milestones.
2. [`model.md`](./model.md) — the normative cross-repo contract (read before design).
3. [`design.md`](./design.md) — the platform-side design: projection, facet, read edge, console.
4. [`implementation-plan.md`](./implementation-plan.md) — WO2/WO4/WO5, each with "done when".
5. [`architecture-review.md`](./architecture-review.md) — the cross-repo review (A1–A3, B).

## Milestones at a glance

Milestone numbering is **cross-repo and fixed** by the CLI spec's ownership split
— do not renumber. WO3 is the CLI half (in `orun`); WO2/WO4/WO5 are this epic.

| ID | Milestone | Repo | Status |
|----|-----------|------|--------|
| WO2 | **Workspace Overview landing** — the per-workspace console route + shell, rendering repo facets (behind the WO4 data, degrading gracefully until it lands). Ships first; needs nothing from WO3/WO4. | orun-cloud | ⏳ Planned |
| WO3 | **CLI: `Repo` kind + `docs.overview` + doc blob** — the snapshot carries the repo self-description and overview bytes. | orun | ✅ Landed |
| WO4 | **Projection + facet + read-doc** — `state.repo_facet` (migration + contracts + repository), the `Repo` branch in `catalog-projection.ts`, and the console-facing facet read; the overview doc is read by digest via the existing object GET. | orun-cloud | ⏳ Planned |
| WO5 | **Console render** — assemble the overview page at the read edge: identity, owner, links, tags, the rendered overview markdown, and workspace health facets. | orun-cloud | ⏳ Planned |
| WO6 | **`Product` kind** (multi-repo composition) + `products:` + primary selection. | both | 🅿️ Deferred |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The workspace overview **page**; the `state.repo_facet` table + projection branch + contracts/SDK read; reading the overview doc by digest at the read edge; rendering repo-authored markdown + links + facets | Authoring overview content in the console (forbidden by `18-state.md`); a `/overview` endpoint or console override; the `Product` kind + multi-repo merge (WO6); provider/GitHub-App integration (the CLI pushes bytes; nothing is fetched live); APM/SLO ingestion (health degrades honestly where no source exists) |

## Relationship to existing work

- **`saas-orun-platform` (OP/OV)** owns the object store, catalog head, and
  projection pipeline this epic extends. WO4 adds a branch to the existing
  `catalog-projection.ts`, not a new pipeline.
- **`saas-catalog-portal` (CP)** ships the org-catalog console surface and the
  `org_catalog_entities` projection + portal fields (migration 370). WO4 mirrors
  its idempotent scope-replace pattern; WO5 reuses its component/entity primitives.
- **`orun` WO3 (this epic's CLI half)** is landed: it pushes the `Repo` entity +
  overview blob. Its local read surface (`catalog describe repo:`, `catalog docs`)
  is tracked separately as **WO3.1** in the `orun` repo and does not block WO2–WO5.
