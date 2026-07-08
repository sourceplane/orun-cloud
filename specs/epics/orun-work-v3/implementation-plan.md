# orun-work v3 — implementation plan

Status: Normative ladder. Milestones follow the importable convention
(`orun work import` reads this file); each is independently shippable and
lands as one or more PRs with CI green. IDs are PM0–PM5.

Cross-cutting acceptance for every milestone: no lifecycle-write path is
introduced at any layer (the WP-3 assertion tests extend to every new kind,
route, and tool); every mutation appends exactly one coordination event
(WP-6); new routes are authz-first with resource-hiding 404 reusing
`work.read`/`work.write` (V3-4); the v2 conformance fixtures pass unmodified.

## PM0 — Cloud authoring core

**Goal:** Create and edit initiatives, specs, and tasks from the console, with spec documents as content-addressed cloud revisions.
**Done when:** migration 650 lands (doc_revisions, cycles, views + cache columns) with manifest/lock regenerated; the event vocabulary grows per design §1.2 with the CHECK regenerated and the no-lifecycle-kind assertion extended; initiative item kind exists end-to-end; create/edit forms ship for all three item kinds; `PUT …/specs/{slug}/doc` + history read exist with fork-visible LWW; `orun spec pull` seals a cloud-authored spec unchanged; repo import still passes idempotency tests and forks (never overwrites) a cloud doc chain.
**Deps:** —

## PM1 — Conversation

**Goal:** Threaded comments with mentions and reactions on specs and tasks, and the unified timeline that interleaves both logs.
**Done when:** comment threading (parent_event) and reactions ship UI-to-log; document range-anchored comments render pinned to their revision with the superseded-revision chip; `GET …/work/timeline/{key}` interleaves coordination and observation entries and the task/spec pages render it with actor and evidence chips; mentions parse at write time and publish `work.*` events consumed by ES2 notification rules (a mention produces a notification through an org rule, proven in tests).
**Deps:** PM0

## PM2 — Board and views

**Goal:** The kanban board by rung with honest drag semantics, plus filters, saved views, labels, priority, and estimates.
**Done when:** the board renders columns from the rung order; drag-across mints a pin with a note affordance and the card renders pin-beside-truth; drag-within appends ordered; rejected drops render the mutator verdict inline; label/priority/estimate/relate mutators ship with folded cache columns rebuilt from the log alone (invariant-1 test extended); list view + filter bar + saved views (work.views CRUD) ship; the summary response carries the folded intent additively with v2 clients unbroken.
**Deps:** PM0

## PM3 — Cycles and derived progress

**Goal:** Authored time-boxes whose progress is derived, never entered.
**Done when:** cycle CRUD + cycle_set assignment ship; the cycle page renders a burn-up computed from the fold (done-with-green-gates over time) with no editable series anywhere (V3-3 asserted); spec and initiative pages show derived rollups; carry-over is rendered as facts-that-did-not-arrive, not moved-by-hand.
**Deps:** PM2

## PM4 — Flow

**Goal:** The Linear feel: keyboard-first, optimistic, realtime.
**Done when:** work verbs register in the console Cmd-K palette (create task, comment, pin, label, jump); the optimistic store applies intent locally, confirms via the SSE tail, and rolls back rendering the 422 verdict; every list/board/timeline updates live from the existing stream without route-specific transport code; p95 create-to-render is measured in dogfood and recorded in this file.
**Deps:** PM2

## PM5 — Agents as teammates

**Goal:** Agent work is dispatched, reviewed, and rendered with the same evidence discipline as human work.
**Done when:** a Ready task offers dispatch-to-agent producing a sealed `spec@sha256` brief; the Triage surface ships (drift + suggestions + review-parked + mentions + contract proposals) with the contract-review lane actionable; agent actor chips and the agent-seat view render from membership principals; the MCP gains read-only timeline/doc tools with the forbidden-tool sweep extended (still no status or pin tool).
**Deps:** PM1, PM2

## Explicitly out of scope (this epic)

- CRDT/multiplayer document editing (fork-visible LWW first; measure in dogfood).
- Growing the observation vocabulary (V3-1) or any fold/lifecycle change.
- A runner integration for agent dispatch (PM5 hands off a sealed brief).
- SLAs/escalations (`teams-collaboration` owns paging), roadmapping/Gantt.
- Public/anonymous portals; guest roles ride the membership epics.
