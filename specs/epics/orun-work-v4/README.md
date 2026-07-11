# orun-work v4 — the planning hierarchy (Initiative → Design → Epic → Milestone → Task)

> Cross-repo epic; this repo owns most of it (schema, mutators, API, console).
> The oracle/CLI/MCP legs live in `sourceplane/orun`
> (`specs/orun-work-v4/`). Builds ON v2 (`../orun-work/`, shipped WP0–WP5)
> and v3 (`../orun-work-v3/`, shipped PM0–PM5) — nothing here replaces the
> two logs, the fold, or the derived delivery ladder. v4 gives **intent
> itself** a shape and a lifecycle: work is created top-down through five
> primitives, designs are first-class artifacts, and epics carry an authored
> review/approval ladder that seals a frozen brief an agent can implement
> without asking a human anything.

| | |
|---|---|
| **Status** | **Draft — design locked, ready for review** |
| **Cluster** | **WH** (`WH0 → WH6`, plan in [`implementation-plan.md`](./implementation-plan.md)) |
| **Repos** | `sourceplane/orun-cloud` (schema, mutators, query API, console drill-down) · `sourceplane/orun` (worklens oracle, hierarchy fold, import, `orun epic pull`, MCP tools) |
| **Builds on** | orun-work v2 (WP0–WP5, shipped): two-log substrate, derived delivery ladder, mutator/verdict seam, sealing, MCP · orun-work v3 (PM0–PM5, shipped): initiatives, versioned spec documents, conversation, board/views, cycles, the agent project surface |
| **Pairs with** | `saas-agents` + `orun/specs/orun-agents/` (**AG** — AG8 design runs get a durable home: the Design noun; AG9 dispatch-is-assignment hands the agent the sealed `epic@hash` brief), `saas-event-streaming` (ES — review-request/approval notifications), `saas-console-ux` (U — breadcrumbs, Cmd-K, Northwind), `teams-ownership` (TO — owner defaults) |
| **Inspiration** | Linear (initiatives/projects/milestones, properties, the feel), Aha! (strategy → design → delivery traceability, health), Shape Up (the pitch/bet cadence), GitHub (review → approve → merge as the approval grammar) — **but the honest versions of all of them** |
| **Decisions locked** | (V4-A) five nouns, two ladders — intent lifecycle is **authored** (review/approve are human decisions the world cannot observe, exactly like v2's Canceled), delivery lifecycle stays **derived** (the v2 fold, untouched); (V4-B) Design is a first-class noun — the durable output of a design run (AG8) or a human authoring session, sealed against context, adoptable into epics; (V4-C) Epic is the surface name of the v2 `spec` kind (alias, not migration) — the spec document is what the epic *knows*, the epic is the unit that gets reviewed, approved, and dispatched; (V4-D) Milestones are addressable sub-items of an epic (`<epic>#<key>` subjects), matching the repo's own `implementation-plan.md` convention that WP/PM/WH ladders already dogfood; (V4-E) approval is human-only and content-addressed — `approved` names the doc revision + minted `EpicSnapshot`; agents may review, never approve (extends WP-10); (V4-F) tasks are regenerable implementation detail — task churn under an approved epic never invalidates approval; doc/milestone changes make **approval drift** visible instead |
| **Milestone prefix** | **WH** |

## The one-paragraph thesis

v2 built the half no tracker has: delivery lifecycle that cannot lie (a fold
over two append-only logs; no status write exists anywhere). v3 built the
half every tracker has: fast authoring of intent. What neither built is a
**shape for intent itself** — today a spec appears fully formed, and the path
from "a business objective" to "a brief an agent can execute" lives in
people's heads and in ad-hoc design runs. v4 gives that path five primitives
and one governing rule. **Initiative** (the why, human-authored) →
**Design** (the what: a living document + a structured proposal, produced by
humans and AI together, sealed against the context it assumed) → **Epic**
(the reviewable, approvable, dispatchable unit) → **Milestone** (the
checkpoint ladder inside an epic — the WP0→WP5 convention this repo already
lives by, promoted to a primitive) → **Task** (the v2 atom, unchanged,
regenerable by AI as the design evolves). The governing rule is the same one
that built v2: split by truth source. Review and approval are *decisions*,
so they are authored, attributed coordination events; progress and health
are *facts*, so they are folds nobody can edit. The flow in one line:
**humans define the initiative → humans and AI design → AI proposes epics →
humans approve (which seals the brief) → AI executes milestones by
generating tasks — and every claim on every screen names its truth source.**

## The five nouns (v3 had five; v4 swaps the set)

| Noun | What it is | Authored by | Intent lifecycle (authored) | Delivery lifecycle (derived) |
|---|---|---|---|---|
| **Initiative** | A business objective or problem — the *why*. Owns designs and epics. | Humans | exists / canceled | **Health** (on-track · at-risk · off-track) + progress, folded from member epics — never a dropdown |
| **Design** | A living product+technical specification — the *what*. A doc revision chain + a structured **proposal** (epics → milestones → task skeletons), sealed against the context it assumed (`catalog@hash`, log cursors). Many designs per initiative; alternatives are cheap. | Humans + AI (AG8 design runs land here) | Draft → In Review → **Adopted** \| Superseded | n/a (a design has no delivery; its epics do) |
| **Epic** | The reviewable, executable capability — the unit a human approves and an agent implements. Surface name of the v2 `spec` kind; carries the spec document, the milestone ladder, and the approval record. | Minted by adopting a design, or authored directly | Draft → In Review → **Approved** (@doc-revision, sealed `epic@hash`) → Approved *(drifted)* on later edits | Execution rollup folded from milestones (the v2 ladder per task) |
| **Milestone** | A meaningful checkpoint inside an epic — ordered, independently shippable, with its own goal and done-when. `WP0…WP5` as schema. | Humans + AI (inside the design/epic) | exists / edited / removed (epic-level approval covers them) | Progress folded from member tasks; burn-up |
| **Task** | The v2 atom: title + contract, rung derived. Now carries a `milestone` and is **regenerable** — AI creates and re-creates tasks for a milestone as the design evolves. | Humans, CLI, MCP — and agents, in bulk, per milestone | exists / canceled | The v2 ladder, byte-identical: Draft → Ready → In Progress → In Review → Done → Released |

v3's Cycle and View survive unchanged (time-boxes and saved filters are
orthogonal to the hierarchy). v3's Initiative — envelope-only, member specs
via `related` — is what v4 promotes into the top of the ladder.

