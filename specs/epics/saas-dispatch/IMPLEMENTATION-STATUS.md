# saas-dispatch — Implementation Status (as-built)

The as-built record, kept distinct from the design/plan docs. Nothing is built
yet — this epic is **proposed**. Rows flip to 🏗️/✅ as DX milestones land.

| Milestone | Status | As-built |
|-----------|--------|----------|
| DX0 — The Situation read-model | 🗓️ Not started | — |
| DX1 — DispatchIndex + live push | 🗓️ Not started | — |
| DX2 — The Dispatch surface | 🗓️ Not started | — |
| DX3 — The front door | 🗓️ Not started | — |
| DX4 — Proactive dispatch | 🗓️ Not started | — |
| DX5 — Responsiveness + trust hardening | 🗓️ Not started | — |

## Notes for the first implementer

- Start at DX0 and get the fold *shape* right against fixtures before any DO
  exists — the live layer (DX1) is worthless over a wrong fold.
- Reuse, do not rebuild: the work fold (WP), the AG7 session list, the AF6
  attention feed, and the AF9 budget read are all shipped and viewer-scoped.
  The facade composes them; it owns no table.
- The `DispatchIndex` belongs in `apps/chat-worker` (unprivileged) as a sibling
  SQLite DO to `ChatIndex`/`WorkspaceMemory` — mirror their binding/migration
  idiom (per-env DO blocks, top-level migration).
- The dispatch head socket is attach v1 plus two frames; do not introduce a
  second sync vocabulary (AN decision 2).
