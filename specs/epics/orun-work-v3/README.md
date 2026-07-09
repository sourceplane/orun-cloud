# orun-work v3 — the project surface (Linear-class PM on the truth engine)

> Cross-repo epic; this repo owns nearly all of it. Builds ON v2
> (`./orun-work/`, shipped WP0–WP5) — nothing here replaces the fold, the
> logs, or the derived ladder. v3 is the intent plane growing a world-class
> authoring surface. The CLI/MCP legs live in `sourceplane/orun`
> (`specs/orun-work/`), which v3 extends but does not fork.

| | |
|---|---|
| **Status** | In progress — PM0 + PM1 shipped (cloud authoring core; conversation: threaded comments, reactions, @mentions onto the notification rail, the unified timeline); PM2 next |
| **Cluster** | **PM** (`PM0 → PM5`, plan in `./implementation-plan.md`) |
| **Builds on** | orun-work v2 (WP0–WP5, shipped): two-log substrate, fold, mutator/verdict seam, SSE tail, sealing, MCP |
| **Pairs with** | `saas-agents` + `orun-agents` (**AG** — the agent runtime + cloud control plane; PM5 renders/reviews/governs the agent work AG dispatches, it does not build dispatch), `saas-event-streaming` (ES — notification rules for mentions/subscriptions), `saas-console-ux` (U — Cmd-K, the Northwind design system), `saas-mcp-server` (MCP — the platform MCP the in-sandbox agent calls; distinct from the work MCP), `teams-collaboration` (TC — @team mentions), `saas-resources-runtime` (P2 — `revision_live`, unchanged) |
| **Inspiration** | Linear (speed, keyboard-first, initiatives/cycles/views), GitHub Issues (the timeline, threaded conversation, cross-references) |

## The one-paragraph thesis

Every project tool on the market — Linear included — is a beautiful database
of **claims**: someone drags a card to Done and the tool believes them, and
keeping the claims honest is a human tax paid weekly. v2 built the half
nobody else has: a delivery column that **cannot lie** (lifecycle is a fold
over two append-only logs; there is no status write anywhere). v3 builds the
half everyone else has: fast, delightful authoring of *intent* from the cloud
UI — create and edit epics, write spec documents, comment in threads, plan
cycles, save views — with Linear's speed and GitHub's conversation. The one
rule that survives untouched: **you author intent, you observe fact.** The
pitch in one line: *Linear's speed, GitHub's thread, orun's truth — the plan
is editable and the progress is not.*

## The five nouns (v2 had two)