## The two ladders (the design's spine)

v2's founding move was to split *fact* from *opinion* and refuse to store
the former. v4 applies the same split to planning:

```
INTENT (authored — decisions; the world cannot observe them)
  Initiative:  exists ──────────────────────────────▶ canceled
  Design:      Draft ──▶ In Review ──▶ Adopted | Superseded
  Epic:        Draft ──▶ In Review ──▶ Approved@rev ──▶ (edits ⇒ Approved, drifted)
                              ▲                │
                    review_submitted           │ approval seals EpicSnapshot
                    (humans AND agents)        ▼ (the frozen agent brief)
DELIVERY (derived — facts; nobody can author them; the v2 fold, untouched)
  Task:        Draft → Ready → In Progress → In Review → Done → Released
  Milestone:   progress = fold(member tasks)
  Epic:        execution = fold(milestones)
  Initiative:  health + progress = fold(member epics vs targets)
```

- **Review and approval are coordination events** (`review_requested`,
  `review_submitted`, `approved`, `approval_revoked`) — attributed, append-
  only, rendered with actors. They are authored for the same reason v2's
  Canceled is authored: the world cannot know you decided.
- **Approval is content-addressed.** The `approved` event names the doc
  revision it approved and the `EpicSnapshot` it sealed. "Approved" never
  renders without *of what*: the revision chip is part of the state.
- **Approval drift, not approval locks.** Intent stays editable forever.
  Editing the doc or the milestone ladder after approval folds the epic to
  *Approved (drifted)* — approved@rev ≠ current — rendered as both chips
  until a human re-approves. Task churn does **not** drift approval (V4-F):
  tasks are implementation detail; the doc + milestones are the contract.
- **Delivery stays untouchable.** No new observation kinds, no fold changes
  to the task ladder, and the v2/v3 conformance fixtures pass byte-identical.
  Every rollup (milestone progress, epic execution, initiative health) is a
  fold; no surface accepts a correction to any of them; the correction is a
  pin, and pins render beside truth (v2 invariant 6, generalized upward).

## The honest-gesture table (extended from v3)

| Linear / Aha! / Jira gesture | The honest version here |
|---|---|
| Initiative health dropdown (green/yellow/red, set in a Friday meeting) | Health is a **fold**: epic execution vs target dates, blocked flags, drift. A human may pin health with a note; the pin renders *beside* the derived value and auto-expires when facts catch up. |
| "Break this down into epics" (a human typing into a modal) | A **design run**: human or agent authors a Design against sealed context; the proposal renders as a reviewable diff of the hierarchy it would mint; adoption is one attributed event that creates the epics. Run three designs, compare them, adopt one — alternatives are artifacts, not chat scrollback. |
| Epic status field (someone remembers to set "In Development") | Intent state is the authored approval ladder (who approved what revision, when); execution is the fold over milestones. Two chips, two truth sources, both named. |
| Milestone checkbox lists in a wiki page | Milestones are addressable sub-items: own page, own timeline, own derived burn-up; `orun work import` maps this repo's `implementation-plan.md` headings straight onto them. |
| "AI, write me some tickets" pasted from a chatbot | Task generation is a governed MCP write: tasks land under a milestone, attributed to the agent, contracts flagged through the existing v3 triage review lane. Regeneration is cancel+create, visible in the timeline. |
| Sign-off in a Slack thread | `approved` — attributed, content-addressed, sealing the exact brief the agent will implement. The approval **is** the dispatch artifact. |
| Roadmap slideware | The initiative portfolio: derived health, derived progress, owner, target — a screen that is *always* current because nothing on it is entered. |

## Invariants (v2's + v3's carried forward, plus v4's)

