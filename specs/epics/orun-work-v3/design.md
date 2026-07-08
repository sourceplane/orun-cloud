# orun-work v3 — design

Status: Normative for PM0–PM5. Builds on the v2 substrate
(`orun/specs/orun-work/` + `../orun-work/`); nothing below changes the fold,
the ladder, or the observation vocabulary.

## 0. Design stance

v2 proved the truth engine; v3 grows the intent plane around it. Three
consequences run through every section:

1. **Additive, never destructive.** The v2 schema, routes, SDK surface, CLI,
   and MCP keep working byte-for-byte. v3 is new event kinds, new intent
   tables, new routes, and a much larger console — plus zero changes to how
   a rung is derived.
2. **The coordination log is the write path for everything conversational.**
   Threads, reactions, mentions, labels, priority, estimates, relations,
   cycle membership — all of it is coordination events (one per mutation,
   WP-6), which means the timeline, the audit trail, the SSE tail, and cache
   rebuilds (invariant 1) get every v3 feature for free.
3. **Tables only for authored nouns.** Documents, cycles, and views get
   tables because they are intent-plane entities with real payloads. Nothing
   derived is stored (V3-3).

## 1. Model deltas

### 1.1 Item kinds

v2's closed item vocabulary `{spec, task}` grows by one: **`initiative`**.
An initiative is envelope-only (title, description, member specs via
`related` events) — it has no contract and no rung; its progress is a rollup
of member-spec progress from the fold.

### 1.2 Coordination event kinds (9 → 19, still closed, still no lifecycle)

New kinds, all intent or conversation:

| Kind | Payload (JSONB, sketch) | Notes |
|---|---|---|
| `doc_edited` | `{revision: "sha256:…", parent: "sha256:…"}` | Body lives in `work.doc_revisions`; the event is the pointer + provenance |
| `reaction_added` / `reaction_removed` | `{target_event: uuid, emoji}` | On any comment |
| `labeled` / `unlabeled` | `{label}` | Free-form workspace labels |
| `prioritized` | `{priority: none\|low\|medium\|high\|urgent}` | |
| `estimated` | `{points: number\|null}` | |
| `cycle_set` | `{cycle: key\|null}` | Assign/remove from a cycle |
| `related` / `unrelated` | `{rel: blocks\|parent\|relates, target: key}` | Typed relations; fold derives `blocked` from `blocks` exactly as it does from contract Deps today |

`comment_added` (existing kind, unchanged name) gains optional payload
fields: `{parent_event: uuid}` for threading and
`{anchor: {revision, start, end}}` for text-range comments on a document
revision. Mentions are parsed from the body (`@handle`, `@team/handle`) at
write time and emitted as attributes on the event for the notification rail —
no separate kind.

**The CHECK constraint on `work.events.kind` is regenerated with the new
closed list. There is still no lifecycle-write kind; the layer-by-layer
assertion tests (schema, repository, routes, SDK, MCP) extend to the new
vocabulary.** The observation vocabulary does not change (V3-1).

### 1.3 New tables (migration `650_work_v3_intent_plane` — next free slot
after `640_event_lifecycle`; renumber on collision as usual)

```sql
-- Append-only document revisions; digest form matches v2 doc_ref exactly.
work.doc_revisions (
  org_id      uuid NOT NULL,
  revision    text NOT NULL,            -- 'sha256:<hex>' of canonical body
  parent      text,                     -- prior revision or NULL (first)
  spec_key    text NOT NULL,
  body        text NOT NULL,            -- markdown, canonicalized LF
  created_by  jsonb NOT NULL,           -- the same typed-actor shape as events
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (org_id, revision)
);

-- Authored time-boxes. Progress inside is derived, never stored.
work.cycles (
  org_id    uuid NOT NULL,
  key       text NOT NULL,              -- CYC-n via work.sequences
  name      text NOT NULL,
  starts_at date NOT NULL,
  ends_at   date NOT NULL,
  PRIMARY KEY (org_id, key)
);

-- Saved views: pure UI intent, shareable by default.
work.views (
  org_id     uuid NOT NULL,
  key        text NOT NULL,
  name       text NOT NULL,
  config     jsonb NOT NULL,            -- {layout: board|list, filters, group_by, order}
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, key)
);
```

The fold caches (`work.specs`, `work.tasks`) gain droppable columns for the
folded intent (labels, priority, estimate, cycle) — rebuilt from the
coordination log alone, exactly like title/assignee today. `work.specs`
additionally caches `doc_ref` = latest cloud revision when one exists
(repo-imported specs keep their imported digest; the two sources share one
column because they share one digest form — V3-2).

**Migration lock discipline:** the migration ships with the regenerated
`manifest.ts` sha256 + `infra/db-migrate/migrations.lock`
(`gen-migrations-lock.mjs`), the mechanism that exists precisely so a
`packages/db`-only change schedules the db-migrate component.

