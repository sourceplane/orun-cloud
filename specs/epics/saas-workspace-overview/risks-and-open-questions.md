# saas-workspace-overview — Risks & open questions

Status: Draft. Decisions locked in `README.md` are not re-litigated here; this
tracks the genuinely open items and the risks worth naming.

## Decisions locked (recap, not open)

- **L1 — No git-provider coupling.** Docs travel as content-addressed `doc`
  objects in the catalog snapshot; the console never calls a provider API at
  render time. (Supersedes the earlier fetch-live-via-GitHub-App proposal, now
  dropped entirely.)
- **L2 — Overview is the Workspace landing** (`/orgs/{slug}` renders it).
- **L3 — `Repo`/`Product` are declared catalog kinds**; `kind` is free-text TEXT
  server-side, so no kind-enum migration.
- **L4 — `docs.overview` extends the shared docs struct**, spanning all kinds.

## Open questions

### Q1 — `Repo` ref format and provider identity

`Repo` ref is `repo:<provider>/<owner>/<name>`. But a repo may be linked with no
GitHub App (a bare `state.workspace_links.remote_url`). Do we key the `Repo`
entity off the normalized remote URL (host/owner/name) rather than a provider id,
to stay provider-agnostic? **Lean:** yes — derive from `CatalogSnapshot.Repo`
(the normalized remote), never from a provider numeric id, keeping the "any git
remote" invariant. Confirm the exact normalization matches `workspace_links`.

### Q2 — Primary project selection

Default primary = most-recently-synced active `workspace_links` project. Is an
explicit `primary_project_id` setting needed at v1, or is the default enough until
a workspace actually has multiple repos? **Lean:** ship the default resolution;
add the explicit setting in WO-later only when multi-repo workspaces appear.

### Q3 — `Product` that spans repos — which doc wins?

A `Product` declared in two repos merges by `product:<namespace>/<name>`. If both
declare `docs.overview`, which digest renders? **Options:** (a) the primary
project's; (b) most-recently-advanced head; (c) require the product's overview to
live in one repo (validation error otherwise). **Lean:** (a) primary project's,
with a console note when a conflict is detected.

### Q4 — Doc size / storage bound

Docs count toward `limit.state.storage_gb`. A `techdocs: docs/` tree could be
large. **Decision needed:** the default cap (single `overview` file only?) and
the opt-in tree cap. **Lean:** overview-only by default; trees opt-in with a
per-object and per-closure byte cap, `log()`-ed when truncated.

### Q5 — Override lifecycle

`override_overview` is the escape hatch for not-yet-linked workspaces. When a repo
later publishes a `Repo`/`Product`, does the override auto-yield (repo wins per
field) or need explicit clearing? **Lean:** auto-yield field-by-field (repo
wins), keep the override stored but shadowed, surface a "now sourced from
`<repo>`" note.

### Q6 — Doc read authorization

The `doc` object is org/project-scoped state; reading it uses
`state.object.read` / `catalog.read`. Confirm the console's overview read path
carries the right scope and that a member who can see the catalog can see its
docs (they are the same provenance). **Lean:** reuse `catalog.read`; no new gate.

## Risks

| Risk | Mitigation |
|------|------------|
| **Stale overview** — the doc only refreshes on the next `orun plan`. | This is the *same* freshness model as the whole catalog (snapshot-at-plan); surface the `From <repo>@<sha> · <time>` provenance so staleness is visible, and it self-heals on the next publish. |
| **Markdown as an injection vector** — untrusted repo content in the console. | `rehype-sanitize`, no raw HTML, `rel="nofollow ugc noopener"`, no auto-loaded remote images, width-constrained prose (`design.md §2`). |
| **Kind sprawl** — adding `Repo`/`Product` normalizes ad-hoc kinds. | They ride the existing extensibility path (`allEntityKinds` + envelope `Spec any`); the frontend `KINDS` array stays the single styling registry; no schema change invites no schema drift. |
| **Snapshot bloat** — many large docs inflate the closure. | Overview-only default + size caps (Q4); set-difference sync means unchanged docs never re-upload; content-addressed dedup across repos. |
| **Empty landing** — a brand-new workspace with no repo feels broken. | The empty-state CTA + the optional `override_overview` keep the page purposeful, never blank (`design.md §4`). |

## Gate

Human-independent. No third-party credentials, no GitHub App, no new external
dependency — the feature lives entirely within the CLI-push → state-projection →
console-render spine that already ships the catalog.
