# saas-dispatch — Design (the front door)

Status: Draft (normative once DX0 lands)

Written against repo reality as of 2026-07-20. The Workspace Agent ships
(`apps/chat-worker`: `WorkspaceAgent`/`ChatIndex`/`WorkspaceMemory` SQLite DOs
on the Cloudflare Agents SDK; `session-verbs.ts` = `session_spawn`/`_steer`/
`_interrupt`/`_watch` re-entering the AG9 dispatch door with the chat owner's
credential; `tools.ts` = the read-only platform-MCP roster). The agents fleet
surface ships (`apps/web-console-next` `/agents`, AG7). The work fold ships
(WP1/WP2). The AF attention plane and budget envelopes ship. The console
lands on `/orgs/:slug` (Overview) per `nav-items.ts`. What does not exist: a
surface that composes these, a live cross-workspace "pending" read-model, and
a stated responsiveness budget. This epic adds exactly those.

The whole design obeys one sentence: **Dispatch is a point of view, not a
service.** If a section here reads like it needs a new authority, a new
mutator, or a new execution path, it is wrong — re-derive it as a fold or a
gated call to something already shipped.

---

## 1. The Situation read-model (DX0)

### 1.1 Shape

A per-viewer projection answering three questions at once — *what can I hand
off, what is running, what needs me* — plus the budget that bounds all of it.

```ts
interface Situation {
  ready:       ReadyItem[];       // work fold: ready ∧ unassigned, with evidence
  inFlight:    SessionCard[];     // sessions: provisioning | running | awaiting_approval
  waitingОnMe: AttentionItem[];   // approval_requested (unresolved) + AF6 attention
  budget:      BudgetEnvelope;    // AF9 headroom for the session tree
  cursor:      string;            // fold watermark, for incremental refresh (DX1)
}
```

Each item carries its **plane tag** (`work` | `session` | `governance`) and,
for work items, the fold's *evidence* string ("In review because PR #412 open;
gate `parity` red") — Dispatch reasons over evidence, never a bare enum, the
same contract the Work console consumes.

### 1.2 Composition (a facade, not a store)

`GET /v1/organizations/:orgId/dispatch/situation` is an **api-edge facade**
that fans out to shipped workers with the caller's resolved actor and folds
the results:

| Section | Source | Call |
|---|---|---|
| `ready` | work fold | `work_query(ready ∧ unassigned)` (the same fold the Work tab uses) |
| `inFlight` | agents control plane | `GET /agents/sessions?state=live` (AG7 list, viewer-scoped) |
| `waitingОnMe` | sessions + attention | unresolved `approval_requested` across `inFlight` + the AF6 attention feed |
| `budget` | billing/fleet | the AF9 envelope read |

No new persistence: the facade owns no table. It is a read composition, cached
only at the edge of a single request. This is what makes lock 2 (no stored
status) free — there is nowhere to write one.

### 1.3 Authorization (lock 4)

The fold runs **as the viewer**. Every section is filtered to what the
viewer's RBAC already permits — a member who cannot see a project's sessions
never sees them in `inFlight`. This is why the live layer (DX1) is a doorbell,
not a shared cache: two viewers of the same workspace can have different
Situations, and the read-model refuses to blur them.

---

## 2. The DispatchIndex — a live Situation, pushed not polled (DX1)

### 2.1 Why a new object, and why here

DX0 is correct but a *request*; a dispatch that reloads the world on a 5s
timer is not "quick and responsive." The live layer is a per-workspace object
that learns *when* the world changed and tells attached heads to re-fold —
coarsely, cheaply, and only the section that moved.

It lands in **`chat-worker`**, as a new SQLite class `DispatchIndex` named
`ws:<orgId>` — a sibling of `ChatIndex`/`WorkspaceMemory`. That worker is,
by AN charter, **unprivileged**: no control-plane service bindings, only
public surfaces reached with the caller's credential. Putting the live
dispatch layer there keeps lock 7 (unprivileged) structural — a compromised
dispatch brain can reach nothing the viewer couldn't.

