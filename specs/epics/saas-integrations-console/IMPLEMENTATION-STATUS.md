# Implementation status — saas-integrations-console

As-built ledger (distinct from design/plan). A milestone is marked ✅ in place
when its PR merges; deltas from design are recorded as dated notes.

| Milestone | Status | PRs | Notes |
|-----------|--------|-----|-------|
| IX0 — Epic spec | ✅ Shipped (#611) | #611 | This spec set. |
| IX1 — Hub redesign | ✅ Shipped (#613) | #613 | Frontend + best-effort brokered-secret count. `hub-model.ts` + `ProviderTile`; `/demo/integrations` showcase. |
| IX2 — Detail framework + GitHub page | ✅ Shipped (#615) | #615 | Archetype-derived tabbed shell + GitHub (Overview + capability toggles · Repositories · Workspace access · Activity). Migration 930 `capability_prefs`; `handleUpdateConnection` accepts prefs on any scope. `Segmented` control. |
| IX3 — Infrastructure archetype | ✅ Shipped (#617) | #617 | Supabase + Cloudflare: Overview (what Orun can broker) · Secrets (brokered/rotated) · Projects · Activity. No new backend — `secret-model.ts` filters the org secrets list by binding/rotation connectionId (Q1 resolved). |
| IX4 — Messaging archetype (Slack) | ✅ Shipped (#619) | #619 | Overview · Channels · Notifications routing · Activity. No new backend — routing reuses the `capability_prefs` blob (Q3 resolved). |
| IX5 — Connect picker · route unification | ✅ Shipped (#PR5) | #PR5 | Global registry-driven Connect picker; shared `ProviderRoute` unifies the provider + nested-connection routes onto the new detail (fallback to the space). |

## As-built notes

- **2026-07-24 (IX5, epic complete)** — All three archetype detail bodies and the
  hub match the mockup. The **one remaining pixel gap** is the live **Activity**
  tab: it reuses the functional `SpaceActivity` (connection selector + mint/
  delivery sections) rather than the mockup's single merged colored-dot timeline
  (which the `/demo/integrations/*` pages show as the target). A merged
  `ConnectionActivity` timeline over the existing mint + delivery reads is the
  natural follow-up — no new backend, purely a restyle. Everything else in the
  design is shipped.
- **2026-07-24 (IX5)** — The generic `ProviderSpace` is superseded for connected
  providers of an implemented archetype via the shared `ProviderRoute`, but kept
  as the fallback for connect flows, unconnected providers, and unimplemented
  archetypes (ai-provider/compute). `archetype.ts` was left in place (still used
  by the space's `connection-detail`); its removal waits on the space's full
  retirement.
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
