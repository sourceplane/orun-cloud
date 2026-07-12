# saas-agents-fleet — Implementation Plan (AF4–AF9, the cloud half)

The cloud-owned milestones. The spawn/await tool semantics, orchestrator +
judge session modes, the routine object kind, and the track-record fold
(AF0–AF3) live in `orun/specs/orun-agents-fleet/implementation-plan.md`.
Design refs are to `design.md` (§) here.

The cross-repo coupling stays file-shaped (the AL discipline): orun AF0–AF3
freeze their outputs as fixtures — sealed sessions containing
`child_spawned`/`child_*` events, `RoutineSnapshot` objects, record-fold
JSON — vendored into `packages/contracts`, so every milestone below builds
against a fake runtime replaying them. Only final verification needs a live
sandbox. **AF5 needs nothing from orun at all** and ships first.

---

## AF5 — The attention plane — 🗓️ Planned

- The needs-you fold: `GET …/agents/attention` in agents-worker — a
  computed read joining session states, budget marks (zero until AF8;
  the source enum ships complete), routine parks (zero until AF6), lease
  degradation, and retryable failures, each item carrying provenance
  (§4.1). `agent.session.read`-gated; api-edge facade + SDK.
- The fleet home rebuilt to the mock (§2.1): stat pair, quick-spawn card
  with consent caption, the `NEEDS YOUR VERDICT` queue posting attach-v1
  verdicts directly (the fleet home becomes a head), active/recent rows
  with token/minute columns, profiles, providers. Truth captions verbatim
  from §2.1.
- The topbar + sidebar attention badge; the daily digest via
  notifications-worker (quiet hours respected); AL8's unattended-verdict
  push unchanged beneath it.

**Done when:** every attention item on a fixture fleet renders with its
provenance and disappears when its fact goes false (no dismiss affordance
exists); a verdict answered from the fleet home lands in the session's
sealed log attributed identically to one answered on the session page; the
badge count equals the fold everywhere it renders; one digest per day per
subscriber, none when the fold is empty.

## AF4 — The delegation plane — 🗓️ Planned

- Migration: `parent_session_id` / `root_session_id` / `depth` on
  `agent_sessions` (additive, self-referencing, root = self/0); repo
  methods for tree reads + live-descendant counts.
- The spawn door: `agent.session.spawn` policy action; the gate stack in
  the sessions/dispatch handler — ceiling intersection (set math over the
  sealed contracts, applied ceiling returned + sealed), depth ≤ 2, width
  caps per parent/tree, envelope check (stub until AF8) (§3.1).
- Tree lifecycle: tree-transitive kill (leaf-up, best-effort destroy,
  sweep finishes); the orphan sweep extension (child alive past terminal
  parent + grace → `failed(orphaned)`) (§3.2).
- Console: the children strip + `Kill tree` on the session page; tree
  gutter rows on the fleet home; judge verdict cards folding from the
  parent's `child_*` events (§2.2).

**Done when:** a fixture orchestrator spawning three children yields
correct tree rows, an intersected ceiling sealed in both logs, and a
refusal (not a silent widen) on an out-of-ceiling request; width/depth
overflows refuse at the door; `Kill tree` on the root terminates the
subtree and the sweep collects a deliberately-orphaned child; the parent's
page renders the fan-out from its own sealed events only.

## AF6 — Routines — 🗓️ Planned

- `agents.routines` migration + repo (definition ref by content hash,
  profile, trigger `cron|event`, budget ref, enabled, park state);
  CRUD routes (`agent.routine.read|write`), api-edge + SDK; the console
  registry surface (routine rows with last-firing line, definition hash,
  enable/resume).
- The scheduler tick (generalizing the `*/5` cron) evaluating cron
  triggers; the ES1 lane consumer for event triggers with
  re-check-against-the-fold before firing (poll fallback until ES1)
  (§5.1) — closing the AG9 lane-consumer remainder.
- Firing → the AG9 dispatch door with routine provenance; session rows
  carry `routine_id`; fleet grouping (§5.2).
- Quiet outcomes → the AF5 digest; two consecutive failures → `parked` +
  attention item + `task_comment` where task-bound; misfire-once-on-
  recovery semantics (§5.3).