### 2.2 Doorbell, not truth

```ts
export class DispatchIndex extends Agent<Env> {
  // subscribes to the workspace ES lane (read-only) as a DOORBELL
  async onLaneEvent(e: LaneEvent) {
    const section = classify(e);          // session.* → inFlight/waitingОnMe;
                                          // work.* → ready; budget.* → budget
    if (!section) return;                 // ignore events that move nothing here
    this.bumpCursor(section);
    this.fanOut({ t: "situation:invalidate", section, cursor: this.cursor });
  }
}
```

The object holds a **coarse change cursor** and a cached *viewer-agnostic
shell* (section counts + skeleton) for instant first paint — never authorized
content. On an invalidate, each attached head does an **incremental,
authorized re-fold** of just that section via the DX0 facade (its own
credential). The ES lane is the ES1 lane contract already used by the AF
trigger consumer; Dispatch is a second reader, and — like that consumer —
treats the lane as "something changed, re-check the fold," never as truth
(the AN3 doorbell-not-engine pattern, reused).

### 2.3 The wire

The head socket is **attach v1** — the same frame vocabulary AN1 carries for
session relays, extended with two dispatch frames (`situation:snapshot`,
`situation:invalidate`). Reusing attach v1 means reconnect-by-cursor,
hibernation, and the console's socket client all come for free (lock: no
second vocabulary, AN decision 2). A degraded client falls back to the DX0
request on an interval; with push shipped, that interval is a slow backstop
(30s), not the 5s hot path — which **retires** (AN2 killed the session poll;
DX1 kills the fleet/work poll on this surface).

---

## 3. The Dispatch surface (DX2)

`/orgs/:slug/dispatch` — a two-pane command surface.

