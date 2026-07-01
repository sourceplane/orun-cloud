# saas-workspace-overview — Risks & open questions

Status: Draft. Decisions locked in `README.md` are not re-litigated here; this
tracks the genuinely open items and the risks worth naming.

> **2026-07-01:** the epic was revised to **adopt** `architecture-review.md`.
> Several items below moved from "open, leaning X" to **resolved** — the `Repo`
> ref is minted from the durable project id (Q1), `override_overview` is dropped
> (Q5), doc-read auth reuses existing scopes (Q6), and `Product`/explicit primary
> selection are deferred to WO6 (Q2, Q3). What remains open is genuinely open.

## Decisions locked (recap, not open)

- **L1 — No git-provider coupling.** Docs travel as content-addressed `doc`
  objects in the catalog snapshot; the console never calls a provider API at
  render time. (Supersedes the earlier fetch-live-via-GitHub-App proposal.)
- **L2 — Overview is the Workspace landing** (`/orgs/{slug}` renders it), and it
  **ships first from orun-cloud alone** (WO2, Phase 1) before the cross-repo
  narrative chain (WO3–WO5, Phase 2).
- **L3 — `Repo` is a declared catalog kind**, one per `intent.yaml`, with its ref
  minted from the **durable project id** (not an un-normalized remote). `kind` is
  free-text TEXT server-side, so no kind-enum migration. **`Product` is deferred**
  to WO6.
- **L4 — `docs.overview` extends the shared docs struct**, spanning all kinds;
  bytes are read **at the pinned commit** and travel as a content-addressed
  **`blob`** in the existing closure — **no new object kind, no CHECK migration**
  (GC is closure-based, so a distinct kind buys nothing — `architecture-review.md
  §B`).
- **L5 — The console never authors catalog content.** No `override_overview`, no
  `/overview` endpoint; the page is assembled at the read edge, and a not-yet-
  linked workspace shows the empty-state CTA.

## Resolved (were open; closed by the 2026-07-01 revision)

### Q1 — `Repo` ref format · **RESOLVED**

`CatalogSnapshot.Repo` is an **un-normalized passthrough** (`sourceplane/orun`,
no host/scheme), not the normalized `workspace_links.remote_url` — so there is
nothing on the CLI side to "match", and minting a ref from it would turn ad-hoc
CLI formatting into a frozen cross-repo contract. **Resolution:** mint the `Repo`
ref from the **durable project/`ws_` id** the platform already trusts as the join
key (`model.md §2c`). `state.repo_facet` is keyed `(org_id, source_project_id)`,
so the repos list and identity resolve by project, not by the ref string; the
`path/ref/sha` provenance still carries the human remote for "view source".

### Q2 — Primary project selection · **RESOLVED (deferred)**

v1 uses the **derived** primary (most-recently-synced active `workspace_links`
project) with **no authored column**. An explicit `primary_project_id` ships with
**WO6**, only when multi-repo workspaces make the default ambiguous (`model.md
§4c/§7`).

### Q5 — Override lifecycle · **RESOLVED (dropped)**

`override_overview` was the first **console-authored** content the catalog would
render, straining `18-state.md`'s "console never authors catalog / derived-never-
authored" invariant. The empty-state CTA (`design.md §4`) already covers "never
blank" and is a better first impression than console-typed placeholder prose.
**Resolution:** drop `override_overview` entirely for v1. (If a future need for
console-set org identity appears, it lives as clearly-labeled **org profile
metadata outside the catalog/state plane**, never field-merged into git-authored
content.)

### Q6 — Doc read authorization · **RESOLVED (close)**

`GET …/state/objects/{digest}` already gates on `state.object.read` and 404s
cross-tenant; a member who can read the catalog can read its docs (same
provenance). Reuse `catalog.read`/`state.object.read`; **no new gate**.

## Open questions

### Q3 — `Product` that spans repos — which doc wins? · deferred to WO6

Only relevant once the `Product` kind ships. A `Product` declared in two repos
merges by `product:<namespace>/<name>`; if both declare `docs.overview`, **the
primary project's digest renders**, with a console note when a conflict is
detected (options considered: primary's / most-recently-advanced / single-repo
validation — primary's chosen). Revisit when WO6 is scoped.

### Q4 — Doc size / storage bound · open (default decided)

Docs count toward `limit.state.storage_gb` like any `blob`; per-doc attribution is
a `doc_ref.digest → state.objects.size` join (no kind filter needed). Default:
**single `overview` file only** (KB-scale). A `techdocs: docs/` tree is **opt-in**,
with a per-object and per-closure byte cap, `log()`-ed when truncated (never
silently dropped). The exact cap values are the remaining open detail.

## Risks

| Risk | Mitigation |
|------|------------|
| **Stale overview** — the doc only refreshes on the next `orun plan`. | Same freshness model as the whole catalog (snapshot-at-plan). Surface `From <repo>@<sha> · <time>` provenance **and** "N commits behind `<default-branch>`" (from push events / `workspace_links.last_seen_at`) so staleness is *actionable*, not just visible; it self-heals on the next publish (`design.md §3`). |
| **Working-tree ≠ commit on `--push-catalog`** — doc bytes could diverge from the pinned sha. | Read `docs.overview` bytes from the **git object at the resolved commit**, or refuse to attach doc objects on a dirty tree (the autopush gate) and log why (`model.md §3a`). Makes the point-in-time guarantee unconditional. |
| **Markdown as an injection vector** — untrusted repo content in the console. | `rehype-sanitize`, no raw HTML, `rel="nofollow ugc noopener"`, no auto-loaded remote images, width-constrained prose (`design.md §2`). |
| **Kind sprawl** — adding `Repo` (and later `Product`) normalizes ad-hoc kinds. | One kind at v1 (`Repo`), `Product` deferred; they ride the existing extensibility path; the frontend `KINDS` array stays the single styling registry. Note the real cost: a new kind needs `buildGraphs()` + an emit path, not just an array entry (`architecture-review.md §A2`). |
| **Snapshot bloat** — many large docs inflate the closure. | Overview-only default + size caps (Q4); set-difference sync means unchanged docs never re-upload; content-addressed dedup across repos; reachability GC reclaims superseded doc blobs from the live heads, same as any snapshot object. |
| **Empty landing** — a brand-new workspace with no repo feels broken. | The empty-state CTA keeps the page purposeful, never blank (`design.md §4`) — no console-authored override needed. |
| **Cross-repo release coupling** — the narrative needs a coordinated CLI + platform release. | Phasing removes it from the critical path: WO2 (the landing) ships from orun-cloud alone; and docs ride the existing `blob` kind, so there is **no object-kind ordering** between WO3 and WO4 at all. |

## Gate

Human-independent. No third-party credentials, no GitHub App, no new external
dependency — the feature lives entirely within the CLI-push → state-projection →
console-render spine that already ships the catalog.