Carried verbatim — these are the product: **WP-3** (no stored delivery
status; no lifecycle-write event kind exists, asserted at every layer),
**WP-6** (one mutator surface; exactly one coordination event per mutation),
**WP-10** (agents cannot pin — server-side), **V3-1** (the observation
vocabulary does not grow), **V3-3** (derived numbers are not editable).

New for v4:

- **V4-1 The delivery fold is frozen.** No change to the task ladder, the
  claim join, or the observation vocabulary. The v2/v3 conformance fixtures
  pass unmodified; rollups are new folds *over* the old fold's output.
- **V4-2 Approval is authored, attributed, human-only, content-addressed.**
  `approved` requires an actor of type `user` (server-side 422 for agents —
  the same defense-in-depth as agent pins), and names `{docRevision,
  snapshot}`. Agents may author `review_submitted` (their verdict is advice,
  rendered with an agent chip); they may never author `approved` or
  `approval_revoked`. The MCP grows no approve tool — the forbidden-tool
  sweep extends.
- **V4-3 Drift is visible, never blocking.** Post-approval edits to the doc
  or milestone ladder render *Approved@rev (drifted)*; only re-approval
  clears it. Nothing prevents the edit — the tracker never locks intent, it
  tells the truth about staleness.
- **V4-4 Designs are durable and their adoption is frozen.** Adoption mints
  epics from the proposal at a named design revision, in one batch
  (`design_adopted` + `item_created`/`milestone_edited` events, `via:
  adoption`). The design page forever shows what was adopted; a design is
  never silently mutated into agreement with what shipped.
- **V4-5 Tasks are regenerable; epics and milestones are durable.** Agents
  may cancel-and-recreate tasks under a milestone (attributed, timeline-
  visible, contracts flagged for review); this never drifts approval. Doc
  and milestone edits do (V4-3).
- **V4-6 One digest form, one sealing path.** Design docs and epic docs use
  the v3 `sha256:` revision chain; `EpicSnapshot` extends `SpecSnapshot`
  additively (milestones join the closure); `orun spec pull` keeps working
  unmodified and `orun epic pull` is its superset.
- **V4-7 Hierarchy is edges, not partitions.** `partOf` edges in the catalog
  graph (Task→Milestone→Epic→Initiative, Design→Initiative) — WP-5's
  discipline. Keys stay workspace-scoped (WP-7); an epic can serve two
  initiatives no more than a task can — `partOf` is single-parent, `related`
  stays free-form.

## What we refuse to build

- **A stored status for anything the platform can observe** — still the product.
- **Approval as workflow-engine ceremony** — no multi-stage gate builder, no
  required-reviewer matrices, no conditional transitions. One review lane,
  one human `approved` event, one policy knob (min approvals, default 1).
  Teams that need SOX-grade routing can build it *on* the log, later.
- **A Gantt chart** — dependencies render as blocked-flags and the milestone
  ladder; date arithmetic theater is somebody else's product.
- **Weighted scoring frameworks (RICE/WSJF fields)** — priority stays the
  v3 five-level intent field; scoring rituals are opinions about opinions.
- **Cross-hierarchy WIP mirroring** — an initiative in workspace A cannot
  contain epics from workspace B (WP-7; `related` edges may point anywhere).
- **A second document store** — designs reuse `work.doc_revisions` and the
  v3 fork-visible-LWW policy verbatim.

## Milestones

The ladder is WH0 → WH6, each independently shippable, plan in
[`implementation-plan.md`](./implementation-plan.md):

| ID | Milestone | One line |
|----|-----------|----------|
| WH0 | The model + the oracle | Vocabularies (5 nouns, 8 new event kinds), the intent-ladder fold, rollup folds, approval-drift semantics — in `orun/internal/worklens` with shared conformance fixtures |
| WH1 | The substrate | Migration (designs, milestones, droppable cache columns, CHECK regen), mutators + verdicts (human-only approve), routes, SDK |
| WH2 | The drill-down surface | Initiative portfolio → initiative page → epic page (milestone ladder) → milestone page → task page; breadcrumbs; properties rails; scoped boards |
| WH3 | Designs | The Design noun end-to-end: doc chain, structured proposal + preview, review thread, adopt-mints-epics; the AG8 "Design" button lands its output here |
| WH4 | Review & approval | The review lane, human-only approval sealing `EpicSnapshot`, `orun epic pull`, drift rendering, re-approval |
| WH5 | Execution handoff | Dispatch approved epics (AG9 assignment with the sealed brief), MCP growth (`epic_brief`, `design_propose`, milestone-aware `task_create`), task generation/regeneration through triage |
| WH6 | Rollups + dogfood | Initiative health/progress folds, portfolio view, import v4 (this repo's `specs/` tree lands as initiatives/epics/milestones/tasks), fold-budget + p95 notes |

Architecture detail (schema deltas, event vocabulary, approval semantics,
API routes, console IA, agent binding, compat):
[`design.md`](./design.md). Decision ledger and open questions:
[`risks-and-open-questions.md`](./risks-and-open-questions.md).
