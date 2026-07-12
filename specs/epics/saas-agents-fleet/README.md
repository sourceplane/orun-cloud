# Epic: saas-agents-fleet

**From sessions to a workforce.** `saas-agents` (AG5–AG12) made a cloud
session *possible* — a box, an identity, a relay, a dispatch trigger.
`saas-agents-live` (AL6–AL9) made a session *drivable* — one session, many
heads, every input attributed and sealed. Both assume the thing on screen is
**a session**, watched one at a time. That assumption is already breaking:
dispatch fans work out, design competitions want N parallel drafts, fix runs
respawn on red gates, and the fleet view is a table you have to *remember to
check*. This epic is the third movement: make **many sessions manageable as
one workforce** — sessions that delegate to child sessions under a ceiling
that only narrows (AF4), standing **routines** that spawn sessions on a
schedule or an event (AF6), a fleet home that is a derived **attention
plane** rather than a watchlist (AF5), autonomy that is **earned from the
sealed track record** instead of configured on faith (AF7), and **budgets
as hard ceilings** shared down a delegation tree (AF8). The runtime half —
the spawn/await tools, the orchestrator and judge session modes, the routine
object kind, the track-record fold — lives in the paired orun epic
(`orun/specs/orun-agents-fleet/`, AF0–AF3). This epic never re-implements
it; the cloud stays what AG made it: a box, an identity, a relay, and a
door.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — authored, ready for review; open decisions in `risks-and-open-questions.md` |
| Cluster | **AF** (agents fleet — cross-repo, shared with `orun`; **orun owns the runtime legs: spawn/await tools, orchestrator + judge modes, the routine object kind, the track-record fold (AF0–AF3)**, this repo owns the **delegation plane + attention plane + routines control plane + earned autonomy + budgets (AF4–AF9)**) |
| Owner(s) | `apps/agents-worker` (tree columns + spawn door, attention fold, routine scheduler + ES lane consumer, budget enforcement) · `packages/db/src/agents` (tree columns, `routines`, `budgets`) · `apps/web-console-next` (the fleet home per the Northwind Agents mock, tree strip, profile record page, routine + budget surfaces) · `apps/api-edge` (facade for the new routes) · `apps/notifications-worker` (digests, budget + park notices) · `packages/contracts`/`sdk` (tree/routine/budget/attention shapes) |
| Target branch | `claude/agent-epic-evolution-knqcf6` (design PR), then `main` (PRs merged incrementally) |
| Builds on | **`orun/specs/orun-agents-fleet/` (AF0–AF3 — the runtime legs; hard dependency for AF4/AF6/AF7, not for AF5)** · `saas-agents` as-built (AG5/AG6 provisioning + session identity + leases/sweep; AG9's **one dispatch door**; AG12 BYO providers) · `saas-agents-live` as-built (the per-session DO relay + attach frames, the console head, edge-stamped attribution, `agents.tokens`/`session_minutes` meters) · `saas-event-streaming` ES1 (the cursor-lane contract AF6's event triggers consume) · `apps/notifications-worker` (AF5 digests) · the **Northwind Agents mock** (`Northwind_Agents.html`, 2026-07-12 — extracted into `design.md` §2 as the normative fleet-home + session-page surface) |
| Decisions locked | (1) **An orchestrator is a session, not a service** — fan-out lives in the runtime (`agent_spawn`/`agent_await` are gated tools in the orun loop); the cloud gains a spawn *door* (the runtime calls the same public sessions API with its session token), never an orchestration engine; agents-worker's blast radius stays a service principal's. (2) **The tree only narrows** — a child's effective ceiling is the intersection of the parent's effective ceiling and the child type's sealed ceiling; depth and width caps are hard; kill is tree-transitive; the tree shares one budget. (3) **Routines spawn sessions, never act inline** — every firing is an ordinary session through the same identity/lease/relay/seal machinery; there is no second execution path to harden. (4) **Attention is derived, never authored** — the needs-you queue is a fold over facts already stored (session states, budget marks, routine parks, lease health); no inbox rows, nothing to mark-as-read, dismissal is acting on the thing itself (the work-plane epistemology applied to the fleet). (5) **Autonomy is earned and movement is asymmetric** — the AG9 ladder keeps its rungs; promotion is *suggested* by the sealed track record and applied only by a human ack with the evidence attached; demotion is automatic and loud; no sequence of agent actions can widen any leash. (6) **Budgets are ceilings, not advisories** — per session, tree, routine, and workspace; enforced at spawn (refuse) and at relay ingest (graceful `budget_exhausted` interrupt that seals partial state), never a hard kill that loses the log. |
| Gate | **Buildable vendor-free in the AG/AL posture.** AF5 (attention) folds over shipped state and ships first with zero orun dependency; AF4/AF6/AF7 build against fixtures of orun AF0–AF3 outputs (sealed sessions, routine snapshots, record folds) the same way AL built against attach fixtures; live Daytona verification rides the existing BYO-key slice. Product decisions parked in `risks-and-open-questions.md` (F-Q1 spawn grant default, F-Q4 the promotion evidence bar). |

