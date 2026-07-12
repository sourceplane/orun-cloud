# saas-agents-fleet — Design (the workforce plane)

Status: Draft (normative once AF4 lands; §2 normative for every AF console
surface from day one)

Written against repo reality as of 2026-07-12: `apps/agents-worker` ships
provisioning over BYO Daytona/Anthropic (AG5/AG12), the three-way-gated
runtime routes + lease sweep (AG6), the autonomy ladder + **one dispatch
door** (`handlers/dispatch.ts`, AG9), entitlement gate + `sessions_started`
metering (AG10), and the per-session DO relay speaking attach v1
(`relay-core.ts`/`relay-do.ts`, AL6). The console ships the fleet view
(`components/agents/agents-workbench.tsx`) and the session head
(`session-detail.tsx` + `conversation-view.tsx` over the shared
`foldConversation` contract, AL7/AL8). `agents.tokens` and
`agents.session_minutes` flow from relayed cost samples (AL9). Sessions have
**no parent linkage**; recurring work has **no trigger**; the fleet view is
a table, not a queue; autonomy is a dropdown; budgets do not exist. The
paired orun epic (`orun/specs/orun-agents-fleet/`, AF0–AF3) defines the
spawn/await tools, the orchestrator + judge session modes, the routine
object kind, and the track-record fold — frozen as fixtures this repo
vendors, the AL discipline.

---

## 0. Design stance

The product being designed is not "more agent features." It is the moment a
workspace stops *watching sessions* and starts *running a workforce* — and
the stance is that this moment must not cost any invariant the first two
epics paid for. Three constants govern every section below:

1. **Attention is derived, with its arithmetic showing.** The fleet home
   says `1 need a verdict` because one session is in `awaiting_approval` —
   a fold anyone can re-run, never a notification row that can go stale.
   Like the work plane's rungs, the needs-you queue renders *why* it thinks
   so, inline.