| Noun | What it is | Authored where | Lifecycle? |
|---|---|---|---|
| **Initiative** | Strategic grouping of specs (Linear's initiatives) | Cloud UI | Progress derived from member specs |
| **Spec** | Now a first-class *document*: versioned, content-addressed body + task contracts | Cloud UI **or** repo import — both stay first-class | Progress derived from member tasks |
| **Task** | Unchanged from v2: a contract; rung derived | Cloud UI, CLI, MCP | Derived (the v2 fold, untouched) |
| **Cycle** | An authored time-box | Cloud UI | Burn-up derived — never entered |
| **View** | A saved filter/board/list configuration, shareable | Cloud UI | n/a |

## The honest-gesture table

Each "obvious" PM feature has an honest version under the v2 invariants.
This table is the design's spine — when in doubt, extend it, don't break it:

| Linear/GitHub gesture | The honest version here |
|---|---|
| Drag card across board columns | Columns are rungs; the drag **mints a pin** — a public, attributed override rendered *beside* observed truth, auto-expiring when facts catch up. The board may show "Rahul says Done — evidence says In Review". |
| Drag card within a column | Backlog ordering — the existing `ordered` coordination event. Pure intent, no ceremony. |
| The issue timeline | Interleave the two logs by time. "Sara commented → branch seen → PR #42 opened → gate `tests` green → merged → live in prod." Zero new storage; the substrate *is* the timeline. |
| Project progress bar / cycle burn-up | Derived from the fold (merges with green gates), not from status hygiene. The first progress chart that can't be gamed by moving cards on a Friday. |
| Estimates, priority, labels, assignee | Pure intent — author freely. These were never the lie; status was. |
| Close an issue by hand | Cancel (authored, off-ladder) or pin Done (attributed, beside truth). "Done because I said so" is always visibly someone saying so. |
| Weekly project status update | The timeline **is** the update. We refuse the ritual. |

## Invariants (v2's carried forward + v3's new)

Carried verbatim from v2 — these are the product:

- **WP-3** No stored status. No lifecycle-write event kind exists; enforced by
  the schema CHECK on `work.events.kind`, the repository interface, the HTTP
  routes, the SDK, and the MCP tool surface — asserted by test at every layer.
- **WP-6** One mutator surface; exactly one coordination event per mutation.
- **WP-10** Agents cannot pin (server-side 422, not client-side trust).
- **P-7** Honest degradation: unknown gates park In Review, never Done.

New for v3:

- **V3-1 Intent grows, fact doesn't.** Every new event kind must be intent
  (a human/agent decision) or conversation. The observation vocabulary (6
  kinds) does not grow in this epic.
- **V3-2 Documents are content-addressed revisions.** A spec's cloud document
  is an append-only chain of sha256-addressed revisions in the same digest
  form v2's `doc_ref` already carries (`sha256:<hex>`), so `orun spec pull`
  seals against a cloud revision exactly as it seals against a repo README —
  one canonicalizer, one determinism contract, no new sealing path.
- **V3-3 Derived numbers are not editable.** Progress, burn-up, velocity,
  throughput render from the fold. No surface accepts a correction to them;
  the correction is a pin, and pins are attributed.
- **V3-4 No new policy actions without the registry.** v3 reuses
  `work.read`/`work.write` for the entire surface. If a future slice truly
  needs a new action, it lands in the role maps **and** `ALL_KNOWN_ACTIONS`
  in the same commit, with the regression test — the Work-page-404 incident
  (policy denied `unknown_action` → resource-hiding 404) does not repeat.
- **V3-5 Repo import stays first-class.** Docs-as-code teams keep authoring
  in git; `orun work import` remains idempotent and lifecycle-free. Cloud
  authoring is an addition, not a migration.

## What exists today (the reality this builds on)

Shipped and load-bearing, all of it reused rather than rebuilt:

- **The substrate** (`560_work_foundation_v2`, `@saas/db/work`): two logs,
  CHECK-closed vocabularies (9 coordination kinds / 6 observation kinds),
  fold caches rebuildable from the coordination log alone (invariant 1),
  `dedupe_key` idempotency, per-org sequences.
- **The mutator/verdict seam** (`apps/state-worker/src/handlers/work.ts`):
  authz-first resource-hiding, structured 422 verdicts the UI renders inline.
- **The SSE tail** (`GET …/work/events/stream`): bounded legs, `id:`=seq
  resume, console streams-first with poll fallback. New event kinds ride it
  with zero transport work.
- **Ingesters** (WP2/WP3): webhook drain → `pr_*`/`branch_seen`; run stream →
  `gate_result`; the `revision_live` bridge (P2-gated call site).
- **Sealing + `orun spec pull --push`** (orun repo): canonical bytes, content
  ids, the `refs/work` remote spine.
- **The MCP** (orun repo): 3 reads with evidence + 4 writes, no status/pin
  tool, `contract_propose` applies AND flags for review.
- **Notification rules** (ES2, `apps/events-worker`): multi-segment globs,
  severity, throttle windows — the delivery rail PM1 mentions ride.
- **Console + the Northwind design system** (`apps/web-console-next`): the
  Work page (rung badges with evidence, pins beside truth, drift inbox,
  comment/pin forms), the session SDK client, the Northwind primitives
  (Screen / PageHeader / ListCard / Pill), scope-in-URL, Cmd-K (saas-console-ux).
- **The agent framework** (cluster **AG**, authored while v2 shipped):
  `orun/specs/orun-agents/` (the runtime — agent types as content-addressed
  objects, the delegation loop, sealed session proof) and
  `saas-agents/` (the cloud control plane — sandboxes, session identity, the
  Agents tab, design runs, dispatch-is-assignment, the autonomy ladder). Both
  already build on this work plane's four-tool agent surface and no-status-write
  invariant. PM5 is the *project surface* they render into — see below and
  design §4; v3 owns none of the runtime or dispatch machinery.

## What we refuse to copy

- **Manual status** — obviously; it's the product.
- **Status-update rituals** — the timeline is the update.
- **Velocity as a managed number** — we show derived throughput; nobody edits it.
- **A "GitHub sync" mirror** — delivery facts are ingested natively into the
  observation log; there is no second source of truth to drift.
- **Private boards** — views are shareable by default; work is a shared fact.

## Milestones

The ladder is PM0 → PM5, each independently shippable, plan in
[`implementation-plan.md`](./implementation-plan.md):

| ID | Milestone | One line |
|----|-----------|----------|
| PM0 | Cloud authoring core | Create/edit initiatives, specs, tasks from the console; versioned spec documents |
| PM1 | Conversation | Threaded comments, mentions, reactions; the unified timeline; notification wiring |
| PM2 | Board & views | Kanban by rung (drag = pin/order), filters, saved views, labels/priority/estimates |
| PM3 | Cycles & derived progress | Authored time-boxes; burn-ups and rollups from the fold |
| PM4 | Flow | Cmd-K verbs, optimistic apply with verdict rollback, keyboard-first, realtime everywhere |
| PM5 | The agent project surface | Render/attribute/review/govern agent work in the board — assignable agent seats, session-state chips (infra, not rungs), the contract-review Triage lane, timeline attribution. Pairs **AG**; owns no dispatch/runtime |

Architecture detail (schema deltas, event vocabulary growth, API routes,
UI structure, compat): [`design.md`](./design.md).
