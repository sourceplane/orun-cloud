# saas-agents-native — Design (the SDK relay, the Workspace Agent)

Status: Draft (normative once AN1 lands)

Written against repo reality as of 2026-07-17: `apps/agents-worker` ships the
AL6 relay as-built — a hand-rolled `DurableObject` shell (`relay-do.ts`)
around a pure, storage-injectable `RelayCore` (`relay-core.ts`), SSE head
attach, a POST/long-poll body binding, and edge-stamped input attribution.
The console session page still polls (`session-detail.tsx`, the AL7 remainder
notes "the SSE live tail … replaces the poll when the api-edge attach stream
lands"). Leases are swept by a global `*/5` cron. The Cloudflare Agents SDK
(`agents` npm) appears nowhere in the lockfile; nor do `ai`/`@ai-sdk/*`. The
platform MCP (MCP0–MCP10) is shipped with ~25 task-shaped tools behind
Streamable HTTP. The paired orun repo owns attach v1, frozen as golden
fixtures, whose protocol doc explicitly reserves a bidirectional-stream
transport swap (P§6.3) — the seam AN0 exercises.

---

## 1. What changes, in one table

| Piece | Today (AL/AF as-built) | After this epic |
|---|---|---|
| Relay shell | hand-rolled `DurableObject` + KV storage, SSE out, long-poll back | `AttachRelay extends Agent` (SQLite class): WS both directions, hibernation, SSE + long-poll retained as fallback; `RelayCore` unchanged |
| Console live tail | 5s poll (AL7 remainder) | SDK socket with cursor resume; poll deleted, not demoted |
| Lease reclaim | global `*/5` cron scans Postgres | per-session `this.schedule()` timer reset by heartbeat; cron demoted to backstop |
| Body transport | `POST /events` + `GET /inputs` long-poll | one outbound WS (orun AN0); HTTP binding kept as fallback |
| Conversational surface | none — the console is forms + a session head | the **Workspace Agent**: durable chat per thread, workspace memory, proactive briefs |
| How work starts | human clicks dispatch / routine fires | *also*: "deploy this and tell me when tests pass" — the chat plans and enters the same dispatch door |
| Tool plane for the chat brain | n/a | the shipped platform MCP (25 tools) + three session verbs; nothing new to govern |
| Model spend | sandbox harness burns tenant key | chat loop burns the same tenant key, metered as `agents.chat_tokens` |

## 2. The relay on the SDK (AN1)

### 2.1 What the SDK is adopted *for*

Transport and lifecycle, nothing else. The `Agent` class gives the relay
hibernatable WebSockets (an idle attached head no longer pins the DO the way
an open SSE stream does), `this.schedule()` (§4), and typed RPC — the
machinery `relay-do.ts` hand-rolls today. The SDK's agentic affordances
(`AIChatAgent`, tool loops, model calls) are **deliberately unused here**:
the relay's contract — "fan-out, never authority" (`saas-agents` §4.2) — is
unchanged, and CI keeps it honest the same way it always has: golden-fixture
conformance over attach v1.

### 2.2 The class shape

```ts
export class AttachRelay extends Agent<RelayEnv, RelayMeta> {
  core = new RelayCore(this.ctx.storage as RelayStorage, …);  // verbatim

  async onConnect(conn: Connection, ctx: ConnectionContext)   // head attach:
    // hello → replay past `from` → live; HeadSink backed by conn.send()
  async onMessage(conn: Connection, msg: string)              // head inputs:
    // steer/verdict/interrupt/end frames → core.enqueueInput (edge-stamped
    // principal read from the connection's authenticated attachment state)
  onClose(conn: Connection)                                    // presence
  async onRequest(req: Request)                                // body-facing:
    // POST /events · POST /stream · GET /inputs · POST /inputs/ack — the
    // routes orun dials today, byte-identical; plus GET /attach (SSE fallback)
}
```

`RelayCore` — the event mirror, dedupe-by-seq, input return-queue, presence,
ack bridging — carries over **without a line changed**: its storage interface
is the same KV surface SQLite-backed DOs still expose, and `HeadSink` was
already transport-agnostic (an SSE writer today, a `Connection` tomorrow —
the abstraction earning its keep).

### 2.3 Routing and authorization — unchanged topology

`routeAgentRequest()` is **not** adopted at the edge. The shipped pattern —
api-edge resolves the actor, the worker authorizes
(`agent.session.read`/`interact`), then forwards to the named DO — is
stronger than SDK-default routing and forwards WS upgrades through the stub
untouched. `handlers/relay.ts` changes one call (`getAgentByName` for
`idFromName`) and gains an upgrade path; the deny-by-default policy walls
stand exactly where they are.

### 2.4 The migration (lock 7)

The SDK requires SQLite-backed DO classes; the shipped `SessionRelay` is
KV-backed and cannot convert in place. So: `AttachRelay` lands beside it
under a `new_sqlite_classes` migration; sessions created after the flag flip
resolve to the new binding; old sessions drain on the old class (bounded by
lease TTL + retention — days, not months); the KV class and binding are
deleted one release later. This is safe *because* of the AL posture: the
relay is a projection — R2, `session_events`, and the sealed session carry
everything durable, so the worst case for a mid-drain eviction is a re-attach.

## 3. The console on the socket (AN2)

The session head (`session-detail.tsx`) finally gets the live tail AL7
reserved — as a socket, not the SSE it was waiting on. The SDK client
(`agents/react`'s `useAgent`, pointed at the api-edge facade rather than
SDK-default paths) provides reconnect-with-backoff; resume is the attach
cursor it always was (`from` = highest seq folded — the frame protocol *is*
the resume protocol, so the SDK's own sync machinery stays off). Deltas
stream into the in-progress turn; presence chips go live; the 5-second poll
is **deleted** — with WS + SSE-fallback both server-side, a degraded-mode
poll no longer earns its complexity. Fixture parity with the TUI head (the
AL7 suite) re-runs against the socket transport unchanged — same frames,
same folding, same pixels.

## 4. Lifecycle in the object (AN3)

Today one global cron scans for lapsed leases and due retention across all
sessions. That inverts: on every heartbeat the relay resets a
`this.schedule(leaseTtl, "onLeaseLapse")` timer; on lapse the object itself
reports the session for reclaim (through the same public reclaim path the
sweep uses — the DO gains a timer, not authority: it *reports*, the control
plane still decides and destroys). Retention GC schedules the same way at
seal. The global cron survives as a backstop auditor (catching DOs that
never woke), demoted from engine to alarm. Alongside, the DO's internal
HTTP surface (`stub.fetch("https://relay/…")`) becomes typed RPC — the
hand-rolled route table in `relay-do.ts` was always an RPC layer wearing a
trench coat.

## 5. The Workspace Agent — the voice (AN4)

### 5.1 The noun

One durable conversational agent instance **per chat thread**, class
`WorkspaceAgent`, hosted in a new small worker `apps/chat-worker`, named
`chat:<chatId>` and bound to its workspace at creation (`init` carries
`orgId`; the binding is immutable — a thread never migrates workspaces).
It extends the SDK's `AIChatAgent`: durable message history in the DO,
resumable token streaming to the console's chat surface, the AI SDK loop
underneath. The model rides the **workspace's own Anthropic key** through
config-worker custody — the identical path provisioning uses (AG5), the
identical "platform meters coordination, tenant pays the model" economics
(lock 6).

Why a new worker and not `agents-worker`: agents-worker's charter is
smallness — "no agent semantics, no tool policy, no task state" — and it
holds privileged internals (provision, dispatch, budget folds). The
Workspace Agent is the *opposite* kind of thing: full of agent semantics,
and deliberately **unprivileged** — a client of public surfaces (lock 4).
Separating them keeps both postures honest: chat-worker gets no service
bindings to the control plane's guts; if the chat brain is ever compromised
by a hostile conversation, its blast radius is its owner's credential, which
the RBAC plane already bounds.

### 5.2 What it is for

The front door. "What broke overnight?" folds the attention plane and
catalog into an answer with links. "Ship ORN-142" becomes: a plan stated in
chat → a spawn through the dispatch door → a live child-session card
streaming in the thread → an approval card when the child hits an
`ask`-gated tool → a PR link and a sealed-session reference when it lands.
The user talked to one durable thing; every hand that touched the world was
a governed orun session.

### 5.3 What it is *not*

It never executes. No shell, no file writes, no repo clone, no Terraform —
the tool surface (§6) makes this structural, not aspirational: nothing in
its toolset *can* execute. It also never approves (lock 5), never writes
work-plane status (the MCP surface already made that unrepresentable), and
never authors standing config (the AF routine-hardening rule extends to it:
a chat turn may *propose* a routine; a human enables it).

## 6. The Workspace Agent — the hands (AN5)

### 6.1 The toolset

| Tool | Source | Notes |
|---|---|---|
| ~25 platform tools (catalog, runs, work plane, audit, usage, config) | **shipped platform MCP**, consumed over Streamable HTTP as an MCP client | the entire reason AN5 is small; RBAC/rate-limits/audit/metering apply because every call re-enters api-edge with the chat owner's credential |
| `session.spawn` | new verb → `POST /agents/sessions` via api-edge | passes the AG9 dispatch door + AF4 spawn gates + AF9 budget door — the chat agent is just another gated caller |
| `session.steer` / `session.interrupt` | → the AL input route | attributed to the chat agent as principal, disclosed as agent-authored in the sealed log |
| `session.watch` | attaches the chat DO to the child's `AttachRelay` as a **standing head** | presence shows it (`surface: "workspace-agent"`); child events fold into the thread as live cards |

The standing head is the elegant seam: the Workspace Agent consumes child
sessions through the *same* attach plane every other head uses — no
side-channel between chat-worker and agents-worker exists to secure, and
everything it sees is what a human head would see.

### 6.2 Approvals bridge (and the line that does not move)

A child's `approval_requested` renders as a sticky card **in the chat
thread**, exactly as it renders on the session page; answering it posts a
human's verdict through the existing interact route, attributed to the
human. The Workspace Agent may *recommend* ("this `contract_propose` matches
what you asked for") — the recommendation is chat content, the verdict is
not its to give. Unattended asks keep riding the AF6 attention plane and AL8
notifications; the chat is an additional surface, not a replacement doorbell.

### 6.3 Autonomy

The chat agent's spawns obey the workspace's autonomy ladder like every
dispatch: at `assist`, a spawn proposal renders as a confirm card; at
`auto-dispatch`+, it proceeds and says so. One dial, no chat-specific
carve-out — the ladder finally gets the conversational surface it was
designed to deserve.

## 7. Memory + the proactive plane (AN6)

**Memory.** A per-workspace `WorkspaceMemory` instance (`ws:<orgId>`) holds
durable facts, preferences, and catalog context as **provenanced entries**
(each: content, source turn/session ref, author, timestamp). Chat threads
read it via RPC at brief-assembly; writes happen only through an explicit
`memory.remember` tool call that renders visibly in the thread ("remembered:
staging deploys need EU region"). The console gets a memory page: inspect,
edit, delete. No hidden memory — the platform's proof-plane sensibility
applied to the softest state it has.

**Proactive plane.** `this.schedule()` gives threads standing behaviors —
the morning brief ("overnight: 2 sessions sealed, 1 park, budget 62%"), a
watched-PR digest — each rendered as an attributed agent turn the user can
mute per-thread. AF routines gain `target: workspace-agent`: a firing
becomes a chat turn through the same gates (dedupe, concurrency, budget) —
one dispatch vocabulary, now with a conversational target. Notifications ride
the shipped plane (AL8), deep-linking into the thread.

## 8. Security posture, delta only

Everything in `saas-agents` §9 and the AL/AF hardening stands. New lines:

- **The chat brain is prompt-injectable by design inputs** — MCP tool
  results, child-session events, and memory entries are all *content* to the
  loop. Mitigations are structural, not prompt-y: the toolset cannot execute
  (§5.3), verdicts are human (lock 5), spawns are gated (§6.3), memory
  writes are visible (§7), and the chat principal's RBAC bounds every call.
  AN7's eval suite includes injection fixtures as regression tests.
- **chat-worker is unprivileged** — no control-plane service bindings; its
  only capabilities are the public surfaces its owner's credential opens.
- **Model custody unchanged** — the key resolves at turn time through the
  AG5 custody path, is never stored in DO state, never appears in chat
  content.
- **WS attach authorizes identically to SSE attach** — the upgrade passes
  the same `agent.session.read`/`interact` walls; a socket is not a wider
  door.

## 9. Metering

`agents.chat_tokens` per workspace from the loop's usage samples (BYO key —
the meter is visibility and budget substrate, not billing); chat turns ride
the existing `agents.tokens` budget envelopes so an AF9 ceiling covers the
*whole* tree — conversation included — with the same graceful-refusal
posture (an exhausted envelope parks the thread's tools, never mid-mangles a
turn). Sessions spawned from chat meter exactly as dispatched sessions
always did.

## 10. The amendment (the AG lock, narrowed)

`saas-agents` locked: *"everything with agent semantics is in orun."* As
written, that lock also forbids the Workspace Agent — so this epic amends
it rather than eroding it silently:

> **Amended lock (AN):** everything with **execution semantics** is in orun
> — shell, files, repos, builds, harness supervision, session truth. The
> cloud may host **conversational orchestration**: durable dialogue,
> planning, tool *routing* to governed public surfaces, memory, scheduling.
> The boundary test is capability, not vibes: if a cloud component can
> execute or can acquire un-gated authority, the lock is violated.

Rationale: the original lock's *purposes* — one code path, reproducibility,
small blast radius — are all preserved (the chat brain executes nothing,
holds no privileged bindings, and every effect re-enters gated public
surfaces). What the unamended wording actually protected against was a
cloud *supervisor*; the Workspace Agent is a cloud *client*.

## 11. Acceptance narrative (the story AN must pass)

A user opens the workspace chat and asks "get ORN-142 shipped." The
Workspace Agent reads the task and the catalog through MCP, states a plan,
and — the ladder at `assist` — renders a spawn card. The user confirms; the
spawn passes the dispatch door; a session card appears in the thread,
streaming live (the same frames the session page shows, over the same
relay). The child hits an `ask`-gated `contract_propose`; the card renders
in the thread and on the session page and in a push; the user approves from
the thread — attributed to the user, not the agent. The child seals with a
PR link. Overnight, the thread's morning brief reports the merge and one
budget mark. The user asks "remember that ORN releases want a changelog
entry" — memory shows the entry, provenanced. A week later the routine
`weekly-deps` fires into a fresh thread turn, spawns under the same gates,
and the sealed sessions it produced replay offline in orun, byte-identical —
because nothing about *execution truth* changed in this epic at all.

## 12. What is deliberately not adopted

| SDK affordance | Verdict | Why |
|---|---|---|
| `routeAgentRequest` default routing | ✗ | api-edge actor resolution + policy walls are stronger and already shipped (§2.3) |
| SDK state-sync as the session wire | ✗ | attach v1 is the contract, frozen as fixtures two epics ago; sync would be a second vocabulary (lock 2) |
| `AIChatAgent` for the *relay* | ✗ | the relay has no voice; authority posture is the product (lock 1) |
| SDK MCP *server* | ✗ | the platform MCP (MCP0–MCP10) is shipped and CI-guarded; one tool plane |
| Email transport | later | the notifications plane already delivers; revisit if inbound-email-to-agent earns a milestone |
| Sub-agents / facets | later | the fleet plane (AF) already models delegation where it belongs — in governed sandbox sessions |