### 1.4 Documents and sealing (the V3-2 continuity)

A cloud document edit canonicalizes the markdown body (LF, trailing-newline
normalization — the same rules the importer hashes a README with), computes
`sha256:<hex>`, inserts the revision row, and appends one `doc_edited` event
carrying the digest. `orun spec pull` needs **no change of contract**: it
already seals whatever `doc_ref` digest the summary carries. The dispatcher
guarantee ("an agent implements against exactly `spec@hash`") now covers
cloud-authored documents automatically.

Conflict policy is last-writer-wins **per revision chain with visible forks**:
an edit carries its `parent`; a concurrent edit produces a second child of
the same parent, both visible in the document history, banner in the UI, a
human merges (creates a third revision with both parents' content reconciled;
`parent` records the one they built on). No CRDT in this epic — plain
revisions are honest, cheap, and sufficient at team scale; CRDT is a PM4+
follow-up **only if** concurrent-edit pain is observed in dogfood.

## 2. API surface (state-worker routes, api-edge passthrough)

All under the existing `/v1/organizations/{org}/work` plane (already matched
by api-edge's `ORG_WORK_RE`), all authz-first with resource-hiding 404, all
reusing `work.read`/`work.write` (V3-4). New routes (mutators append exactly
one event each):

```
POST   …/work/initiatives                     create initiative
POST   …/work/specs                           (exists) — gains cloud-doc create
PUT    …/work/specs/{slug}/doc                new revision {body, parent}
GET    …/work/specs/{slug}/doc[@{revision}]   read a revision (latest default)
GET    …/work/specs/{slug}/doc/history        the revision chain
POST   …/work/tasks/{key}/(comment|assign|pin|cancel|contract)   (exist)
POST   …/work/tasks/{key}/(label|priority|estimate|cycle|relate) new intent verbs
POST   …/work/comments/{event_id}/reactions   add/remove reaction
GET    …/work/timeline/{key}                  interleaved logs for one item
POST   …/work/cycles · GET …/work/cycles      authored time-boxes
GET    …/work/cycles/{key}/burnup             derived series (fold over time)
POST   …/work/views · GET …/work/views        saved views
GET    …/work/search?q=                       specs+tasks+comments full-text
```

The summary endpoint (`GET …/work`) grows the folded intent fields on task
views and initiative/cycle rollups — additive response shape, no breaking
change to v2 clients (CLI `orun work list` keeps working unmodified).

Realtime: no new transport. Every new coordination kind rides the existing
SSE tail; the console's cursor loop already refetches on any event.

## 3. Console architecture (`apps/web-console-next`)

The Work page graduates from one workbench to a section:

```
/orgs/{slug}/work                → default view (board or list, per saved view)
/orgs/{slug}/work/views/{key}    → a saved view
/orgs/{slug}/work/specs/{slug}   → spec page: document + tasks + timeline
/orgs/{slug}/work/tasks/{key}    → task page: contract, evidence, thread, timeline
/orgs/{slug}/work/initiatives    → initiative list + rollups
/orgs/{slug}/work/cycles/{key}   → cycle board + burn-up
/orgs/{slug}/work/triage         → drift + suggestions + review-parked + mentions + contract proposals
```

Built on the shipped **Northwind** design system (the console-wide restyle
already applied to Catalog / Repos / Settings / Secrets) so the work surface
reads as one product, not a bolted-on tracker — the same Screen / PageHeader /
ListCard / Pill primitives, the same scope-in-URL and Cmd-K conventions.

Component notes, in the repo's established idiom (session SDK client, `wrap`
+ `useApiQuery`, inline verdict rendering from 422s):

- **Board** — columns are rungs (fixed order from `RUNG_ORDER`); drag across
  columns opens the pin note affordance and mints `pinned` (the card shows
  both badges — pin beside truth); drag within a column appends `ordered`.
  Rejected drops (agent actor, invalid rung) render the mutator's verdict on
  the card. There is no column whose drop writes a rung anywhere.
- **Document editor** — markdown-first (textarea + preview initially; block
  editor is a PM4 polish), save = `PUT …/doc`, history rail from
  `…/doc/history`, range-anchored comments pinned to the revision they were
  made on (an anchor on a superseded revision renders collapsed with a
  "on older revision" chip — never silently re-anchored).
- **Timeline** — one component, both logs interleaved by time; coordination
  entries carry actor chips (user/agent/automation), observation entries
  carry evidence chips linking to the PR/run. This is the GitHub-issue
  thread done on native data.
- **Optimistic store (PM4)** — apply intent events locally on submit, replay
  on the SSE-confirmed event, roll back rendering the verdict on 422. The
  seam is the existing mutation client; v2 deferred this deliberately, PM4
  lands it.
- **Cmd-K** — verbs registered into the console-wide palette
  (saas-console-ux): create task, comment, pin, label, jump-to-spec, etc.

## 4. Agents — the project surface, not the runtime (PM5)