**Done when:** a fixture cron routine fires through the dispatch door with
every gate observed and shows up grouped on the fleet home; an event
routine whose predicate went stale between doorbell and re-check does not
fire; two failed firings park it, produce exactly one attention item, and
a human resume re-arms it; a routine's successful night is one digest line
and zero notifications.

## AF7 — Track record & earned autonomy — 🗓️ Planned

- The record read: orun AF3 fold fixtures joined with cloud facts (IG PR
  outcomes, meters, verdict history) into the per-profile record (§6.1);
  cached computed read, `GET …/agents/profiles/{id}/record`; SDK.
- Console: the profile page centerpiece (named rates, numerators
  clickable to their sessions), fleet record chips (§2.1).
- Movement: the promotion bar as workspace config; suggestion cards with
  the record snapshot attached; human-ack apply writing profile/policy +
  `agent.autonomy.promoted {evidence}`; automatic demotion on the three
  triggers + `agent.autonomy.demoted {trigger}` (§6.2); autonomy write
  actions grantable to humans only, asserted by test.
- Settings render every non-default autonomy with its address (promoted
  when/by/on-what-evidence).

**Done when:** a fixture profile crossing the bar produces exactly one
suggestion whose evidence matches the record read; applying it audits with
the snapshot; a containment-event fixture demotes without human action and
lands one attention item; no route reachable by a service-principal actor
can write any autonomy field (negative tests across API, MCP, dispatch).

## AF8 — Budgets — 🗓️ Planned

- `agents.budgets` migration + repo (grain: session|tree|routine|
  workspace; tokens and/or minutes; cascade resolution workspace →
  profile → spawn); routes + SDK + spawn-dialog and routine-form fields.
- Door enforcement: spawn/dispatch refuse on an unfittable envelope
  (`budget_exhausted`, the loud-at-the-gate posture); tree spawns draw
  the root's envelope (§7).
- Ingest enforcement: the AL9 cost aggregation accumulates against live
  envelopes; 80% → attention mark; 100% → graceful interrupt on the DO
  return queue → runtime seals `budget_exhausted` and completes (fixture:
  partial state sealed, resumable) (§7).
- Usage & quota: the fleet forecast strip (spend by profile/routine,
  meters, month-end projection); the `BUDGET` rail block on the session
  page (§2.2, §2.3 meter token).

**Done when:** a spawn over the envelope refuses at the door with the
upgrade/raise path in the payload; a fixture tree crossing 80% raises
exactly one attention mark and crossing 100% completes every live node
gracefully with partial state sealed (nothing lands `killed`); the
workspace backstop caps a runaway routine within one scheduler tick; the
forecast strip's projection matches the fixture meters' arithmetic.

## AF9 — Hardening + evals — 🗓️ Planned

- Hostile-orchestrator fixtures: a prompt-injected parent attempts
  ceiling-widening, depth/width evasion (spawn-through-child storms), and
  budget circumvention — observed containment at the door, in the counts,
  and in the envelope (§9).
- Routine injection posture: hostile repo content reaching a routine's
  brief cannot alter its sealed definition, trigger set, or autonomy;
  parked-routine and demotion paths fire as designed.
- The runaway-tree drill: kill-the-root under partial sandbox failure;
  the sweep converges the stragglers; the incident runbook documents the
  drill.
- The §10 acceptance narrative as an end-to-end test suite over fixtures,
  plus the live-Daytona verification pass (jointly with orun AF0–AF3
  final verification).

**Done when:** every hostile fixture is contained with the specific
refusal audited; the drill converges within two sweep periods with zero
sealed-log loss; the §10 narrative passes green as a suite; the runbook
review is signed off.

---

## Sequencing note

**AF5 → AF4 → AF6 → AF7 → AF8 → AF9**, with AF5 deliberately first: it is
pure fold-and-render over shipped state, it delivers the mock's fleet home
(the visible product moment) with zero orun dependency, and its source enum
gives AF6/AF8 their attention seams to land into. AF4 unblocks on orun
AF0's fixture freeze; AF6 on AF2's routine snapshots (its scheduler +
lane work is orun-independent and can start early); AF7 on AF3's fold
fixtures. AF8 threads through everything and lands once trees and routines
exist to budget. AF9 is the exit bar. The headline demo is §10's
design-competition + routine + promotion week; AF5's fleet home is that
story's stage.
