# saas-catalog-docs — Implementation status (as-built)

Status: **✅ Shipped CD0–CD6** (2026-07-05). CD7 remains deferred by design.
As-built record per the epics convention — what actually landed, PR by PR,
with the deviations from the design docs named explicitly.

## Shipped

| ID | What landed | PRs |
|----|-------------|-----|
| CD0 | Epic + normative model + WO post-ship review (`review-2026-07-05.md`); `orun` mirror; ogpic adoption note + pre-authored docs | orun-cloud #337 · orun #462 · ogpic #23 |
| CD1 | `docs.pages` on the shared docs structs + schema regen; universal `PendingDocs` walk (components + repo block; assembly stamps digests into `pages[]` with a cross-loop dedup sink); `commit` provenance + pinned-commit gate (dirty/untracked paths refuse attachment, logged; no-git attaches with no commit claimed); caps 256 KiB/doc · 24 pages/entity · 8 MiB/closure; `orun catalog docs --list` shelf + per-key body | orun #463 |
| CD2 | `catalog.entities` enrichment for derived kinds (`system\|domain\|group\|environment`): fill-empty metadata + the doc set, *enrich-never-create* validation (orphan target ⇒ warning; declared kind ⇒ error); Group matching strips the `group:` typed-ref prefix | orun #464 |
| CD3 | Migration `620_state_catalog_docs` (`state.catalog_docs` + scope/browse/digest/keyset indexes); projector emits doc rows in the entity pass (inherits the 570 outbox/sweep); `findCatalogDocProject` gains the exact-match `catalog_docs` leg so page bodies serve through the shipped `GET …/catalog/doc?digest=`; contracts `CatalogDoc` + `GET …/catalog/docs` + SDK `listCatalogDocs` | orun-cloud #340 |
| CD4 | Entity Docs tab goes real: shared `DocShelf`/`DocBody` (sanitizing pipeline, digest-immutable caching, provenance line); the five synthesized doc generators **deleted**; one badged derived card + the manifest nudge (the honesty rule, asserted by test) | orun-cloud #341 |
| CD5 | Docs hub (`/orgs/{slug}/docs`: kind/role chips, search, kind→entity shelves) + identity-addressed reader (`/docs/{entityKey}/{docKey}`) + **Docs** nav row + the Overview right-rail docs card (WO design §3's promised card, real data, hidden at ≤1 doc) | orun-cloud #342 |
| CD6 | Sibling-link rewriting: relative links resolving (against the doc's directory) to another attached page's path navigate in-app via identity-addressed routes; schemed/anchored/absolute/repo-escaping/unattached hrefs keep the sanitized external treatment (`lib/doc-links.ts`, unit-tested) | orun-cloud #343 |

## Deviations from the design docs (deliberate, recorded)

1. **Component doc paths resolve component-relative** (normalized repo-relative
   on the wire). `model.md §2a` said "repo-relative"; authoring reality wants
   `docs/runbook.md` next to the `component.yaml` to mean *that* directory. The
   wire/provenance stays repo-relative everywhere, so no consumer changes.
2. **Declared-only entries are not yet greyed in the console** (design §4 row
   2). The doc index carries attached docs only; the declared-but-unattached
   entries live on the entity JSON, which the org read model doesn't surface.
   They ARE visible in `orun catalog docs --list` (with the skip reason).
   Follow-up if demand appears: surface `docs` on `org_catalog_entities`.
3. **"N commits behind" staleness is not shipped** (design §3, CD6's optional
   half). It needs the latest-linked-commit signal (push events), which the
   platform doesn't reliably have per repo yet — same dependency WO recorded.
   Rides with CD7-era polish; the provenance line (`path @ commit · synced`)
   ships everywhere.
4. **Hub filtering is client-side** over one cached fetch-all (the catalog
   portal's exact idiom) rather than server-driven `q`/filter params; the
   server-side filters exist on the endpoint and remain available for large
   orgs.
5. **The overview's deprecated `sha`** (content sha256) is still emitted for
   WO4 wire compat, as specified; pages never carry it.

## Verification (per milestone, at merge time)

- orun: full `go test ./...` green each PR; end-to-end fixture verified the
  CD1 shelf (attach@commit / declared-only + reason), the dirty-path refusal,
  page body printing, and the CD2 enriched Domain (description/owner/doc with
  digest parity; phantom target warned, created nothing).
- orun-cloud: db/contracts/sdk/state-worker/console suites green each PR
  (218 state-worker + 452 console tests at CD6), including new projection
  doc-index tests, honesty-rule assertions, and the sibling-resolver matrix.
- Pre-existing `tests/api-edge` wrangler.jsonc config failures reproduce with
  changes stashed (generated file absent in fresh clones) — unrelated.

## Deferred (CD7 — unchanged)

Body full-text search (risks Q1) · doc-coverage as an SC5 scorecard signal ·
`Product` docs (rides WO6) · staleness "N commits behind" (deviation 3) ·
legacy pointer fold-in (risks Q2) · asset/image attachment (risks Q4).
