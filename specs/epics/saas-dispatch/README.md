# Epic: saas-dispatch

**Make the dispatch the product's front door — fast, conversational, and
always showing what's pending.** `saas-agents` (AG) put the runtime in a box;
`saas-agents-live` (AL) gave the session a live wire; `saas-agents-fleet` (AF)
governed the workforce; `saas-agents-native` (AN) gave the workspace a durable
voice — the **Workspace Agent** that converses on Cloudflare and delegates
every unit of execution to an orun sandbox through the AG9 dispatch door. The
substrate is shipped. What is *not* assembled is the **experience**: today the
front door is a dashboard, and "talk to the agent", "see the fleet", "see
what's Ready", and "answer an approval" live on four different console routes.
This epic composes them into one surface — the **Dispatch** — where you speak
an intent, watch it become governed work, and see everything pending across
the workspace without leaving the page. It builds **almost no new machinery**:
one read-model, one unprivileged relay object, one console surface, and a
responsiveness budget the whole thing is held to.

## Status

| Field | Value |
|-------|-------|
| Status | **Shipped (v1)** — DX0–DX7 merged 2026-07-20 (#516–#524); as-built truth, recorded design amendments, and remaining tails in `IMPLEMENTATION-STATUS.md` |
| Cluster | **DX** (dispatch experience — cloud-only; composes AN/AF/WP/AG/ES, changes none of them) |
| Owner(s) | `apps/chat-worker` (DX1 the `DispatchIndex` DO; DX4 proactive) · `apps/api-edge` (DX0 the situation facade) · `apps/web-console-next` (DX2 the surface, DX3 the front-door swap) · `packages/contracts` (the situation vocabulary) · `packages/sdk` (the dispatch resource) |
| Target branch | `claude/compassionate-wright-041n2p` (design PR), then `main` (PRs merged incrementally) |
| Builds on | `saas-agents-native` AN4–AN7 as-built (the Workspace Agent, session verbs, memory, chat metering) · `saas-agents-fleet` AF4/AF6/AF9 (spawn gates, attention plane, budget envelopes) · `saas-agents` AG7/AG9/AG12 (the fleet read surface, the dispatch door + autonomy ladder, BYO provider connections) · `orun-work` WP1/WP2 (the derived-lifecycle fold + claim join) · `saas-event-streaming` ES (the workspace event lane, consumed as a doorbell) · `saas-mcp-server` MCP (the read-only toolset the chat already holds) · **Claude Managed Agents API** (beta `managed-agents-2026-04-01`: agents / environments / sessions / events / vaults — the DX7 second interface) |
| Decisions locked | (1) **Composition, not capability** — Dispatch adds no tool, no mutator, no authority, and no execution path; it renders shipped folds and calls the shipped AN5 verbs. (2) **The Situation is a fold, never a table** — "what's pending" is computed per request from the work fold + session states + attention plane + budget; nothing writes a status (the WP constitution is inherited, not re-litigated). (3) **Execution never on Cloudflare** — the AN §10 amendment stands unchanged; Dispatch converses and routes, sandboxes execute. (4) **Per-viewer authorization** — the live `DispatchIndex` object is a *doorbell and debouncer*, never a shared authorized cache; every situation item is folded with the viewer's own credential. (5) **Approvals stay human** (AN lock 5) — Dispatch surfaces `approval_requested` more prominently than any surface before it, and still cannot answer one. (6) **Snapshot-first** — no Dispatch paint ever blocks on a live fold or a hibernated-DO wake; a cached shell renders first, truth hydrates into it. (7) **Unprivileged by construction** — `DispatchIndex` lands in `chat-worker` (no control-plane service bindings), so a compromised dispatch brain's blast radius stays its owner's credential. (8) **Many interfaces, one door** (DX7) — delegation gains a second executor interface (Claude Managed Agents) but the AG9 dispatch door stays the *only* way work starts; the interface is a per-profile choice, the session vocabulary is shared, and the trust tier (**Sealed run** vs **Managed run**) is always rendered, never hidden. (9) **BYO pays for every interface** (DX6) — a managed run burns the workspace's own Anthropic key exactly as a sandbox run does; the platform meters coordination on both, never the tenant's model bill. |
| Gate | **Buildable vendor-free through DX1.** The situation read-model (DX0) and the `DispatchIndex` relay (DX1) develop against recorded work/session/attention fixtures and a fake event lane; DX2+ need a live `ANTHROPIC_API_KEY` for chat smoke only (the AN gate discipline, unchanged). |

## Thesis

The hard, principled work is done. AN proved the shape everyone converged on
in 2026 — a durable conversational agent that plans in the cloud and executes
nowhere near it — and did it without eroding a single AG guarantee: one code
path, reproducible runs, a service-principal blast radius. What AN did **not**
do is decide where a user *lands* and what they *see first*. Today they land
on a metrics Overview, and the agent that is supposed to be the front door is
one nav row among a dozen. "Delegation" means opening Work, hovering a task,
clicking Agent. "Checking pending jobs" means holding three tabs — the Agents
fleet for infra state, Work for lifecycle, the attention bell for approvals —
in your head. The product has a brain and no face.

This epic gives it a face, and makes the face fast. A Dispatch is not a new
service; it is a **point of view** over services that already exist: a
conversation on the left, and on the right a single live answer to "what is
ready to hand off, what is in flight, and what is waiting on me." You say
"ship ORN-142"; the ladder gates it; a session card streams in the thread;
an approval surfaces as a sticky card; a PR link lands — and the same right
rail that showed ORN-142 as *Ready* now shows it *In flight* and, a week
later, the session *completed* beside the task still *In review*. Two planes,
never merged, both true. The whole surface is held to a stated responsiveness
budget — first paint before you can read it, an acknowledgement before you
lift your finger, a pending-plane that pushes rather than polls — because a
dispatch that lags is a dispatch nobody makes their home.

## The one genuinely new noun: the Situation

Everything else is reuse. The Situation is the read-model that makes "pending"
a first-class, live thing:

| Section | Folded from | Plane |
|---|---|---|
| **Ready** — dispatchable now | `work_query(ready ∧ unassigned)` (WP fold, with evidence) | work (derived) |
| **In flight** — running now | agent sessions in `provisioning \| running \| awaiting_approval` (AG7) | session (infra) |
| **Waiting on me** — needs a human | `approval_requested` without resolution across the viewer's live sessions + the AF6 attention plane | mixed, human-gated |
| **Budget** — headroom | the AF9 envelope for the session tree | governance |

It is a **fold, not a registry** (lock 2): computed per request, authorized to
the viewer (lock 4), and tagged by plane so the UI can honor D5 (session infra
state and work rung rendered side by side, never collapsed into one "status").
DX0 ships it as a request; DX1 makes it *live* — pushed on change, not polled.

## Milestones at a glance

| ID | Milestone | Buildable vendor-free? |
|----|-----------|------------------------|
| DX0 | **The Situation read-model** — a per-viewer fold `GET /…/dispatch/situation` composing Ready / In flight / Waiting-on-me / Budget from the WP, AG, AF workers via an api-edge facade; typed contract in `packages/contracts`; recorded-fixture tests. No DO yet. | ✅ |
| DX1 | **The DispatchIndex + live push** — a new SQLite `DispatchIndex` DO in `chat-worker` (unprivileged, `ws:<orgId>`), subscribed to the ES event lane as a doorbell; snapshot-first shell + coarse `situation:invalidate(section)` frames over the attach-v1 socket; the AN2-era 5s poll retires where push covers it. | ✅ |
| DX2 | **The Dispatch surface** — `/orgs/:slug/dispatch`: the Workspace Agent thread as the command line + the live Situation rail; two-plane cards; optimistic turn ack; Cmd-K; empty/first-run states; the responsiveness budget as component perf assertions. | live chat smoke only |
| DX3 | **The front door** — Dispatch becomes the post-login landing; Overview demotes to a metrics view; nav reshuffle; feature-flagged rollout; mobile (stacked, command-first) + a11y. | ✅ |
| DX4 | **Proactive dispatch** — ship AN6's deferred proactive plane *into* this surface: a standing brief + an ambient "N pending" badge as attributed, mutable turns; AF routines `target: workspace-agent` render here; per-thread mute. | live chat smoke only |
| DX5 | **Responsiveness + trust hardening** — the budget as CI synthetics; warm-on-focus; custody-concurrent-with-assembly; a cross-viewer authorization regression (a viewer never sees another's un-authorized pending item); brief-injection fixtures. | ✅ |
| DX6 | **Provider & model settings** — one Settings home (`Settings › AI Providers`) for BYO keys + provider details across `daytona · anthropic · openai · openrouter`; per-connection `{baseUrl?, defaultModel?}`; the same custody/verify path for every provider. *Groundwork landed on this branch — see IMPLEMENTATION-STATUS.* | ✅ (verify pings are live-smoke only) |
| DX7 | **Delegation interfaces** — the executor seam goes multi-backend: `orun-sandbox` (the shipped Daytona + `orun agent serve` path) and `anthropic-managed` (Claude **Managed Agents** cloud sessions spawned via API: agent → environment → session → events). One dispatch door, one session vocabulary, visible trust tiers. | needs a live Anthropic key for smoke; state-mapping + relay-feeder logic is fixture-testable |

## Read order

1. This README.
2. [`design.md`](./design.md) — the Situation read-model, the DispatchIndex
   relay, the surface, the responsiveness contract, the front-door swap, the
   proactive plane, security + metering deltas.
3. [`implementation-plan.md`](./implementation-plan.md) — DX0–DX5 with
   "done when".
4. [`risks-and-open-questions.md`](./risks-and-open-questions.md).
5. [`IMPLEMENTATION-STATUS.md`](./IMPLEMENTATION-STATUS.md) — as-built (empty
   until DX0 lands).

## Scope boundary

| In scope (cloud) | Out of scope |
|----------|--------------|
| The `dispatch/situation` fold + facade; the `DispatchIndex` DO + ES-lane doorbell + socket push; the `/dispatch` console surface and its two-plane cards; the front-door landing swap + nav reshuffle; shipping AN6's proactive plane into the surface; the responsiveness budget + its CI synthetics; the dispatch SDK resource + contracts | **The orun runtime, driver, sandbox, attach protocol** (orun-owned) · **the dispatch door, autonomy ladder, spawn gates, budgets** (AG9/AF — Dispatch is their client, unchanged) · **the work fold + mutators** (WP — read-only here; no new status) · **the Workspace Agent's loop, tools, memory, custody** (AN4–AN6 — consumed, the session verbs are not re-specced) · **the platform MCP registry** (MCP — consumed as-is) · **approval authority for agents** (locked out, decision 5) · **the ES lane contract** (consumed as a doorbell; not extended) |

## Relationship to existing work

- **`saas-agents-native` (AN)** — the substrate. Dispatch is the surface AN's
  design doc gestures at when it calls the Workspace Agent "the front door"
  (§5.2) but never assembles; it also ships AN6's *deferred* proactive plane
  (README status: "proactive plane deferred") into a concrete home.
- **`saas-agents-fleet` (AF)** — the governance Dispatch renders but never
  bypasses: the Situation's *Waiting-on-me* is the AF6 attention plane given a
  face; *Budget* is the AF9 envelope; every spawn still passes the AF4 gates.
- **`orun-work` (WP)** — the source of *Ready* and of the two-plane honesty.
  Dispatch reads the fold with evidence and writes no status, ever.
- **`saas-event-streaming` (ES)** — the reason the Situation can be live
  without a poll: the `DispatchIndex` consumes the workspace lane as a
  doorbell (read-only), then re-folds per viewer.
- **`saas-console-ux` / `saas-workspace-overview`** — the surfaces Dispatch
  reorganizes around. Overview is not deleted; it demotes from *landing* to a
  *metrics view*, and DX3 is a U-track reshuffle (empty/skeleton/URL-scope/
  Cmd-K), test-covered and feature-flagged.
