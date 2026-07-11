# orun-work v4 — implementation plan

Status: Normative ladder. Milestones follow the importable convention
(`orun work import` reads this file); each is independently shippable and
lands as one or more PRs with CI green. IDs are WH0–WH6.

Cross-cutting acceptance for every milestone: no delivery-lifecycle write
path is introduced at any layer (the WP-3 assertion tests extend to every
new kind, route, and tool); every mutation appends exactly one coordination
event except the two documented transactional batches (adopt, approve)
(WP-6); `approved`/`approval_revoked`/adopt are human-only server-side
(V4-2); the v2 and v3 conformance fixtures pass unmodified (V4-1); new
routes are authz-first with resource-hiding 404; the one new policy action
(`work.approve`) lands in the role maps and `ALL_KNOWN_ACTIONS` in the same
commit with the regression test.

## WH0 — The model and the oracle

**Goal:** The five-noun model exists as executable truth in `orun/internal/worklens`: vocabularies, the intent-ladder fold, rollup folds, and approval-drift semantics, with conformance fixtures the cloud fold will replay.
**Done when:** the item vocabulary gains `design` and milestone sub-item subjects (`<epic>#<key>`); the 8 new coordination kinds validate write-time (closed set; human-only kinds enforced in the model); `intentState` folds Draft/In Review/Approved/ApprovedDrifted/Adopted/Superseded from coordination events only; `ladderHash` is a canonical digest with determinism tests; rollup folds (milestone progress, epic execution, initiative health-with-evidence) compute from the unchanged v2 task fold's output; shared conformance fixtures cover intent ladders, drift, adoption, health, and pin-beside-health; the v2 fixtures pass byte-identical.
**Deps:** —

## WH1 — The substrate

**Goal:** The cloud schema, mutators, and query API for the hierarchy — designs, milestones, review/approval — behind the existing verdict seam.
**Done when:** the migration lands (work.designs, work.milestones, droppable cache columns, doc_revisions subject generalization, CHECK regen) with manifest/lock regenerated; the TS fold replays the WH0 fixtures byte-identical; mutators ship for milestone_edited/milestone_set/review_requested/review_submitted/approved/approval_revoked/design_adopted/superseded with structured verdicts (agent approve → 422; milestone remove with open tasks → 422; approve without milestones or stale revision → 422); the epics route alias, hierarchy routes, and rollup endpoints ship per design §4; work.approve lands in role maps + ALL_KNOWN_ACTIONS + regression test; the SDK grows typed clients; rebuildCaches covers the new caches (invariant-1 test extended).
**Deps:** WH0

## WH2 — The drill-down surface

**Goal:** The console renders the hierarchy end-to-end: portfolio → initiative → epic (milestone ladder) → milestone → task, with breadcrumbs, properties rails, and derived chips at every level.
**Done when:** all five levels ship as pages per design §5 with the shared page grammar (header · properties rail · children · timeline); breadcrumbs render and deep-link on every page, board card, and Cmd-K result; initiative/epic properties (owner, priority, labels, target, successCriteria) edit via item_edited; every derived value (health, progress, execution, burn-up) renders with evidence and accepts no input (V4-4 asserted in component tests); the board gains epic/milestone scope pills with drag semantics unchanged; milestone reorder ships as drag → milestone_edited{reorder}.
**Deps:** WH1

## WH3 — Designs

**Goal:** The Design noun end-to-end: authored or agent-produced, reviewable, comparable, and adoptable into epics in one attributed transaction.
**Done when:** design create/edit ships with the sealed context stamped server-side (catalog digest + log cursors); the doc chain reuses doc_revisions with fork-visible LWW; the proposal schema validates and the proposal preview renders the mint tree (epics → milestones → task skeletons); review request/verdict flows work on designs; adopt mints per design §2 in one transaction (design_adopted + item_created/milestone_edited/contract_edited, all via: adoption) with partial adoption; minted epics are Draft with proposedBy provenance rendered; supersede works and adoption never auto-supersedes; the initiative Designs rail compares two proposals side by side.
**Deps:** WH1 · WH2 (the rail) · pairs AG8 (unblocked without it: human-authored designs exercise the whole path)