2. **Trust has an address.** `autonomy: ask` today is a setting; after AF7
   every widening renders with its evidence — `promoted @ 47 runs · 89%
   merged clean · by elena · Jul 20` — the WV rule ("decisions render with
   their address") applied to the sharpest decision in the product.
3. **Every delegation seals.** A parent spawning a child, a routine firing,
   a budget interrupting — each is an attributed event in a sealed session
   log or an audited control-plane row. The workforce is replayable the way
   a single session already is.

## 1. What changes, in one table

| Piece | Today (AG/AL as-built) | After this epic |
|---|---|---|
| Concurrency | N independent session rows | delegation **trees**: parent/root/depth linkage, shared budget, tree kill (AF4) |
| Fan-out | impossible (no spawn path for a running session) | `agent_spawn` tool (orun AF0) → the cloud **spawn door**, ceiling-intersected, capped (AF4) |
| Recurring work | a human clicks, every time | **routines**: cron + ES-lane triggers re-entering the AG9 dispatch door (AF6) |
| The fleet home | a table of rows you remember to check | the **attention plane**: verdict queue first, ranked needs-you fold, topbar badge (AF5) |
| Autonomy | a dropdown set on faith | **earned**: sealed track record → suggested promotion, human ack; automatic demotion (AF7) |
| Cost | meters that report | **budgets** that refuse and interrupt, shared down a tree (AF8) |
| Trust surface | `5 runs · 7d` (a count) | the record: merged-clean rate, gates-green-first-try, verdict grant rate, cost per merged PR (AF7) |

## 2. The Northwind Agents mock, extracted (normative)

This section is the committed extraction of `Northwind_Agents.html`
(2026-07-12), the WV discipline: where mock and doc disagree, fix this
file, then the code. It extends
[`apps/web-console-next/docs/northwind-design.md`](../../../apps/web-console-next/docs/northwind-design.md);
shell, sidebar, and base tokens are inherited and not restated. The mock
draws two screens — the fleet home and the session page — and three of its
rows are deliberately *ahead* of as-built: the `NEEDS YOUR VERDICT` queue
(AF5), the `orchestrator-01 · drafting design alternatives` session (AF4),
and the `5 runs · 7d` profile chips (AF7). The mock is the target; this
epic is the gap.

### 2.1 The fleet home (`/orgs/{slug}/agents`)

Top to bottom, and the order is the design: **what needs you, then what is
moving, then what ran, then what it runs as, then what it runs on.**

- **Header + stat pair.** Page title `Agents` (serif), subtitle in caption
  register: *"Hosted orun sessions on your connected compute. A session is
  infrastructure — what the run achieves lives on Work; a session links to
  its task, never restates it."* Two serif stat numerals: `2 running` ·
  `1 need a verdict` — the second in warn ink (`#9A7B2D`) whenever nonzero,
  ink otherwise. Both are folds (§4.1); neither is stored.
- **Quick-spawn card.** The next agent-ready Work item (`0146 · Settlement
  event webhooks` in the mock) with profile + repo + autonomy chips and a
  single `Spawn session` button; consent caption underneath: *"Runs in your
  Daytona sandbox as sp_coder01 · ANTHROPIC_API_KEY injected at start,
  never stored on the session."* — the AG7 informed-consent dialog demoted
  to a caption because the facts fit on one line.
- **`NEEDS YOUR VERDICT · n`** (AF5) — the attention queue, warn-washed
  (`#FBF7E8` / border `#EFE3C2`), one card per item: *"s_4f21 · coder-01
  wants to run `npx wrangler deploy --env preview`"*, provenance line
  (`work://northwind/0146 · Provider sandbox conformance suite · autonomy
  ask — actions beyond the repo need a human verdict`), then `Deny` ·
  `Approve` · `View session →`. Verdicts from here post the same attach-v1
  input frame as the session page — the fleet home is a head too.
- **`ACTIVE SESSIONS` / `RECENT`.** Rows at work-plane density: state pill
  with live dot (2s pulse, `paused` under reduced motion), id, profile,
  `work://` pointer, one-line activity (*"drafting design alternatives"*,
  *"waiting on your verdict"*), then right-aligned mono columns `131k tok`
  · `22m`. Failed rows say what the failure *didn't* do: *"sandbox expired
  mid-run — task rung untouched."* Tree rows (AF4) indent children one
  level under the root with a `├` gutter glyph; a collapsed root shows
  `3 children · 2 done`.
- **`PROFILES`.** Identity rows: name, type, `claude-code · <model> · owner
  elena · autonomy ask · sp_9c41…`, record chip right-aligned (`5 runs ·
  7d` today; `47 runs · 89% merged clean` after AF7). Caption: *"A profile
  is the identity a session runs as — an agent type bound to a service
  principal with a responsible owner."*
- **`PROVIDERS`.** The AG12 cards, unchanged: `Daytona · sandbox compute ·
  dtn_····7f31 · Verified`, `Anthropic · model key · sk-ant-····k2d8 ·
  Verified`.

### 2.2 The session page (`/orgs/{slug}/agents/{id}`)

As shipped by AL7/AL8, with the mock confirming the grammar and AF adding
three elements:

- The conversation head: tool lines with their policy decision chip
  (`allow`), attributed steers (*"elena · steer · 09:51"*), the sticky
  approval card with the *reason in prose* — *"Deploying the preview leaves
  the repo — policy sends it to you. The verdict lands in the session log,
  attributed."* — and the `Continue in terminal: orun agent attach s_4f21`
  handoff.
- **The children strip** (AF4, new): under the header for any session with
  children — one compact row per child (state pill, type, one-line goal,
  cost), plus `Kill tree` beside the existing kill. Judge results render as
  **verdict cards** in the parent's conversation (the judge child's
  verdict-shaped result, orun AF1), collapsed to one line each.
