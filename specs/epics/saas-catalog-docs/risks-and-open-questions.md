# saas-catalog-docs — Risks & open questions

Status: Draft. Decisions locked in `README.md`/`model.md §0` are not
re-litigated here; this tracks the genuinely open items and the risks worth
naming.

## Decisions locked (recap, not open)

- **L1 — `docs.pages` is the one multi-doc surface**; `overview` reserved;
  pages ride the existing **`blob`** closure (no object kind, no CHECK
  migration, no release ordering).
- **L2 — Provenance is true by construction**: `commit` per attached doc; bytes
  read at the pinned commit; dirty/untracked paths refuse attachment with a
  logged reason (never a failed plan, never silent).
- **L3 — Enrich, never create**: `catalog.entities` adds metadata + docs to
  entities the resolve already derives; a non-materializing target is a
  warning, not an entity.
- **L4 — One new projection (`state.catalog_docs`), one new single-context
  endpoint**; the body read reuses the shipped digest endpoint with a widened
  read-model resolve. No cross-context aggregation.
- **L5 — The console never authors or fabricates docs.** Synthetic doc files
  are removed; computed content survives only as a visibly-badged derived card
  (the honesty rule, `design.md §4`).
- **L6 — Bounds**: 256 KiB/doc · 24 pages/entity · 8 MiB doc budget/closure;
  over-cap ⇒ skip + warn (closes WO Q4 with concrete numbers).

## Open questions

### Q1 — Body full-text search: where does the text index live? · deferred to CD7

The hub's v1 search is title/path/entity ILIKE over `catalog_docs` — cheap and
predictable. Real body search needs the text near Postgres (tsvector projected
at projection time — derived, bounded by L6) or an external index. The tsvector
column is the leading option (stays inside the derived-read-model discipline;
~8 MiB/closure bounds the write cost), but it copies doc bodies out of R2 into
Postgres, and nobody has asked yet. Decide when the hub has enough content that
title search demonstrably fails users.

### Q2 — Fold `techdocs`/`runbooks`/`adrs` into role-tagged pages? · open, leaning "later, additively"

Three legacy bodyless pointers now coexist with one body-carrying surface.
Folding them (each `runbooks[]` entry ⇒ an implicit `role: runbook` page) would
consolidate the model but silently start shipping bytes for manifests written
under pointer-only semantics — a behavior change for existing repos, bounded by
L6 but still a surprise. Leaning: keep pointers inert at v1 (as decided), add an
explicit opt-in (`docs.attachLegacyPointers: true`) later if adopters actually
hold runbook content in-repo. Revisit after ogpic + one external adopter.

### Q3 — Same enriched entity, two repos, conflicting docs · deferred until observed

Two repos may both enrich `domain/identity` with different doc sets. The
org-global merge already handles the *rows* (per-scope provenance); the open
question is which doc set the Domain *page* leads with. Options: primary
project's (the WO6 rule), most-recently-synced, or union-with-provenance.
Leaning **union-with-provenance** (a Domain page listing docs from two repos,
each provenance-lined, is honest and useful — docs are not identity fields
where exactly one must win). Decide when a real workspace hits it; nothing in
the schema forecloses any option (rows already carry `source_project_id`).

### Q4 — Images and assets in docs · open (default: not attached)

Docs referencing repo-relative images render without them (the sanitizer
doesn't auto-load, and the bytes aren't in the closure). Attaching image blobs
is mechanically identical to pages but changes the size calculus (L6 budgets
are prose-sized) and the sanitizer posture (serving user-controlled binaries
from the platform origin). Default: not attached; images render as view-source
links. Revisit with concrete demand and a separate size budget + content-type
allowlist.

### Q5 — Enrichment kind set: extend beyond `system|domain|group|environment`? · open

`API`/`Resource` entities are declared (own manifests) so they self-document;
but `User` and future kinds may want enrichment too. v1 keeps the allowed set
tight to avoid two declaration sites for one entity (the validation error in
`model.md §3`). Extend only with a rule that preserves "one site per entity."

## Risks

| Risk | Mitigation |
|------|------------|
| **Closure bloat from many docs** — N entities × M pages inflates snapshots. | L6 caps (per-doc/per-entity/per-closure) enforced at resolve with logged truncation; set-difference sync means unchanged docs never re-upload; content-addressed dedup collapses shared files (e.g. one CONTRIBUTING.md declared by 12 components = one blob); reachability GC reclaims superseded bodies. |
| **Stale docs erode trust in the surface.** | Same freshness model as the whole catalog (snapshot-at-plan) — but now with honest provenance: `path@commit · time` on every doc, "N commits behind" (CD6), and self-healing on the next `orun plan`. A doc surface that *shows* its staleness beats a wiki that hides it. |
| **The derived card is mistaken for a repo file** — the F2 failure mode, reborn. | The honesty rule is normative (`design.md §4`): computed content never gets a file name/icon/`.md`; git content always gets a provenance line. Enforced in review as a UI invariant, not a styling preference. |
| **Markdown injection across many more docs.** | The shipped sanitizing pipeline is reused verbatim on every render path (hub preview, reader, tab, card); no new render pipeline is introduced anywhere. |
| **Projection volume** — doc rows multiply the per-scope write. | Delete-then-upsert per scope stays one transaction; row count is bounded by L6 (≤ 24/entity); the migration-`570` sweep already handles retry/convergence. |
| **Empty hub at launch** — a library with no books. | CD5's first-run state is a worked example + snippet (`design.md §6`); ogpic ships pre-authored docs as the reference; the SC7 scaffolder templates include `docs.pages` so new services are born documented. |
| **Two declaration sites drift** (component docs vs. enrichment). | The `model.md §3` validation error makes them mutually exclusive per entity; enrichment is only for kinds with no manifest of their own. |
| **Vocabulary confusion** ("docs" × 3). | The one-sentence glossary (`design.md §0`) travels in this epic and the WO review (F8); nav copy says **Docs** for catalog docs only. |

## Gate

Human-independent. No third-party credentials, no GitHub App, no new external
dependency — the epic lives entirely within the CLI-push → state-projection →
console-render spine, like its parent.
