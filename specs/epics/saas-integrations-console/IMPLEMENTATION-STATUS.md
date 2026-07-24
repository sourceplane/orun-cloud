# Implementation status — saas-integrations-console

As-built ledger (distinct from design/plan). A milestone is marked ✅ in place
when its PR merges; deltas from design are recorded as dated notes.

| Milestone | Status | PRs | Notes |
|-----------|--------|-----|-------|
| IX0 — Epic spec | ✅ Shipped (#611) | #611 | This spec set. |
| IX1 — Hub redesign | ✅ Shipped (#613) | #613 | Frontend + best-effort brokered-secret count. `hub-model.ts` + `ProviderTile`; `/demo/integrations` showcase. |
| IX2 — Detail framework + GitHub page | ✅ Shipped (#615) | #615 | Archetype-derived tabbed shell + GitHub (Overview + capability toggles · Repositories · Workspace access · Activity). Migration 930 `capability_prefs`; `handleUpdateConnection` accepts prefs on any scope. `Segmented` control. |
| IX3 — Infrastructure archetype | ✅ Shipped (#617) | #617 | Supabase + Cloudflare: Overview (what Orun can broker) · Secrets (brokered/rotated) · Projects · Activity. No new backend — `secret-model.ts` filters the org secrets list by binding/rotation connectionId (Q1 resolved). |
| IX4 — Messaging archetype (Slack) | 🗓️ Planned | — | Adds notification routing prefs. |
| IX5 — Connect picker · polish · supersede space | 🗓️ Planned | — | |

## As-built notes

- **2026-07-24 (IX2)** — The live **Activity** tab reuses `SpaceActivity`
  (functional: mint ledger + delivery log with a connection selector), not the
  mockup's single merged timeline. Restyling to the mockup's row-form timeline is
  deferred to the IX5 polish pass; the target styling is shown in
  `/demo/integrations/github`.
- **2026-07-24 (IX2)** — Repository All/Selected is read + filter + a
  *Manage-on-GitHub* deep link (Q2 default). GitHub owns the installation's repo
  set and `PublicRepository` carries no per-repo selected flag, so the console
  shows the accessible set and links out to change it rather than writing it.
- **2026-07-24 (IX1)** — The hub's `list` read projects `repositorySelection:
  null` (only `get` loads it), so a live GitHub connected row omits the
  "All/Selected repositories" clause; the detail page (which uses `get`) has it.
  Enriching the list projection is a possible later slice.