- **The rails**: `TASK POINTER` (caption: *"Work truth stays on Work — this
  session links to it, never restates it."*), `INFRASTRUCTURE`,
  `ARTIFACTS`, `HEADS` (caption: *"Console and terminal drive the same
  session — the sealed session log is the system of record."*). AF8 adds a
  **`BUDGET`** rail block — `48.2k / 200k tokens` with the two-segment
  meter, warn ink past 80%.

### 2.3 Tokens (deltas over `northwind-design.md`)

| Token | Value | Used for |
|---|---|---|
| `agents.verdict.wash` | bg `#FBF7E8` · border `#EFE3C2` · action ink `#6E5A22` | The needs-verdict queue cards |
| `agents.live.dot` | 6px `#3B76C9`, 2s opacity pulse; `animation-play-state: paused` under reduced motion | Running rows (shared with `work.live.dot`) |
| `agents.tree.gutter` | 16px indent per depth, glyph `├`/`└` in `#A8A8A8` | Child rows under a root |
| `agents.record.chip` | mono 12px `#737373`; the rate in ink when ≥ the promotion bar | Profile record chips |
| `agents.budget.meter` | the `work.meter` spec; consumed segment `#3A8159` → `#C39B45` past 80% | Budget rail + Usage forecast |

## 3. The delegation plane (AF4)

### 3.1 The spawn door

orun AF0 gives the loop two gated tools: `agent_spawn` (type, goal, ceiling
request) and `agent_await` (collect a child's sealed result). The runtime
executes them **as a client**: `POST /v1/organizations/{orgId}/agents/
sessions` with its own session token — the same public route a human
spawn uses, so RBAC, entitlement, audit, and metering apply unchanged. The
cloud-side delta is one policy action and one gate stack:

- **`agent.session.spawn`** — deny-by-default, granted to profiles (not
  humans — humans use the existing create path) whose type declares
  delegation. A session whose principal lacks it gets a policy refusal the
  loop surfaces as a tool error, exactly like any gated tool.
- **Gate stack on the door** (evaluated in the dispatch handler, set math
  and counters — no policy engine): (1) **ceiling intersection** — the
  child's effective capability contract is `parent.effective ∩
  childType.sealed`; a request outside the intersection is narrowed, never
  refused-silently (the applied ceiling is returned and sealed into both
  logs); (2) **depth** — `depth = parent.depth + 1`, default max 2; (3)
  **width** — live children per parent (default 5) and per tree (default
  10), counted from the tree columns; (4) **budget** — the child draws from
  the root's budget envelope (§7); an exhausted envelope refuses at the
  door.

### 3.2 Tree semantics

`agent_sessions` gains `parent_session_id`, `root_session_id`, `depth`
(self-referencing, root rows have `root = id, depth = 0`; one migration,
additive). Lifecycle composes:

- **Kill is tree-transitive.** Killing any node kills its subtree (children
  first, leaf-up, best-effort on sandbox destroy — the sweep finishes
  stragglers). Killing the root is the one-click "stop everything" the
  fleet home exposes as `Kill tree`.
- **The orphan sweep** extends AG6's `*/5` cron: a child whose parent is
  terminal but who is still live past a grace window is failed
  `orphaned` and destroyed — a tree cannot outlive its root's intent.
- **Parents own their children's story.** `child_spawned` /
  `child_completed` / `child_failed` land as sealed events in the
  *parent's* log (emitted by the runtime, relayed like everything else), so
  the parent's head renders the fan-out without the console joining across
  relays. The children strip (§2.2) reads the tree columns for live state;
  the conversation reads the parent's own events for narrative.
- **Suspend does not cascade.** A parent blocked on `agent_await` idles and
  suspends like any session; children keep their own leases. Resume
  re-attaches and `agent_await` re-checks — the await is a poll against
  sealed results, not a held connection.

### 3.3 What delegation is for (the WH consumer)

The mock's `orchestrator-01 · work://northwind/init-storefront · drafting
design alternatives` row is the canonical use: a WH design competition as
one orchestrator fanning out N design children (same brief, varied
approach), running judge children over the drafts (verdict-shaped results,
orun AF1), and completing with a comparison + N draft PRs. **Adoption stays
WH's human-only approval ladder** — the orchestrator ends at evidence, never
at a decision. Same shape later: review panels before risky merges, sweep
migrations with per-file children. The cloud does not know these shapes;
it knows trees, ceilings, and budgets.

## 4. The attention plane (AF5)

### 4.1 The needs-you fold

`GET /v1/organizations/{orgId}/agents/attention` — a pure fold, computed on
read (the AG7 fleet query joined with budget marks and routine state), no
storage:

| Source fact | Attention item | Rank |
|---|---|---|
| session `awaiting_approval` | **verdict** — the card, with the pending request | 1 |
| budget ≥ 80% on a live tree/session (§7) | **budget mark** — "s_9b30 at 84% of 500k" | 2 |
| routine `parked` (§5.3) | **parked routine** — with the last failure | 3 |
| session `failed` on a task with retry budget left | **failed with retries** — offer re-dispatch | 4 |
| lease degraded > grace but not yet swept | **stuck** — "no heartbeat for 6m" | 5 |

Every item carries its provenance (session id, `work://` pointer, the
fact that produced it) — the fold *shows its arithmetic* (§0). Acting on
an item (verdict posted, budget raised, routine resumed, re-dispatched,
killed) removes it by making the fact false; there is no dismiss.

### 4.2 Rendering

The fleet home leads with the queue (§2.1); the org topbar gets the
attention count as a badge (the AL7 "attention badge" generalized beyond
approvals); the sidebar `Agents` entry carries the same count. Notification
policy stays AL8's: unattended verdicts push after the threshold; AF5 adds
a **daily digest** (routines' quiet outcomes + record deltas + spend, one
email/Slack message via notifications-worker) and respects quiet hours.
Nothing else pings — the queue is the product, notifications are its
overflow.

## 5. Routines (AF6)

### 5.1 The registry

`agents.routines`: org-scoped rows binding a **sealed routine definition**
(orun AF2: `agents/routines/*.md` → `RoutineSnapshot` — brief template,
tool policy, quiet contract, content-addressed like agent types) to a
profile, a trigger, a budget, and `enabled`. Cloud config, work-plane
truth untouched. Two trigger kinds:

- **`cron`** — a 5-field expression evaluated by the agents-worker
  scheduled handler (the `*/5` cron generalizes to a scheduler tick;
  minimum interval hourly).
- **`event`** — an ES1 **lane** subscription (`scm.*`, `state.run.*`,
  work-fold transitions). The lane is a doorbell, not truth: on fire, the
  handler re-checks the predicate against the fold, then dispatches. Until
  ES1 lands, the poll fallback the AG9 remainder already planned.

### 5.2 Firing = the dispatch door

A firing routine **re-enters `POST /agents/dispatch`** with a routine
provenance envelope — the same gates (entitlement, dedupe, caps), the same
spawn path, the same session machinery; the session row carries
`routine_id` so the fleet home can group *"nightly-triage ran 07:00 ·
completed · 12k tok"*. Locked decision 3 in one sentence: **there is no
second way to start work.** The canonical launch set: the red-gate fix run
(the AG9 §7.4 shape, now an event routine — *this closes the AG9
remainder*), nightly dependency triage, the PR-steward shape (CI failed on
an agent PR → fix run), weekly spec-drift review.

### 5.3 Quiet by default; park on failure

A routine's success is a digest line, never a ping (the quiet contract is
part of the sealed definition). Failure follows the retry-budget idiom:
two consecutive failed firings → `parked` + one attention item + a
`task_comment` where a task is bound; a parked routine never fires until a
human resumes it. Misfires (worker down over a tick) fire once on recovery
if the predicate still holds — predicates, not backlogs.

## 6. Track record & earned autonomy (AF7)

### 6.1 The record

orun AF3 defines the fold over sealed sessions; the cloud joins it with
what only the cloud sees (PR outcomes via IG, meters, verdict history)
into the per-profile **record**, computed on read and cached:

`sessions (by kind) · merged-clean rate (PRs merged with zero human
commits after the agent's last) · gates-green-first-try · verdict grant
rate (asks approved / asks) · interventions (steers per session) · cost
per merged PR · window (30d/all)`

Rendered as the profile page's centerpiece and the fleet chip (§2.1). No
score, no ranking — named rates with their numerators visible, the
work-plane meter discipline. A rate is a *claim about sealed evidence*;
clicking it lists the sessions behind it.

### 6.2 Two ladders, one movement rule

The product has two autonomy surfaces and AF7 governs movement on both:
**dispatch autonomy** (AG9's `manual → assist → auto-dispatch → full` —
*when sessions start*) and **action autonomy** (the runtime tool policy the
mock chips as `autonomy: ask` — *what a running session does without a
verdict*). Movement is asymmetric by construction:

- **Promotion is suggested, never applied.** When a profile's record clears
  the workspace's promotion bar (default: ≥ 20 sessions in window,
  merged-clean ≥ 85%, zero containment events), the console renders a
  suggestion card *with the record attached*; applying it is a human ack
  that writes the profile/policy row and audits
  `agent.autonomy.promoted {evidence: recordSnapshot}`. The applied
  setting thereafter renders with its address (§0.2).