- **Left — the command line.** The Workspace Agent thread (AN4): durable,
  resumable, streaming. This is where intent is spoken ("what broke
  overnight?", "ship ORN-142", "pause the staging session"). Tool cards and
  child-session cards fold inline exactly as AN5 already renders them.
- **Right — the Situation rail.** The DX1 live model as four stacked,
  collapsible cards: **Ready** (hand-off buttons that call `session_spawn`
  through the ladder), **In flight** (live session chips linking to the
  session page, with a steer/interrupt affordance via AN5), **Waiting on me**
  (approval cards — surfaced here, answered on the session page, lock 5), and
  **Budget** (headroom with the AF9 refusal posture).

**Two planes, visibly (D5).** A card never shows one merged "status." ORN-142
reads: `Session as_… · completed` beside `Task ORN-142 · In review (PR #412
open, gate parity red)`. The honesty is the UX.

**Cmd-K** over the same fold — "dispatch all ready", "jump to session as_…",
"mute morning brief" — U-track conventions (empty/skeleton, URL scope). The
first-run empty state is guided, not blank: "Connect a provider, then ask me
to ship something" with the two provider affordances inline (the AG12 cards).

---

## 4. The responsiveness contract

Dispatch is held to a budget, and DX5 enforces it as CI synthetics. Numbers
are targets (p50 unless noted); the *mechanics* that make them reachable are
the design's obligation, not aspiration.

| Moment | Budget | Mechanic |
|---|---|---|
| Dispatch first meaningful paint | ≤ 150 ms | **Snapshot-first** (lock 6): the cached shell (ChatIndex list + DispatchIndex section counts) renders before any live fold or DO wake |
| Situation hydrate (authorized detail) | ≤ 400 ms | parallel section folds; coarse-to-fine (counts first, rows lazily) |
| Turn acknowledgement | 0 ms optimistic bubble; `turn:start` frame ≤ 100 ms | the POST returns `202 accepted`; the user bubble is optimistic; the socket carries `turn:start` |
| First model delta | ≤ 1.2 s | **custody resolve runs concurrent with brief assembly**, not before it; a "working" affordance covers the provider TTFT tail |
| Situation freshness after a world change | ≤ 2 s p95 | ES doorbell → `invalidate(section)` → incremental fold; the 5s poll retires |
| Hibernated-DO wake to first frame | ≤ 250 ms | **warm-on-focus**: opening `/dispatch` wakes `WorkspaceAgent` + `DispatchIndex` before the first keystroke; paint never blocks on wake |

Two of these are the load-bearing ones. **Snapshot-first** means a slow fold
or a cold DO can never make the page feel broken — the shell is always
instant, and truth arrives into it. **Custody-concurrent** means the first
token is bounded by the model's TTFT, not by a serial `resolve-key →
assemble → call` chain — the AN custody path is untouched (key still resolves
per turn, never stored), only re-ordered to run alongside prompt assembly.

---

## 5. The front-door swap (DX3)

Today `nav-items.ts` makes Overview the workspace landing and lists Agents as
one product row. DX3:

- Adds **Dispatch** as the home row (icon `LayoutDashboard`/`Sparkles`), and
  makes `/orgs/:slug` **redirect to `/orgs/:slug/dispatch`** for workspaces
  with the flag on.
- **Demotes, does not delete, Overview** — it becomes `…/overview`, a metrics
  view reachable from the rail and from a Dispatch header link. The
  `saas-workspace-overview` content is unchanged; only its billing as *the*
  landing moves.
- Ships behind a **per-workspace flag** (`feature.dispatch_home`) so the
  reshuffle is a rollout, not a big-bang; the nav model stays pure and
  test-covered (the `nav-items.ts` discipline), and `isLinkActive` gains the
  new home row's exact-match rule.

This is deliberately a U-track cosmetic-topology change on top of DX0–DX2: the
surfaces exist; DX3 only decides where the user starts.

---

## 6. Proactive dispatch (DX4) — shipping AN6's deferred plane here

AN6 specified a proactive plane (`this.schedule()` briefs; AF routines
`target: workspace-agent`) and shipped memory but **deferred the proactive
half**. Dispatch is its natural home:

- **The standing brief.** A scheduled turn (`schedule()` on the WorkspaceAgent
  DO) renders as an *attributed, mutable* agent turn — "overnight: 2 sessions
  sealed, 1 parked, budget 62%" — and as an ambient **"N pending" badge** on
  the Dispatch home row sourced from the Situation. Per-thread mute; nothing
  is a second notification path (AL8 still owns doorbells; the brief is a
  *surface*, deduped against notifications by being pull-rendered, not pushed).
- **Routines target the dispatch.** An AF routine firing with
  `target: workspace-agent` becomes a chat turn *through the same gates*
  (dedupe, concurrency, budget) — one dispatch vocabulary, now conversational.
  A firing that spawns work shows up in *In flight* like any other spawn.
- **The line that does not move.** A brief may *propose* ("3 tasks are Ready —
  dispatch all?"); a human confirms. Autonomy still lives on the ladder
  (AN6 §6.3); Dispatch renders the ladder's state, never overrides it.

---

## 7. Security posture, delta only

Everything in `saas-agents` §9, the AN §8 delta, and AF hardening stands.
New lines:

- **No new authority exists to abuse.** Dispatch composes read folds and calls
  the AN5 verbs; the largest new code surface (the situation facade + the
  DispatchIndex) can read only what the viewer's credential opens and can
  *write nothing*. There is no dispatch mutator.
- **The DispatchIndex is a doorbell.** It subscribes to the ES lane read-only
  and holds no authorized content — only counts and a cursor. A compromised
  DispatchIndex leaks section *counts* at worst, and re-folds still authorize
  per viewer.
- **Cross-viewer isolation is a regression test** (DX5): a viewer must never
  receive another viewer's un-authorized pending item through the shared
  object. The test is red if anyone "optimizes" the fold into a shared cache
  without role-bucketing (see risks DX-Q1).
- **Approvals are more visible, not more powerful** (lock 5). The *Waiting on
  me* card is the sharpest affordance in the product; answering still posts a
  human verdict on the session page.
- **The brief is prompt-injectable** (it summarizes fold content). Same
  structural mitigations as AN §8: the toolset cannot execute, verdicts are
  human, spawns are gated; DX5 adds brief-injection fixtures.

---

## 8. Metering

No new model spend: the chat loop already meters `agents.chat_tokens` (AN7),
and proactive briefs are chat turns that ride the **same** AF9 envelope — an
exhausted envelope parks the brief (and the thread's tools), never mid-mangles
a turn. The situation folds are ordinary platform reads, metered as API like
any console read. Dispatch introduces no new meter; it makes the existing
budget *visible* (the Budget card) exactly where spend is initiated.

---

## 9. Provider & model settings (DX6)

### 9.1 Where the delegation model and provider are set today (the as-built map)

Recording this here because the answer was previously scattered across five
files and one epic doc:

| Knob | Where it lives | Set by |
|---|---|---|
| **The model a run uses** | `agent_profiles.model` (free-text model id; console picker in `create-profile-dialog` from `AGENT_MODELS`) | profile create/edit (Agents tab) |
| **The harness** | `agent_profiles.harness` (`claude-code` today) | profile create |
| **The provider key** | config-worker custody under the reserved namespace `agents/providers/<provider>/<name>/API_KEY`; the row in `agents.provider_connections` stores only `secret_ref` + a `…last4` hint | Connect card (Agents tab / Integrations hub) |
| **Non-secret provider details** | `provider_connections.config` JSONB (daytona `{apiUrl?, target?}`; model providers `{defaultModel?, baseUrl?}`) | the same Connect card |
| **Which connection a run rides** | sole-or-`default` selection at spawn (`pickAnthropic` mirror of the provisioning gate); a profile MAY pin one by name | spawn gate |

### 9.2 What DX6 changes

1. **The vocabulary widens** — `daytona · anthropic · openai · openrouter`.
   OpenAI and OpenRouter are model-credential providers on the *identical*
   AG12 path: same one-shot write-only create, same reserved-namespace
   custody (config-worker remains the only decrypt path), same read-only
   verification ping (`GET /models` Bearer for OpenAI-compatible; OpenRouter's
   `GET /key`), same `…last4` hint, same `verified/invalid` pill. A connection
   MAY carry `config.baseUrl` to point an OpenAI-compatible gateway, and
   `config.defaultModel` to seed pickers. **Groundwork for this slice landed
   with this spec change** (contracts + db vocab, migration `860` relaxing the
   provider CHECK, the config-worker namespace guard, the verifier pings, the
   console card fields — enumerated in IMPLEMENTATION-STATUS).
2. **Settings becomes the canonical home.** Today the Connect cards render in
   the Agents tab and the Integrations hub. DX6 adds **`Settings › AI
   Providers`** (settings-nav) rendering the *same* `ProviderConnections`
   component — three doors, one surface, zero new API. Settings is where an
   admin *expects* keys to live; the Agents-tab card stays as the
   point-of-need affordance ("add your AI provider keys" beside where
   sessions spawn), and the hub card stays for discovery.
3. **Model pickers become connection-aware.** The profile dialog's hardcoded
   `AGENT_MODELS` list grows a second source: the workspace's verified model
   connections contribute `{provider, defaultModel}` options, so "which model
   does this delegation use" is answered where the key was saved — a
   provider-details setting, not a code constant.
4. **Chat-loop parity is scoped honestly.** The Workspace Agent's
   `ModelClient` is Anthropic-SDK-only today (`anthropicModel`). DX6 does
   *not* silently swap it: an OpenAI-compatible `ModelClient` behind the same
   seam is a named follow-up (DX-Q6) — until it lands, OpenAI/OpenRouter keys
   power *executor* runs (DX7's managed path resolves keys per interface) and
   are saved/verified/ready, while the chat voice stays on the Anthropic
   connection.

Security posture unchanged by construction: the key never lands in a row, a
DO, a log, or a wire shape; widening the provider list only widens a CHECK
constraint and a regex — both enumerated, both tested.

---

## 10. Delegation interfaces (DX7) — one door, two executors

### 10.1 The product shape

Delegation today has exactly one executor interface: **`orun-sandbox`** — a
Daytona box running `orun agent serve` against a sealed brief, judged by
gates, sealed into orun's object graph. DX7 adds a second:
**`anthropic-managed`** — a Claude **Managed Agents** cloud session spawned
programmatically (beta `managed-agents-2026-04-01`), for work that wants
seconds-to-first-token and a managed runtime more than it wants a sealed,
replayable proof.

The seam is a per-profile choice, phrased in the product as the profile's
**delegation interface**:

```
AgentProfile
  harness:   claude-code            # unchanged (orun driver)
  interface: orun-sandbox | anthropic-managed   # NEW — how this profile's runs execute
```

Nothing upstream of the executor changes: dispatch is still assignment
through the **one AG9 door** (entitlement → autonomy ladder → dedupe →
concurrency → budget), the session row is still the same
`agent_sessions` state machine, the relay is still the per-session DO, the
Situation rail renders both. A managed run is *governed identically and
executed differently*.

### 10.2 Mapping Managed Agents onto the nouns we already have

The Managed Agents API is four concepts; every one lands on an existing
platform noun rather than minting a new one:

| Managed Agents (API) | This platform | Notes |
|---|---|---|
| **Agent** (`POST /v1/agents`: model, system, tools, `mcp_servers`, skills) | the **agent profile** | the control plane materializes/updates one managed-agent definition per profile (id cached on the profile); `tools` is derived from the profile's capability ceiling — narrowing renders as a *smaller toolset*, enforced at definition time |
| **Environment** (`POST /v1/environments`: cloud or self-hosted worker) | a **provider-connection detail** | `config.environment: {type: cloud, networking} \| {type: self-hosted, …}` on the workspace's `anthropic` connection; created lazily, id cached — the "select the environment" step is a Settings detail, not a per-spawn question |
| **Session** (`POST /v1/sessions`: agent ref + `environment_id` + `vault_ids`) | an **`agent_sessions` row** with `sandbox: {provider: "anthropic-managed", id: <session_id>, …}` | the two-step create-then-first-event maps cleanly onto `requested → provisioning → running` |
| **Events** (send `user.message`; stream/webhook `agent.message`, `agent.tool_use`, `session.status_idle`) | the **AttachRelay feed** | the control plane is the session's event client and *translates* into the closed `AGENT_SESSION_EVENT_KINDS` vocabulary — the relay stays a relay, now with a second feeder |
| **Vaults** (`vault_ids`, Anthropic-managed OAuth refresh) | **MCP-credential refs on the connection** | vault ids are non-secret references stored in `config`; the platform never holds the OAuth tokens — a custody *delegation*, disclosed in the spawn consent |

State translation (infrastructure facts only — no status kind exists on
either side, which is exactly why this maps):

| Managed signal | Session state / event |
|---|---|
| session created (sandbox provisioned, idle) | `requested → provisioning` |
| first `user.message` accepted (the brief-as-prompt) | `→ running` |
| `agent.message` / `agent.tool_use` | relayed `message_agent` / `tool_call` events |
| `session.status_idle` | `→ completing → completed` |
| interrupt / archive | `→ canceled` |
| API error / webhook lapse past grace | `→ failed(reason)` — redacted, provider-body never echoed |

Steer/interrupt from the thread (AN5 verbs) forward as further
`user.message` / interrupt calls — same verbs, second wire. Webhooks are the
primary completion signal (the async posture; no held-open SSE from a
Worker); the lease-sweep discipline reuses AN3's timer with the webhook as
heartbeat-equivalent, so a zombie managed session dies by the same clock as
a zombie sandbox.

### 10.3 Trust tiers, rendered — the honesty rule that makes two interfaces safe

The two interfaces are *not* equivalent, and the product says so instead of
averaging them. Every session card, list row, and spawn consent carries the
tier pill:

| | **Sealed run** (`orun-sandbox`) | **Managed run** (`anthropic-managed`) |
|---|---|---|
| Input | content-addressed `AgentBrief` (byte-reproducible) | prompt assembled from the same brief content, *not* sealed by hash |
| Record | sealed `AgentSessionSnapshot` + R2 mirror; `orun agent replay` byte-identical | server-side transcript, fetched and mirrored to R2; replay = transcript replay |
| Mid-run approvals | `ask`-gated tools → human verdicts | none — capability is narrowed *at definition time* (smaller toolset), no verdict channel |
| Egress | allowlist, per-profile | environment networking config (default-restricted; opening it is a consent line) |
| Residency / retention | tenant's own Daytona + A5 retention | Anthropic-managed runtime; **no ZDR / HIPAA BAA** (per current beta) — stated verbatim in the consent |
| Cost | tenant Daytona compute + tokens | tokens + a per-session-hour runtime charge (metered as `agents.managed_session_hours`) |
| Best at | provenance-grade implementation/design runs ending in PRs | interactive runs, research/triage, quick fixes, sub-minute spin-up |

Two structural consequences, adopted as rules:

- **No-ask ceilings only.** Because a managed run has no verdict channel, the
  dispatch door refuses to send a profile whose effective ceiling contains
  `ask`-gated tools down the managed interface (`interface_requires_ask`,
  actionable: narrow the ceiling or switch interface). `awaiting_approval` is
  simply unreachable for managed runs — unrepresentable, not policed.
- **Work-truth is interface-blind.** A managed run that opens a PR is
  observed by the work fold exactly like any other PR; a managed run still
  writes no status anywhere. The WP constitution needs zero amendment.

Routing defaults follow the tiers: `implementation`/`design`/`fix` runs
default to `orun-sandbox`; `interactive` runs default to
`anthropic-managed` when the profile allows both. Defaults, not law — the
profile's interface choice wins, and the spawn consent shows which executor
the click buys.

### 10.4 What is deliberately not adopted from Managed Agents

| Affordance | Verdict | Why |
|---|---|---|
| Multiagent `coordinator` (API-side sub-agent trees) | ✗ | the delegation tree is AF4's — one tree model, one set of caps and ceilings; a managed session is always a *leaf* |
| Managed Agents as the chat voice | ✗ | the Workspace Agent DO is the voice (AN4); its unprivileged-client posture and per-turn custody are load-bearing |
| Agent-definition sprawl | ✗ | one managed-agent per profile, materialized/updated by the control plane; users never touch the raw API objects |
| Anthropic-hosted skills as the golden path | later | orun compositions remain the packaged-expertise plane; revisit if a managed-only workspace emerges |

---

## 11. Acceptance narrative (the story DX must pass)

A user signs in and lands — not on a dashboard, but on the Dispatch. The
shell paints instantly; the Situation hydrates a beat later: three tasks
**Ready**, one session **In flight**, nothing **Waiting on me**, budget 62%.
They type "ship ORN-142." A user bubble appears before they finish lifting
their finger; the agent reads the task and catalog through MCP, states a
plan, and — the ladder at `assist` — renders a spawn card. They confirm; the
spawn passes the AG9 door; ORN-142 moves from **Ready** to **In flight** in
the rail *and* a session card streams in the thread. The child hits an
`ask`-gated `contract_propose`; a sticky card appears in **Waiting on me** and
in the thread; they open the session page and approve — attributed to them.
The child seals with a PR link; the rail shows the session **completed** beside
the task still **In review**. Mid-afternoon they ask "triage why staging p95
doubled" — the quick-runs profile rides the **anthropic-managed** interface,
so a **Managed run** card (tier pill visible) streams findings within
seconds, burning the workspace's own Anthropic key saved under `Settings ›
AI Providers`, and lands `completed` with a transcript ref — no PR, no
status written anywhere. They close the tab. Next morning, the Dispatch home row
wears a "2 pending" badge; the standing brief turn recaps the merge and one
budget mark. Nothing about execution truth changed — the sealed session
still replays byte-identically in orun, and the managed run is labeled as
exactly what it is — because this epic only built a face (and a second door
to the same gates) for what was already true.