**Ownership boundary (decided).** The agent *runtime* is the orun binary
(`orun/specs/orun-agents/`, AG0–AG4); the *cloud control plane* — sandboxes,
session identity, the Agents tab, the dispatch trigger, the autonomy ladder —
is `saas-agents` (AG5–AG11). Both already build on this work plane's four-tool
agent surface, dispatch-is-assignment, and the no-status-write invariant. So
v3 **does not build agent dispatch or a runner**; that would duplicate AG8/AG9.
PM5 owns only what the *project surface* uniquely owes agent work: how it is
**rendered, attributed, reviewed, and governed inside the board, timeline, and
triage.** The seam between the two is deliberately thin and already exists —
`assign` is the dispatch trigger (AG9), `contract_propose` is the design-run
output (AG8), and progress is observed either way.

What PM5 owns:

- **Agents are assignable teammates.** The board/task assignee model renders
  agent principals (`sp_` service principals with a responsible owner, per
  AG6) alongside people — same picker, same chips. Assigning a task to an
  agent is the ordinary `assign` mutator; AG9 is what hooks a dispatched run
  onto that assignment. v3 provides the affordance; AG provides the behavior.
- **Session state renders beside a rung, never as one.** When AG relays a
  live session for an assigned task, the task row/page shows an infra-fact
  chip (`provisioning` / `running` / `suspended`) visibly distinct from the
  derived rung — matching AG's decision that control-plane state is
  categorically not a work rung. A link opens the Agents-tab transcript; v3
  renders the chip and the link, AG owns the relay.
- **The contract-review queue is a first-class Triage lane.** A design run
  (AG8) applies a contract edit through the mutator AND flags it for review;
  PM5's Triage surface (design §3) collects those flags into an actionable
  lane — accept (clears the flag) / revert (a human `contract` edit back).
  This is the human-in-the-loop gate for "an agent redefined a definition of
  done," and it belongs to the PM surface, not the runtime.
- **Agent work carries the same evidence discipline as human work.** Timeline
  actor chips distinguish `user` / `agent` / `automation`; an agent moves a
  task exactly as a human does — by opening a PR that the observation log
  sees — so nothing about the timeline is agent-special except attribution
  and a deep-link to the sealed session (AG's `AgentSessionSnapshot`).
- **orun repo legs (read-only):** the work MCP may gain `work_timeline` and
  `doc_get` reads for the in-sandbox runtime; still no status or pin tool —
  the forbidden-tool sweep extends. `orun spec pull` is unchanged (V3-2); it
  is already how AG8 hands an agent a frozen brief.

Explicitly **out of PM5** (owned by AG): the sandbox provider seam, session
tokens, the DO relay/transcript store, the "Design with agent" / dispatch
buttons themselves, the autonomy ladder, concurrency caps, agent metering.
PM5 is the surface those attach to; if a flow needs both, it lands in AG with
v3 providing the assignee/triage/timeline primitives it renders into.

## 5. Ordering, dependencies, compat

- PM0 → PM1 → PM2 form the Linear/GitHub parity core and land in order.
  PM3 (cycles) and PM4 (flow) are parallel after PM2. PM5 (the agent project
  surface) closes, and pairs with `saas-agents` AG6–AG9 — the assignee/triage/
  timeline primitives PM5 ships are what AG's dispatch and design runs render
  into. PM5 is unblocked without AG (agents render as ordinary assignees the
  moment they exist as principals); the live session-state chip and transcript
  deep-link light up as AG6/AG7 land.
- No breaking change to any v2 surface at any point; the v2 conformance
  fixtures keep passing untouched (the fold is not modified — new folded
  intent fields are additive envelope data, not lifecycle inputs).
- The Go oracle (`orun/internal/worklens`) gains the new event kinds in its
  closed-vocabulary validation (write-time acceptance), but the fold's
  lifecycle logic reads none of them — asserted by keeping the shared
  conformance fixtures byte-identical.
- Notification wiring (PM1) consumes ES2 rules as a client — no changes to
  the events plane; mention/subscription events publish onto `event_log`
  with the `work.*` type prefix and rules do the rest.

## 6. Risks, called honestly

- **Scope gravity.** Linear is a decade of polish; PM0–PM2 must ship the
  *feel* (fast create/edit/comment/board) without chasing feature count.
  Anything not in the honest-gesture table defaults to out.
- **Two doc sources.** Repo-imported vs cloud-authored documents could
  confuse. Mitigation: one digest form, one `doc_ref` column, and the spec
  page always states its source ("authored here" / "imported from repo @
  digest") — plus V3-5: import never overwrites a cloud chain (it forks it,
  banner shown).
- **Concurrent edits.** Fork-visible LWW is deliberately modest; measured in
  dogfood before any CRDT investment.
- **Board expectations.** New users WILL try to drag to Done and get a pin.
  The pin note affordance and the double-badge render are the teaching
  moment; we accept the first-week friction as the product working.