## Thesis

Every credible agent product is converging on the same discovery Claude
Code made: the unit users manage stops being *the session* and becomes *the
workforce* — background tasks fan out, scheduled routines fire while you
sleep, a fleet surface tells you what needs you, and token budgets are the
control users actually reach for. This platform is unusually well-positioned
for that turn, because the hard invariants are already load-bearing: every
session is a service principal with a responsible owner, every event is
sealed and attributed, lifecycle is derived and nobody can author progress.
What is missing is *scale semantics* — today two concurrent sessions are
just two rows, delegation is impossible, recurring work needs a human
finger, and trust is a dropdown someone set optimistically.

The design bet is that all five planes are **the existing invariants,
applied at fleet grain**. Delegation is the session machinery made
recursive, with ceilings that compose by intersection — a child is *more*
contained than its parent, mechanically. Routines are the dispatch door on
a timer or a lane cursor — not a new executor. The attention plane is a
fold — the same epistemology that made work lifecycle underivable-from-
opinion now decides what deserves a human's next minute, and it cites its
sources. Earned autonomy is the sealed-session corpus finally paying rent:
the platform can *prove* `coder-01` merged 47 of 53 PRs without a human
edit, so widening its leash is an evidenced decision, not a vibe. And
budgets ride the meters AL9 already landed. Nothing in this epic invents a
plane; it makes the ones we sealed compose.

## How it maps to the references

| Claude Code (fleet-era) / Devin / Copilot agents | Here |
|---|---|
| Subagents / workflow fan-out from one session | `agent_spawn`/`agent_await` tools (orun AF0) → the cloud spawn door; the delegation tree (AF4) |
| FleetView; "what needs me" surfaces | the attention plane — a derived needs-you fold, rendered as the Northwind fleet home (AF5) |
| Routines / scheduled + event-triggered agents | `agents.routines`: cron + ES-lane triggers re-entering the AG9 dispatch door (AF6) |
| Trust grows with a track record; permission modes | the sealed track record → suggested, human-acked promotion; automatic demotion (AF7) |
| "+500k tokens" budget directives; runaway-loop backstops | budget ceilings per session/tree/routine/workspace, graceful sealed exhaustion (AF8) |
| Judge panels / adversarial verify before commit | judge session mode (orun AF1) rendered as verdict cards on the parent session (AF4) |

## Read order

1. This README.
2. **`orun/specs/orun-agents-fleet/`** — the paired epic (read first): README
   → design → the spawn-tool contract and the routine object kind.
3. [`design.md`](./design.md) — the mock extraction, the delegation plane,
   the attention fold, routines, earned autonomy, budgets, security posture.
4. [`implementation-plan.md`](./implementation-plan.md) — AF4–AF9.
5. [`risks-and-open-questions.md`](./risks-and-open-questions.md).

## Milestones at a glance (cloud-owned; AF0–AF3 in `orun/specs/orun-agents-fleet/`)