## WH4 — Review and approval

**Goal:** The epic approval ladder: request review, collect verdicts (human and agent), approve human-only, seal the brief, and render drift honestly.
**Done when:** review_requested/review_submitted ship UI-to-log on epics with reviewer suggestions from teams-ownership when available; approve enforces preconditions (actor user, ≥1 milestone, current revision, minApprovals policy knob default 1) and seals EpicSnapshot in the same transaction (ladderHash + doc revision + informative tasks + catalog/log cursors); `orun epic pull <slug>[@id]` ships as the superset of spec pull with refs/work/epics refs; ApprovedDrifted renders both revision chips with a diff link and clears only on re-approval; approval_revoked works; doc/milestone edits drift approval and task churn does not (V4-5 asserted); work.review_requested/work.approved publish onto event_log for ES2 rules.
**Deps:** WH2, WH3

## WH5 — Execution handoff

**Goal:** An approved epic is implementable by an agent from the sealed brief alone: dispatch preconditions, the grown MCP, and governed task generation/regeneration per milestone.
**Done when:** the MCP gains initiative_get/design_get/milestone_get/epic_brief reads and design_propose/task_regenerate writes with task_create milestone-aware, and the forbidden-tool sweep extends (no status, pin, approve, or adopt tool — asserted); assigning an agent into an unapproved or drifted epic returns the structured dispatch verdict (human override attributed; agent/self-assign rejected server-side); task_regenerate lands as one verdict batch of cancel+create with every contract flagged into the PM5 triage lane; the acceptance run passes — an agent given only epic_brief plans and executes one milestone end-to-end with zero human free-text, its tasks/PRs/rungs attributed and observed through the unchanged delivery fold.
**Deps:** WH4 · pairs AG9 (unblocked without it: the MCP + verdicts are testable with a scripted agent)

## WH6 — Rollups and dogfood

**Goal:** The derived top of the pyramid — initiative health and portfolio — proven on this repo's own specs tree imported through the v4 mapping.
**Done when:** health(initiative) folds with named evidence and supports pin-beside-health with auto-expiry; the portfolio page ships (nothing enterable); import v4 maps epic folders → epics, implementation-plan headings → milestones, checklists → tasks, roadmap clusters → initiatives, with key-preserving migration of task-per-milestone corpora, --dry-run plans, and golden fixtures over this repo's real specs/ tree (P-4 round-trip extended); both repos' spec trees import into the dogfood workspace and the WH ladder itself renders as an epic with milestones; fold p95 on the imported corpus is measured and the budget recorded in this file.
**Deps:** WH2, WH4
**Fold p95 / budget:** recorded 2026-07-11 (WH6): the full workspace fold plus every rollup (delivery fold + per-epic intent fold + milestone/execution rollups over all 18 specs) over the orun repo's real specs tree (18 epics, 73 milestones, 73 tasks) runs in **~1.4 ms/round** in the Go oracle (`TestFoldBudgetOnDogfoodCorpus`, budget-gated at 250 ms). Lifecycle-at-read stays cheap; no materialization needed at this scale.

## Ordering

WH0 → WH1 → {WH2, WH3 in parallel} → WH4 → WH5 → WH6 closes.
WH3 pairs AG8 and WH5 pairs AG9; both are unblocked without AG (human
designs and a scripted agent exercise every path — the seams light up as AG
lands, no rework).

## Explicitly out of scope (this epic)

- Any change to the delivery fold, the task ladder, the claim join, or the
  observation vocabulary (V4-1).
- Workflow-engine approval routing (stage builders, reviewer matrices,
  conditional gates) — one lane, one knob (minApprovals).
- Gantt/date-arithmetic views; RICE/WSJF scoring fields; OKR trees.
- CRDT/multiplayer editing (fork-visible LWW stands; measure in dogfood).
- The agent runtime, sandboxes, dispatch buttons, autonomy ladder, caps,
  metering — owned by AG (v4 provides the brief, the preconditions, and the
  surfaces they render into).
- External tracker sync (Jira/Linear import beyond the repo importer).
