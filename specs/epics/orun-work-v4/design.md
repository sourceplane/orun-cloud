# orun-work v4 — design

Status: Normative for WH0–WH6. Builds on the v2 substrate and the v3 intent
plane (`../orun-work/`, `../orun-work-v3/`, both shipped); nothing below
changes the task fold, the delivery ladder, or the observation vocabulary.

## 0. Design stance

Three consequences run through every section, in the same spirit v3 set:

1. **Additive, never destructive.** Every v2/v3 surface — schema, routes,
   SDK, CLI, MCP, fixtures — keeps working byte-for-byte. v4 is new nouns,
   new event kinds, new tables for authored intent, new folds *over* the old
   fold's output, and a much deeper console.
2. **Split by truth source, again.** v2 split delivery (observed) from
   coordination (authored). v4 applies the identical knife to planning:
   review/approval/adoption are *decisions* → coordination events; progress,
   drift, and health are *facts about the plan's contact with reality* →
   folds. No new plane is invented; the two logs absorb everything.
3. **The hierarchy is edges + folds, not machinery.** Initiative, Design,
   Epic, Milestone, Task relate through `partOf`/`hasDesign` edges and roll
   up through folds. There is no "hierarchy engine", no denormalized tree
   table, no cascade logic — drop every cache, replay the logs, get the tree.

## 1. Model deltas

### 1.1 Item kinds (3 → 4) and sub-items

The closed item vocabulary `{initiative, spec, task}` grows by one:
**`design`**. Two surface decisions ride along:

- **Epic is the surface name of `spec`** (V4-C). The wire kind stays `spec`
  (no data migration, no broken clients); API routes, SDK method names, and
  the console say *epic*, and `…/work/epics/*` routes alias `…/work/specs/*`
  1:1. The document is what the epic knows; the epic is the unit that gets
  reviewed, approved, and dispatched. `orun work list` output relabels;
  nothing else in the CLI changes.
- **Milestones are addressable sub-items, not a fifth item kind.** A
  milestone lives inside exactly one epic and is addressed as
  `<epic-key>#<milestone-key>` (e.g. `sourceplane/specs/orun-work-v4#WH2`).
  Coordination events (comments, edits) target that subject string — the
  logs already treat `subject` as an opaque key, so milestones get
  timelines, comments, and SSE liveness with zero transport or log changes.
  Milestone keys are epic-scoped, human-authored, immutable once created
  (`[A-Z]{1,6}[0-9]{1,3}` — `WH2`, `M1`), mirroring the repo's own ladder
  convention.

### 1.2 Hierarchy edges

All in the catalog graph (WP-5), no side tables:

