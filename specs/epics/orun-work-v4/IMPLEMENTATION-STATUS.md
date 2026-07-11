# Implementation Status (as-built)

> As-built ≠ intent. This file records what has actually shipped, kept
> distinct from the design/plan docs. Each milestone links the PR(s) that
> landed it. (The v2 dogfood gate that retires tables like this one applies
> here too: it retires when both repos' spec trees import into a live
> workspace and the WH ladder renders itself.)

## Milestones

| ID | Milestone | Status |
|----|-----------|--------|
| WH0 | The model + the oracle | ✅ Shipped — orun #489: `internal/worklens` gains the design kind, milestone sub-item subjects (`<epic>#WH2`), 8 new coordination kinds (19→27; approved/approval_revoked/design_adopted/superseded human-only at write time — V4-2), the intent-ladder fold (Approved@revision / ApprovedDrifted re-derived from the log, never trusted from a payload), `LadderHash`, rollup folds (milestone progress, epic execution, initiative health with named evidence + pin-beside-health), and `fixtures/hierarchy-conformance.json`. The v2 conformance fixtures pass byte-identical (V4-1) |
| WH1 | The substrate | ✅ Shipped — orun-cloud #418: migration `700_work_v4_hierarchy` (work.designs, work.milestones, envelope property columns, 27-kind CHECK; **no intent-state/approval/progress/health column exists anywhere**), the TS folds replaying the shared fixtures byte-identical, mutators with verdicts (agent approve → 422 `human_only`; milestone remove with open tasks → 409; stale-revision approve → 409), the `/work/epics` alias (V4-C), hierarchy routes + rollups endpoint, `work.approve` in role maps + `ALL_KNOWN_ACTIONS` in the same commit, SDK surface, `rebuildCaches` extended (invariant 1) |
| WH2 | The drill-down surface | ✅ Shipped — orun-cloud #419: `/work/initiatives` portfolio (nothing enterable), initiative page (Designs rail · epics table with intent+execution chips), epic page (intent chip pair with drift rendered loud, milestone ladder editing with inline verdicts, unscheduled section), milestone page (goal/done-when/tasks/progress), catch-all routes for imported path-like keys, breadcrumbs + entry links |
| WH3 | Designs | ✅ Shipped — orun-cloud #420: the design page (sealed-context line, doc chain on the design itself — V4-6, proposal preview as the exact mint tree with partial-adoption checkboxes, review verdicts, attributed activity timeline), Adopt (human-only + `work.approve`; minted epics are Drafts) and Supersede (record kept — V4-4), + New design on the initiative page. Substrate legs (create/adopt/supersede/doc-chains) landed in WH1 |
| WH4 | Review & approval | ✅ Shipped — orun-cloud #421 + orun #490: migration `710_work_v4_snapshots` (content-addressed EpicSnapshot storage), `approve()` seals **in the same transaction** as the approved event and stamps the snapshot id (the approval IS the dispatch artifact), `GET …/epics/{key}/brief`, the console approval panel (disabled-with-reason before the click; Re-approve clears drift), ES2 publishes (`work.epic.approved`, `work.review.requested`), and `orun epic pull` (fetch → verify sha256(bytes)==id → read-only `.orun/epics/<slug>/` view + BRIEF.md; `--push` on the refs/work/epics spine). No second canonicalizer exists: the cloud seals, Go parses |
| WH5 | Execution handoff | ✅ Shipped — orun-cloud #422 + orun #491: dispatch preconditions (agent seat into a non-Approved epic → 422; human override WITH a note rides the attributed event; agents can never override), `regenerateTasks` (planned tasks cancel, in-flight survive — Q-6 answered; agent contracts applied AND flagged into the PM5 triage lane), the MCP grows 9→15 tools (`epic_brief` verified before it reaches the agent, `design_propose`, `task_regenerate`, hierarchy reads) with the forbidden-name sweep extended to `approve`/`adopt` (an agent cannot even name the decision), and the acceptance run as a test: an agent works a milestone end-to-end from the sealed brief with zero human free-text |
| WH6 | Rollups + dogfood | ✅ Shipped — orun-cloud WH6 PR + orun WH6 PR: import v4 (roadmap clusters → initiatives; implementation-plan headings → ladder milestones with the v2 task-per-milestone mapping preserved 1:1 underneath; dotted sub-milestone ids degrade to task-only, visibly), the **key-preserving migration** (pre-v4 imported tasks move into the new ladder by key — same task keys, one milestone_set each, nothing re-created), initiative filing at spec creation, and the fold budget recorded (~1.4 ms/round over the real 18-epic corpus). Remaining for the dogfood gate: the live `orun work import` of both repos' spec trees into a production workspace |

## Design rules held throughout (asserted by test at every layer)

- **No stored fact, still.** No intent-state, approval, progress, or health
  column exists; every chip on every page is a fold. Drop the caches, replay
  the logs, get identical reads.
- **Two ladders, split by truth source.** Review/approve/adopt are authored,
  attributed, human-only decisions; the delivery fold and the observation
  vocabulary are byte-identical to v2 (the v2 conformance fixtures never
  changed).
- **The approval is the dispatch artifact.** `approved{revision, snapshot}`
  seals in the same transaction; `orun epic pull` and the MCP's `epic_brief`
  verify content addressing — there is no second canonicalizer to drift.
- **Agents propose; humans decide.** design_propose/task_regenerate apply
  AND flag; approve/adopt are unrepresentable in the agent tool surface and
  rejected server-side twice over.
