# Epic: saas-agents-native

**Make the cloud plane agent-native — without moving the brain.** `saas-agents`
(AG) put the runtime in a box and kept the cloud deliberately dumb;
`saas-agents-live` (AL) gave the session a live wire and heads; `saas-agents-fleet`
(AF) gave the workforce governance. What the platform still hand-rolls is the
substrate every serious 2026 agent product now gets from the platform layer:
WebSocket transport with hibernation, per-object scheduling, client state sync
— the exact primitives the **Cloudflare Agents SDK** ships. And what the
platform still *lacks* is the surface users now expect first: a **durable,
conversational agent you talk to** — one that knows the workspace, plans, and
orchestrates execution sessions instead of making the user click a dispatch
button. This epic does both, in that order: the per-session relay **re-platforms
onto the Agents SDK** (same frames, same authority posture, modern transport),
and the workspace gains the **Workspace Agent** — an `AIChatAgent`-class durable
brain that converses on Cloudflare and delegates every unit of execution to the
orun runtime in a sandbox. The AG constitution is narrowed, never repealed:
**conversation and orchestration may live on Cloudflare; execution never does.**

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — authored, ready for review; open decisions in `risks-and-open-questions.md` |
| Cluster | **AN** (agents native — cross-repo; **orun owns the WebSocket attach binding (AN0)**, this repo owns the **SDK relay + console socket + lifecycle + Workspace Agent + memory + trust planes (AN1–AN7)** — paired spec `orun/specs/orun-agents-native/`) |
| Owner(s) | `apps/agents-worker` (AN1–AN3: the relay re-platform + lifecycle) · `apps/chat-worker` (**new**, AN4–AN6: the Workspace Agent DO) · `apps/api-edge` (WS pass-through, chat facade) · `apps/web-console-next` (AN2 socket head, AN4 chat surface) · `packages/contracts` (chat + memory vocabularies) · `apps/metering-worker` (AN7) · `packages/mcp` (consumed, not changed) |
| Target branch | `claude/orun-cloudflare-architecture-da6uad` (design PR), then `main` (PRs merged incrementally) |
| Builds on | `saas-agents` AG5–AG11 as-built (provisioning, session tokens, dispatch door, autonomy ladder) · `saas-agents-live` AL6–AL8 as-built (the attach-v1 relay, console head, edge attribution) · `saas-agents-fleet` AF4–AF9 as-built (spawn gates, routines, budgets, attention plane) · `saas-mcp-server` MCP0–MCP10 (**the Workspace Agent's ready-made toolset**) · `orun/specs/orun-agents-live/attach-protocol.md` (frozen frames; P§6.3 reserves the transport swap AN0 executes) |
| Decisions locked | (1) **The relay stays a relay** — re-platforming onto the Agents SDK swaps the shell (WebSocket, hibernation, `schedule`), never the authority posture: `RelayCore` and the attach-v1 frames carry over verbatim, conformance stays a golden-fixture diff. (2) **Attach v1 is the wire on every transport** — a WS message carries the same frame bytes the SSE line carried; no second vocabulary, no SDK-shaped frames leaking into contracts. (3) **Execution never on Cloudflare** — the AG lock "everything with agent semantics is in orun" is formally **narrowed** (design §10) to "everything with *execution* semantics": the Workspace Agent converses, plans, and routes; every unit of execution is an orun session in a sandbox, entered through the AG9 dispatch door. (4) **The Workspace Agent is a client of public surfaces** — its tools are the platform MCP plus session verbs that re-enter api-edge with the chat owner's credential; budget doors, autonomy ladder, and spawn gates apply unchanged; no service-binding side doors. (5) **Approval authority stays human** — the Workspace Agent surfaces `approval_requested` into the chat and notifies, but can never answer a verdict; the sharpest permission in the product does not delegate. (6) **BYO model key, unchanged custody** — the chat loop burns the workspace's own Anthropic key resolved through config-worker custody (the AG5 path); the platform meters coordination, never the tenant's model bill. (7) **New SQLite classes, no in-place conversion** — the SDK requires SQLite-backed DOs; the relay re-lands as a new class + binding, old sessions drain on the old class (the relay is a projection — nothing sealed is at risk), and the KV class is deleted one release later. |
| Gate | **Buildable vendor-free through AN3.** The SDK relay, console socket, and lifecycle milestones develop against the shared attach fixtures and a fake body (the AL discipline, unchanged). AN4–AN6 need an `ANTHROPIC_API_KEY` for live smoke only — the chat loop's folding, tools, and memory develop against recorded model fixtures; AN7's evals are fixture-driven by construction. |

## Thesis

Two truths coexist and this epic refuses to trade one for the other. First:
the AG decision to keep the brain in the box is *correct* — a laptop session
and a cloud session are one code path, a run is reproducible by content hash,
and the cloud's blast radius is a service principal's. Nothing in 2026 has
made that worse; most of what shipped since has made it look prescient.
Second: the *plane around* that brain is built on hand-rolled machinery the
platform layer now provides — a bespoke SSE fan-out where hibernatable
WebSockets should be, a global cron sweeping leases the object could time
itself, a 5-second poll where a synced socket belongs, and **no conversational
surface at all**, in a product category whose front door is now a chat. The
Agents SDK is exactly the missing substrate, and the trap it lays — hosting
the agent loop in the DO — is one this platform already knows how to refuse.
So: adopt the substrate, keep the constitution. The relay becomes an SDK
`Agent` that is still just a relay. The console attaches over a socket that
is still attach v1. And the one genuinely new noun — the **Workspace Agent**
— is a durable head with a voice: it plans in the DO, remembers in the DO,
schedules in the DO, and the moment work needs hands it does what every
well-governed actor here does — presents a credential at the dispatch door
and gets a sandbox. The prize is the modern product shape at almost no new
trust surface: the chat brain holds no tool semantics the MCP plane didn't
already expose, no authority the RBAC plane didn't already grant, and no
execution path the AG9 door didn't already gate.

## How it maps to the reference (cloudflare/agents)

| Agents SDK primitive | Here |
|---|---|
| `Agent` class on a SQLite DO | AN1 `AttachRelay` (still a relay) · AN4 `WorkspaceAgent` (the brain that owns no execution) |
| WebSockets + hibernation (`onConnect`/`onMessage`) | AN0/AN1: attach-v1 frames over WS both directions; SSE retained as fallback |
| `useAgent` / client state sync | AN2: the console head's socket + presence; AN4: `useAgentChat`-class chat surface |
| `this.schedule()` | AN3: per-session lease + retention timers; AN6: digests and proactive briefs |
| `AIChatAgent` + AI SDK loop | AN4: the Workspace Agent's voice — BYO Anthropic key, resumable streaming, durable thread |
| MCP client | AN5: the platform MCP (MCP0–MCP10) is the toolset — 25 governed tools, zero new tool plane |
| Human-in-the-loop patterns | AN5: `approval_requested` bridges into chat; verdicts stay human (lock 5) |
| Scheduling + email + workflows | AN6: routines can target the Workspace Agent; a firing is a chat turn, not a second execution path |

## Read order

1. This README.
2. [`design.md`](./design.md) — the relay re-platform, the console socket,
   lifecycle-in-the-object, the Workspace Agent (voice · hands · memory), the
   AG-lock narrowing, security posture, metering.
3. [`implementation-plan.md`](./implementation-plan.md) — AN1–AN7 with "done
   when"; AN0 in `orun/specs/orun-agents-native/`.
4. [`risks-and-open-questions.md`](./risks-and-open-questions.md).

## Milestones at a glance (AN0 in `orun/specs/orun-agents-native/`)

| ID | Milestone | Status |
|----|-----------|--------|
| AN0 | *(orun)* Attach binding v2: the body's chatty legs (input long-poll → push; deltas + acks → inline) ride one outbound WebSocket (P§6.3's reserved swap); the durable `/events` batch keeps its confirmed HTTP carriage (amended decision 1a, orun spec); HTTP binding retained as fallback; frames unchanged | ✅ Shipped |
| AN1 | The relay on the SDK: `AttachRelay extends Agent` (SQLite class + migration), WS head attach via `onConnect`/`onMessage`, body routes + SSE fallback in `onRequest`, hibernation; `RelayCore` verbatim; fixture conformance | ✅ Shipped |
| AN2 | The console on the socket: the session head moves from SSE-pending-poll to the attach socket (reconnect = cursor resume), presence and deltas live; the 5s poll dies for good; the body-wire door (AN0's cloud counterpart) lands | ✅ Shipped |
| AN3 | Lifecycle in the object: lease-lapse + retention GC as `this.schedule()` timers reset by heartbeat; the global cron demoted to backstop; the DO's internal HTTP surface becomes typed RPC | ✅ Shipped |
| AN4 | The Workspace Agent — the voice: `WorkspaceAgent` DO per chat thread in new `apps/chat-worker`; AI SDK loop on the workspace's own key; durable conversation, resumable streaming; read-only platform-MCP toolset; console Chat surface | 🗓️ Planned |
| AN5 | The Workspace Agent — the hands: `session.spawn/steer/watch` verbs re-entering the AG9 dispatch door with the chat owner's credential; the agent attaches to child relays as an attributed standing head; approval cards bridge into chat (human-answered); terminal/console handoff affordances | 🗓️ Planned |
| AN6 | Memory + the proactive plane: per-workspace memory (facts · preferences · catalog context) with provenance, inspectable and editable in console; scheduled briefs/digests via `schedule`; routines may target the agent (a firing = an attributed chat turn through the same gates) | 🗓️ Planned |
| AN7 | Trust — evals · meters · guardrails: fixture eval harness for the chat loop (tool-choice + refusal + injection suites); `agents.chat_tokens` metering + budget-envelope extension; chat-agent tool ladder; observability; GA hardening | 🗓️ Planned |

## Scope boundary

| In scope (cloud) | Out of scope |
|----------|--------------|
| The SDK re-platform of the per-session relay + migration; the console socket head; per-object lifecycle; the `WorkspaceAgent` DO, its chat surface, tool verbs, memory, and proactive plane; the AG-lock narrowing (design §10); chat metering + evals; api-edge WS/chat facades | **The orun runtime, driver seam, session host, TUI head, attach protocol definition** (orun-owned; AN0 is orun's one milestone here); sandbox provisioning/identity/leases (AG5/AG6 — reused, not rebuilt); the dispatch door + autonomy ladder + spawn gates + budgets (AG9/AF — the Workspace Agent is their *client*, they do not change); the platform MCP tool registry (MCP — consumed as-is); approval authority for agents (locked out, decision 5) |

## Relationship to existing work

- **`saas-agents` (AG)** — the constitution. This epic narrows lock (3)
  ("compute never on Cloudflare" stands; "no agent semantics in cloud" splits
  into conversation-may / execution-may-not) via the spec-change discipline —
  design §10 is the amendment text.
- **`saas-agents-live` (AL)** — the plane being re-platformed. AN1 absorbs
  AL6's relay as-built (RelayCore, frames, fixtures) and completes AL7's
  remaining tail (the poll's retirement) on better transport. Nothing AL
  sealed changes shape.
- **`saas-agents-fleet` (AF)** — the governance the Workspace Agent inherits
  for free: its spawns pass the AF4 gates, its spend rides AF9 budgets, its
  unattended asks surface on the AF6 attention plane.
- **`saas-mcp-server` (MCP)** — the reason AN5 is small: the 25-tool platform
  MCP *is* the Workspace Agent's toolset; the epic adds session verbs, not a
  tool plane.
- **`orun/specs/orun-agents-native/` (AN0)** — the paired orun milestone; a
  transport binding, deliberately the smallest cross-repo surface yet (the
  frames were frozen two epics ago).