| Edge | From → to | Source | Cardinality |
|---|---|---|---|
| `partOf` / `hasPart` | Epic → Initiative | envelope (`initiative` field on the epic) | epic: ≤1 initiative |
| `partOf` / `hasPart` | Task → Milestone | envelope (`milestone` field, set via `milestone_set`) | task: ≤1 milestone (plus the existing `spec` field — a task's epic — which the milestone must belong to) |
| `hasDesign` | Initiative → Design | envelope (`initiative` field on the design) | design: exactly 1 initiative |
| `proposedBy` | Epic → Design | minted at adoption (`via: adoption`) | epic: ≤1 design |
| existing v2/v3 edges | Task→Component (`affects`), Task→PR (`implementedBy`), Deployment→Task (`delivers`), `assignedTo`, `related` | unchanged | unchanged |

A task with a milestone but no spec is invalid (422); a task with a spec and
no milestone is fine (the epic's "unscheduled" bucket — v2 tasks land here).

### 1.3 Coordination event kinds (19 → 27, still closed, still no delivery-lifecycle kind)

Eight new kinds, all decisions or intent:

| Kind | Subject | Payload (sketch) | Notes |
|---|---|---|---|
| `milestone_edited` | epic | `{op: create\|edit\|reorder\|remove, key, title?, goal?, doneWhen?, targetDate?, ordinal?}` | The only way milestones change; `remove` on a milestone with open tasks is a 422 verdict (move or cancel the tasks first) |
| `milestone_set` | task | `{milestone: "<key>"\|null}` | Assign/clear a task's milestone; 422 if the milestone is not in the task's epic |
| `review_requested` | epic or design | `{revision: "sha256:…", reviewers?: [subject…], note?}` | Enters In Review at that revision; reviewers are suggestions, not gates |
| `review_submitted` | epic or design | `{revision, verdict: approve\|request_changes, note?}` | Humans **and agents** (an agent's verdict is advice, rendered with an agent chip); threading rides `comment_added` as today |
| `approved` | epic | `{revision: "sha256:…", snapshot: "sha256:…"}` | **Actor MUST be `user`** (server 422 otherwise — V4-2); the mutator seals the `EpicSnapshot` and stamps its id into the event in the same transaction |
| `approval_revoked` | epic | `{note?}` | Human-only, same guard; the epic folds back to Draft/In Review per remaining events |
| `design_adopted` | design | `{revision: "sha256:…", minted: ["<epic-key>", …]}` | Freezes the adoption record; the mint batch (below) rides the same transaction |
| `superseded` | design | `{by?: "<design-key>", note?}` | Terminal for a design; adoption of a rival does NOT auto-supersede (a human says so — the world cannot know a design lost) |

The CHECK constraint on `work.events.kind` regenerates with the new closed
list. **There is still no lifecycle-write kind for the delivery ladder**, and
the layer-by-layer assertion tests (schema, repository, routes, SDK, MCP)
extend to the new vocabulary. The observation vocabulary (6 kinds) does not
change (V3-1 → V4-1).

### 1.4 The intent-ladder fold (new, small, and honest)

Intent state is a fold over coordination events only — authored inputs,
derived rendering, nothing stored:

```
intentState(epic) :=
  if canceled                                        → Canceled
  else if a := lastApproval(events), a not revoked:
       if docRevision(now) == a.revision
          ∧ milestoneLadderHash(now) == a.ladderHash → Approved(a)
       else                                          → ApprovedDrifted(a, currentRev)
  else if open review_requested                      → In Review(revision)
  else                                               → Draft

intentState(design) := Draft | In Review | Adopted(revision) | Superseded
```

- `ladderHash` is the canonical digest of the milestone set (keys, titles,
  goals, doneWhen, order) at approval time, carried inside the
  `EpicSnapshot`; task membership and task contracts are **excluded** by
  design (V4-5 — tasks are regenerable implementation detail).
- Drift renders as both chips: `Approved @3f2a by @rahul · drifted (doc now
  @9c41)`. Only a fresh `approved` clears it. Nothing blocks the edit.
- The intent fold lives beside the delivery fold in the same worklens
  package (orun repo, WH0) with shared conformance fixtures; the TS mirror
  replays them (the v2 oracle pattern, extended).

### 1.5 Rollup folds (derived, never stored, pin-beside-truth generalizes)

```
progress(milestone) := counts of member tasks by rung (the v2 fold's output)
burnup(milestone)   := done-with-green-gates over time (the PM3 series, scoped)
execution(epic)     := fold over milestones: {perMilestone, totals, blockedCount, driftCount}
progress(initiative):= fold over member epics' execution
health(initiative)  := derived from: epics' execution vs targetDate trajectory,
                       open blocked flags, approval drift, unclaimed drift in scope
                       → on-track | at-risk | off-track, with named evidence
```

Health is the Aha! gesture done honestly: it is computed, its evidence is
listed ("at-risk: WH4 blocked 9 days; epic X approval drifted"), and a human
may **pin** health with a note — the existing `pinned` event on the
initiative subject — rendered beside the derived value and auto-expiring
when the derived value reaches the pinned one (v2 invariant 6, verbatim).
No surface accepts a correction to any rollup (V3-3 → V4-4).

### 1.6 New tables (migration: next free slot after v3's intent plane; renumber on collision as usual)

```sql
-- Designs: envelope + adoption record. The doc body rides work.doc_revisions.
work.designs (
  org_id      uuid NOT NULL,
  key         text NOT NULL,             -- DSG-n via work.sequences
  initiative  text NOT NULL,             -- initiative key (hasDesign edge)
  title       text NOT NULL,
  doc_ref     text,                      -- latest revision (droppable cache of doc_edited)
  context     jsonb NOT NULL,            -- {catalog: 'sha256:…', coordSeq, obsSeq} — what the design assumed
  proposal    jsonb,                     -- §3: the structured epic/milestone/task-skeleton set
  created_by  jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (org_id, key)
);

-- Milestones: authored intent rows, epic-scoped (fold cache of milestone_edited).
work.milestones (
  org_id      uuid NOT NULL,
  spec_key    text NOT NULL,             -- the epic
  key         text NOT NULL,             -- 'WH2' — epic-scoped, immutable
  ordinal     int  NOT NULL,
  title       text NOT NULL,
  goal        text,
  done_when   jsonb,                     -- string[]
  target_date date,
  removed     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, spec_key, key)
);
```

Plus droppable cache columns rebuilt from the coordination log alone
(invariant 1, mechanism unchanged): `work.tasks.milestone_key`;
`work.specs.initiative_key`, `.approved_revision`, `.approved_snapshot`,
`.approved_by`, `.approved_at`, `.ladder_hash`. `work.milestones` itself is
a droppable fold cache of `milestone_edited` (like `work.specs`/`work.tasks`
are of their events) — `rebuildCaches` extends to it, asserted.

`work.doc_revisions.spec_key` generalizes to carry any documented subject
key (epics and designs share the digest form, the canonicalizer, and the
fork-visible-LWW policy — V3-2 verbatim; the column is young and internal,
so this is a rename-in-place with the manifest/lock regenerated per the
migration discipline).

### 1.7 Properties (Linear/Aha parity, per level — all pure intent except the derived column)

| Property | Initiative | Design | Epic | Milestone | Task |
|---|---|---|---|---|---|
| Owner / assignee | ✓ (owner) | ✓ (authors) | ✓ (owner) | — (epic's) | ✓ (v2 assign; agents assignable, PM5) |
| Priority (none…urgent) | ✓ | — | ✓ | — | ✓ (v3) |
| Labels | ✓ | ✓ | ✓ (v3) | — | ✓ (v3) |
| Target date / quarter | ✓ | — | ✓ | ✓ | — (cycles cover tasks, v3) |
| Estimate | — | — | derived rollup of task points | derived rollup | ✓ (v3 points) |
| Success criteria / goal | ✓ (successCriteria[]) | the doc | the doc + contract-bearing tasks | ✓ (goal + doneWhen[]) | ✓ (v2 contract) |
| **Derived, not editable** | health, progress | intent state | intent state, execution, drift | progress, burn-up | rung, blocked, evidence |

New intent properties (initiative owner/target/successCriteria, epic
owner/target) are envelope fields edited via the existing `item_edited`
kind — no new event kinds needed beyond §1.3.

## 2. The Design noun (V4-B) — how "AI proposes epics" becomes an artifact

A design is created three ways, all landing identically:

1. **A design run** (AG8): the "Design" button on an initiative dispatches
   an agent with the initiative brief + sealed catalog context; the agent
   writes the doc and proposal through the MCP (`design_propose`, §6). The
   run's output is a *Draft design*, attributed to the agent principal.
2. **A human authoring session**: the same editor the v3 spec document uses.
3. **Import**: a repo-authored design doc imports like any spec doc (V3-5).

The **proposal** is the structured half — canonical JSON, digest-covered by
the design's revision:

```jsonc
{
  "epics": [{
    "slug": "orun-work-v4",                    // becomes the epic key on adoption
    "title": "The planning hierarchy",
    "docSeed": "sha256:…",                     // initial epic doc (a doc_revisions row)
    "milestones": [{
      "key": "WH0", "title": "The model + the oracle",
      "goal": "…", "doneWhen": ["…"], "ordinal": 0
    }],
    "taskSkeletons": [{                        // optional; land as Draft tasks
      "milestone": "WH0", "title": "…",
      "contract": { "goal": "…", "affects": ["…"], "doneWhen": ["…"], "gates": ["…"] }
    }]
  }]
}
```

**Adoption** (`POST …/designs/{key}/adopt`, human-only like approval) runs
in one transaction: the `design_adopted` event, then the mint batch — epic
`item_created` + `milestone_edited(create)` + task `item_created`/
`contract_edited` events, every one `via: adoption` with the adopting human
as actor (provenance: the human decided; the design — and behind it possibly
an agent — proposed; both are visible: the epic's `proposedBy` edge and the
design's attributed authorship). Minted epics are **Draft** — adoption is
not approval. Partial adoption (a subset of proposed epics) is a request
parameter, recorded in the `minted` list.

Designs are compared, not merged: the initiative page renders its designs
side by side (doc + proposal summary + review verdicts); adopting one does
not auto-supersede rivals (§1.3) — exploration is cheap and history is kept.

## 3. Approval and the sealed brief (V4-2, V4-6)

The approve mutator, in one transaction:

1. Validates: actor is `user`; the epic has ≥1 milestone; the named doc
   revision is current; the workspace policy's `minApprovals` (default 1,
   counting `review_submitted{approve}` at that revision by distinct humans;
   the approver's own act counts) is satisfied.
2. Seals **`EpicSnapshot`** — `SpecSnapshot` (v2 §8.1) extended additively:

```jsonc
{ "kind": "EpicSnapshot", "apiVersion": "orun.io/v1",
  "spec":       { /* epic envelope, docRef resolved into the closure */ },
  "milestones": [ { "key": "WH0", "title": "…", "goal": "…",
                    "doneWhen": ["…"], "ordinal": 0, "targetDate": null } ],
  "tasks":      [ /* current task envelopes + contracts (informative — see note) */ ],
  "design":     "sha256:…",         // the adopted design revision, when minted from one
  "ladderHash": "sha256:…",         // canonical digest of the milestone set (§1.4)
  "approval":   { "by": {"type":"user","id":"usr_…"}, "at": "…", "revision": "sha256:…" },
  "catalog": "sha256:…", "coordSeq": 18421, "obsSeq": 90311 }
```

3. Appends `approved{revision, snapshot}` and updates the droppable cache
   columns.

The `tasks` closure member is **informative context, not approved scope**
(V4-5): the approval covers `docRef + ladderHash`. An agent dispatched later
re-pulls the latest snapshot-compatible brief; if the doc/ladder drifted,
dispatch surfaces the drift verdict instead of silently briefing stale scope.

`orun epic pull <slug>[@sha256:…]` supersedes `orun spec pull` as its strict
superset (the old command remains, prints a pointer). Refs:
`refs/work/epics/<slug>/latest` alongside the existing spec refs. One
canonicalizer, one determinism contract — no new sealing path (V4-6).

**Dispatch** (AG9) is unchanged in mechanism — assignment — but gains its
precondition: assigning an agent to a task whose epic is not Approved (or is
drifted) yields a structured verdict the console renders on the assignee
picker ("epic not approved / approval drifted — review before dispatch").
Humans may override by assigning anyway with a note (an attributed decision,
like every override in this product); agents cannot self-assign into an
unapproved epic (server-side).

## 4. API surface (state-worker routes, api-edge passthrough)

All under the existing `/v1/organizations/{org}/work` plane, authz-first
with resource-hiding 404, reusing `work.read`/`work.write` (V3-4). One new
policy action pair — `work.approve` — because approval is a real privilege
boundary (reviewer vs approver), landing in the role maps **and**
`ALL_KNOWN_ACTIONS` in the same commit with the regression test (the
Work-page-404 lesson). Mutators append exactly one event each except the
two transactional batches (adopt, approve) which are documented multi-event
mutations with a single verdict.

```
…/work/epics/*                               ← alias of …/work/specs/* (1:1, additive)
GET    …/work/initiatives/{key}              envelope + designs + epics + derived health/progress
POST   …/work/initiatives/{key}/designs      create design (context sealed server-side)
GET    …/work/designs/{key}                  envelope + proposal + intent state + verdicts
PUT    …/work/designs/{key}/doc              new revision (fork-visible LWW, as specs)
GET    …/work/designs/{key}/doc[/history]    revision chain
POST   …/work/designs/{key}/adopt            human-only; mints per §2
POST   …/work/designs/{key}/supersede
POST   …/work/epics/{slug}/milestones        milestone_edited ops (create/edit/reorder/remove)
GET    …/work/epics/{slug}/milestones        the ladder with derived progress
GET    …/work/epics/{slug}/milestones/{key}  one milestone: goal/doneWhen, tasks, burn-up
POST   …/work/tasks/{key}/milestone          milestone_set
POST   …/work/epics/{slug}/review            review_requested
POST   …/work/epics/{slug}/verdict           review_submitted (also on designs)
POST   …/work/epics/{slug}/approve           human-only (work.approve); seals + returns snapshot id
POST   …/work/epics/{slug}/revoke-approval   human-only (work.approve)
GET    …/work/epics/{slug}/brief[@{id}]      the sealed EpicSnapshot
GET    …/work/rollups?initiative={key}       derived health/progress with evidence
```

The summary endpoint grows initiative/epic/milestone rollups and intent
states additively; v2/v3 clients keep working unmodified. Realtime: no new
transport — every new kind rides the existing SSE tail.

## 5. Console architecture — the drill-down (`apps/web-console-next`)

The v3 Work section grows the hierarchy spine; Northwind primitives
(Screen / PageHeader / ListCard / Pill), scope-in-URL, Cmd-K throughout.
Every level shares one page grammar: **header (breadcrumb · title · intent
chips · derived chips) → properties rail → children table → timeline**.

```
/orgs/{o}/work/initiatives                    portfolio: derived health + progress bars,
                                              owner, target, priority — nothing enterable
/orgs/{o}/work/initiatives/{key}              overview · Designs rail (compare, statuses)
                                              · Epics table (intent + execution chips)
                                              · timeline
/orgs/{o}/work/initiatives/{key}/designs/{d}  doc editor/viewer · proposal preview
                                              ("this design mints: 3 epics, 14 milestones,
                                              41 tasks" — expandable tree) · review thread
                                              · Adopt / Supersede
/orgs/{o}/work/epics/{slug}                   epic doc · approval panel (state, revision
                                              chips, reviewers, Approve/Re-approve) ·
                                              milestone ladder (ordered, per-milestone
                                              progress) · board scoped to the epic ·
                                              timeline
/orgs/{o}/work/epics/{slug}/milestones/{m}    goal + doneWhen · task table/board ·
                                              burn-up · timeline (the #subject log)
/orgs/{o}/work/tasks/{key}                    the v3 task page + milestone breadcrumb
```

Component notes, in the established idiom (session SDK client, `wrap` +
`useApiQuery`, inline 422 verdict rendering, optimistic apply per PM4):

- **Breadcrumb** — `Initiative / Epic / Milestone / Task`, every segment a
  link; the same trail renders in Cmd-K results and in board card hovers.
- **Approval panel** — the intent chip pair (`Approved @3f2a by @rahul` ·
  `drifted: doc @9c41`) with the diff link between the two revisions;
  Approve is disabled-with-reason until preconditions hold (the verdict
  text, rendered before the click, not after).
- **Designs rail** — cards per design: intent state, author chips
  (human/agent), proposal summary, review verdict count; a compare view
  renders two proposals' trees side by side.
- **Milestone ladder** — the epic page's spine: ordered rows, each with
  derived progress and target date; drag to reorder appends
  `milestone_edited{reorder}` (pure intent, like v3's in-column drag).
- **Board scoping** — the v3 board gains scope pills (epic, milestone);
  columns stay rungs; drag semantics unchanged (across = pin, within =
  order).
- **Task generation affordance** — on a milestone under an approved epic:
  "Generate tasks with agent" (AG dispatch surface, not v4 machinery —
  v4 provides the button's home and renders the attributed result;
  regenerate renders as cancel+create in the timeline with a contract-
  review flag per proposal, the PM5 triage lane unchanged).
- **Cmd-K verbs** — new: create initiative/design/epic/milestone, jump by
  hierarchy, approve (visible only when actionable), adopt design.

## 6. Agents — the runtime binding (pairs AG, owns no runtime)

The PM5 boundary holds: v4 builds no sandbox, dispatch, or autonomy
machinery. What v4 adds to the seam:

- **AG8 design runs get their durable home.** The run's output stops being
  "epic files PR + contract_propose" free-floating: it lands as a Draft
  Design with sealed context (§2), reviewable and adoptable. The AG8 brief
  gains the initiative envelope; the proposal schema (§2) is the run's
  output contract.
- **MCP growth** (orun repo; the forbidden-tool sweep extends — still no
  status, pin, approve, or adopt tool):
  - Reads: `initiative_get`, `design_get`, `epic_brief` (the sealed
    `EpicSnapshot`; supersedes `spec_get`, which remains), `milestone_get`.
  - Writes: `design_propose` (create/revise a Draft design + proposal,
    flagged for review like `contract_propose`), `task_create` gains
    `milestone`, `task_regenerate` (batch cancel+create under one milestone,
    one verdict, every contract flagged).
- **Dispatch preconditions** (§3): agents cannot be assigned into
  unapproved/drifted epics by other agents or by themselves; a human
  override is attributed.
- **The agent implements from the brief alone.** The acceptance test for the
  whole epic (WH5): an agent given only `epic_brief(slug)` — doc, milestones,
  contracts, sealed catalog — plans and executes a milestone end-to-end
  through the existing four-plus-new write tools, with zero human free-text.
  If the brief is insufficient, the fix is the document, not a DM — that is
  the review ladder's job.

## 7. Import (dogfood, WH6)

`orun work import` learns the hierarchy the repo already writes:

- `specs/epics/<name>/` → epic (as today), `README.md` → doc.
- `implementation-plan.md` `## <KEY> — <Title>` headings → **milestones**
  (previously tasks), their `**Goal:**`/`**Done when:**`/`**Deps:**` lines →
  milestone goal/doneWhen (+ ordering).
- Checklist items under a milestone heading → tasks in that milestone;
  where none exist, one task per milestone is materialized carrying the
  milestone's contract — v2's mapping, preserved 1:1 under the new level.
- `specs/roadmap.md` cluster rows → initiatives; the epic-index table
  provides `partOf`.
- Re-import stays idempotent; previously imported task-per-milestone
  corpora migrate by key (the import plan prints the mapping; `--dry-run`
  first, as always). **No lifecycle and no approvals are imported** — the
  v2 rule extended: import writes intent, never decisions.

## 8. Compat and conformance

- No breaking change to any v2/v3 surface at any point; the v2 conformance
  fixtures and the v3 vocabulary tests pass untouched.
- The Go oracle gains: the new kinds (write-time validation), the intent
  fold, the rollup folds, `ladderHash`, and new conformance fixtures the TS
  fold replays byte-identical (the established oracle pattern).
- `orun work list` (v2 CLI) keeps working; `orun work list --tree` renders
  the hierarchy; `spec_get`/`spec pull` remain as compatible aliases.
- Notification wiring reuses ES2 rules: `work.review_requested`,
  `work.approved`, `work.design_adopted` publish onto `event_log` with the
  `work.*` prefix — rules and channels do the rest, no new rail.

## 9. Risks, called honestly

- **Ontology gravity.** Five nouns is Linear-scale surface area; the defense
  is that three of the five are thin (initiative = envelope + folds,
  milestone = sub-item rows, design = doc + one JSON blob) and the two thick
  ones (epic, task) already shipped in v2/v3. Anything that wants a sixth
  noun (cycle-per-epic, sub-milestone, workstream…) is a saved view until
  proven otherwise — WP-4's discipline did not expire.
- **Approval theater.** The failure mode where "Approved" becomes a rubber
  stamp nobody reads. Mitigations are structural: approval names a revision
  (you approve *bytes*, not vibes), drift is loud, and the dispatch verdict
  makes a stale approval cost something at exactly the moment it matters.
- **Two sources of epics** (adopted vs direct-authored). Same shape as v3's
  two doc sources; same fix: provenance is always rendered (`proposedBy`
  edge or its absence), and neither path is second-class.
- **Milestone/task import migration.** The one place v4 touches existing
  imported data. Gated behind `--dry-run` plans, key-preserving mapping,
  and golden fixtures over this repo's real `specs/` tree (the P-4
  round-trip discipline extends).
- **Rollup fold cost.** Initiative pages fold over epics × milestones ×
  tasks. Same posture as v2's P-1: per-subject incremental folds with
  droppable cursor caches; WH6 records the budget on the dogfood corpus
  before the portfolio ships.