| ID | Milestone | Status |
|----|-----------|--------|
| AF4 | The delegation plane: tree columns (`parent_session_id`/`root_session_id`/`depth`), the `agent.session.spawn` action + spawn door (ceiling intersection, depth/width caps, shared budget), tree-transitive kill, orphan sweep, the children strip + judge verdict cards on the session page | 🗓️ Planned |
| AF5 | The attention plane: the needs-you fold (`GET …/agents/attention`), the fleet home rebuilt to the Northwind Agents mock (verdict queue · quick-spawn · active/recent · profiles · providers), the topbar badge, digest notifications | 🗓️ Planned (no orun dependency — first slice) |
| AF6 | Routines: `agents.routines` rows binding a sealed routine definition to a profile + trigger (cron / ES lane) + budget; both trigger paths re-enter the AG9 dispatch door; quiet-by-default outcome digests; park-on-repeated-failure | 🗓️ Planned |
| AF7 | Track record & earned autonomy: the per-profile record (orun AF3 fold joined with cloud facts), record chips + the profile page, promotion suggestion cards with evidence, human-ack promotion + automatic demotion, `agent.autonomy.*` audit | 🗓️ Planned |
| AF8 | Budgets: `agents.budgets` at four grains, enforcement at spawn + ingest, the 80% attention mark, graceful `budget_exhausted` interrupt, Usage forecast strip | 🗓️ Planned |
| AF9 | Hardening + evals: hostile-orchestrator fixtures (widen-a-child / spawn-storm / cap evasion), routine injection posture, runaway-tree kill drill, the §10 acceptance narrative as tests | 🗓️ Planned |

## Scope boundary

| In scope (cloud) | Out of scope |
|----------|--------------|
| Tree columns + the spawn door + tree caps/kill/sweep; the attention fold + fleet home + badge + digests; the routines control plane (registry, cron scheduler, ES lane consumer, park semantics); the record read + promotion/demotion choreography + audit; budget storage + enforcement + forecast; the console surfaces for all five (normative mock: `design.md` §2) | **The runtime legs** — `agent_spawn`/`agent_await` tool semantics, orchestrator + judge session modes, the routine object kind + sealing, the track-record fold algorithm — all `orun/specs/orun-agents-fleet/` (AF0–AF3); the attach protocol + heads (AL, shipped — reused); sandbox provisioning/identity/leases (AG5/AG6, shipped); any work-plane status write (dispatch stays `assign`; design adoption stays WH's human ack); a policy engine in agents-worker (ceiling intersection is set math over sealed contracts, not policy evaluation); cross-workspace fleets |

## Relationship to existing work

- **`orun/specs/orun-agents-fleet/` (AF0–AF3)** — the other half; a hard,
  *file-shaped* dependency (the AL posture): the spawn-tool contract, routine
  snapshots, and record folds freeze as fixtures this repo vendors; AF4/AF6/
  AF7 build against a fake runtime replaying them.
- **`saas-agents` (AG)** — the substrate. AF4's spawn door is AG6's sessions
  API called by a session principal; AF6 re-enters AG9's one dispatch door
  (locked decision: no second spawn path); AF8 extends AG10's meters into
  ceilings. The AG9 remainder (ES1 lane consumer, retry budgets with
  park-and-comment) lands *here*, generalized: a fix run is just a routine
  with an event trigger.
- **`saas-agents-live` (AL)** — the wire. Child-session events ride the same
  per-session DO relays; the parent's head renders child lifecycle from its
  own sealed `child_*` events; verdict cards are ordinary approval cards.
  Nothing in the relay changes.
- **`orun-work-v4` (WH)** — the consumer of delegation. A WH design
  competition ("run several, compare, adopt one") is an orchestrator session
  fanning out N design children and returning a judged comparison; adoption
  stays WH's human-only approval ladder. The mock's `orchestrator-01 ·
  drafting design alternatives` row is exactly this.
- **`saas-event-streaming` (ES)** — AF6's event triggers are an ES1 lane
  consumer (the doorbell-not-truth discipline: fire → re-check the fold →
  dispatch door).
- **`saas-console-ux` / `orun-work-v5` (WV)** — the Northwind language. The
  fleet home follows the WV extraction discipline: this epic's `design.md`
  §2 is the committed extraction of `Northwind_Agents.html`, and the truth
  captions are part of the design language.