- **Demotion is automatic and loud.** Triggers: two failed fix runs on one
  task (the AG9 park), a containment event (AF9's injection posture
  tripping), budget exhaustion at `full`. Demotion writes immediately
  (one rung down + park where applicable), lands an attention item, and
  audits `agent.autonomy.demoted {trigger}`.
- **No self-service.** The autonomy write actions are grantable to humans
  only; no MCP tool, no agent tool, no routine can touch them — an agent
  cannot widen any leash, including another agent's (also enforced by
  AF9's fixtures, not just by grant hygiene).

## 7. Budgets (AF8)

`agents.budgets`: ceilings in tokens and/or session-minutes at four grains
— **session** (per-spawn override), **tree** (the root's envelope, drawn by
all descendants), **routine** (per-firing + per-window), **workspace** (the
backstop; plan-tiered by AG10's entitlement). Defaults cascade
workspace → profile → spawn.

Enforcement points, both already on hot paths:

- **At the door** (spawn/dispatch): a spawn that cannot fit its minimum
  envelope refuses with `budget_exhausted` — loud at the gate, the AG12
  posture.
- **At ingest**: the AL9 cost-sample aggregation now also accumulates
  against the live envelope. Crossing 80% emits an attention mark;
  crossing 100% enqueues a **graceful interrupt** on the DO return queue —
  the runtime finishes the current tool call, seals a
  `budget_exhausted` terminal event, and the session completes with
  partial state sealed and resumable evidence intact. Never a hard kill:
  the log is worth more than the last 2% of budget.

Usage & quota gains the fleet forecast strip: spend by profile/routine,
the budget meters, and the month-end projection from the existing meters.

## 8. Metering & entitlement (deltas)

New meters: `agents.sessions_spawned_by_agent` (delegation volume),
`agents.routine_firings`. New entitlement dimensions: `limit.agent_tree_
depth`, `limit.agent_routines`, and the existing `limit.agent_sessions`
now counting a tree's live nodes individually (a tree of 6 is 6). The
D3-open posture (billing outage never parks the fleet) carries over
unchanged.

## 9. Security posture, delta only

Everything in `saas-agents` §9 and `saas-agents-live` §7 stands. New
surface, new lines:

- **A hijacked orchestrator is a bounded orchestrator.** The worst case —
  a prompt-injected parent spawning hostile children — is contained by
  construction: children run *narrower* than the parent (intersection,
  §3.1), depth/width caps bound the blast radius arithmetic, the shared
  envelope bounds spend, and every child is still a full AG6 session
  (own lease, own token, own audit row). The spawn door cannot be talked
  into widening anything; it only intersects.
- **Routines are not a backdoor.** A firing re-enters the dispatch door
  with all gates live; the sealed definition pins the brief template and
  tool policy by content hash — a compromised trigger can at most run the
  routine it was already allowed to run, against a predicate re-checked
  from truth.
- **The record is evidence, not input.** Track-record folds read sealed
  logs; nothing an agent writes mid-session can inflate its own record
  (PR outcomes come from IG webhooks, gate results from the state plane).
  Promotion additionally requires the human ack — belt and suspenders on
  the only decision that widens capability.
- **Audit**: `agent.session.spawned_by_agent`, `agent.tree.killed`,
  `agent.routine.created/fired/parked/resumed`,
  `agent.autonomy.promoted/demoted`, `agent.budget.exhausted` — all via
  `appendEventWithAudit`.

## 10. Acceptance narrative (the story both repos must pass)

A spec's design competition dispatches `orchestrator-01`. The fleet home
shows one root growing three children, each a live row under the tree
gutter; the parent's page shows three verdict cards land as judge children
complete. One child's draft needs a gated deploy; the verdict card appears
on the fleet home's queue and the answer — approved from a phone via the
digest's deep link — lands attributed in the child's sealed log. The tree
completes at 61% of its 500k envelope; the comparison and three draft PRs
hang off the parent; a human adopts one in WH. Overnight, the
`nightly-triage` routine fires at 07:00, completes quietly, and is one
digest line; the `red-gate-fix` routine fires on a failed gate, fails
twice, parks, and is one attention item. By Friday `coder-01`'s record
clears the bar; the console suggests `ask → auto-dispatch` with 47
sessions of evidence attached; elena acks; the profile row shows
`auto-dispatch · promoted Jul 20 · by elena`. A month later the workspace
budget's 80% mark raises one attention item, and `orun agent replay` of
any session in the story — parent, child, routine firing — shows the same
sealed truth the console shows. Every sentence is a test in AF4–AF9 (orun
AF0–AF3 own the tool-semantics sentences).
