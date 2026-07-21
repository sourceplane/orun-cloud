# saas-copilot-surface — Design (the bridge and the two lenses)

Status: Draft (normative once CX0 lands)

Written against repo reality as of 2026-07-21. What ships today: the
Workspace Agent turn loop in `apps/chat-worker` (`ChatThread.runTurn`:
model stream → `delta` fan-out → tool rounds → durable `msg` rows keyed by
`seq`), the chat-v1 wire (`hello · msg · live · delta · turn · bye`, folded
client-side by `lib/agents/chat-live.ts`), the attach-v1 session wire
(`lib/agents/attach-live.ts`, WS with SSE fallback and cursor resume), the
AN5 session verbs, DX0–DX7 (Situation facade, DispatchIndex, the surface,
managed runs), and per-turn custody/metering. What does not exist: markdown
in the thread, tool calls as anything but a mono line, any way for the agent
to act on the console, a shared component system between the chat and the
session view, or an open protocol a modern frontend engine can attach to.
This epic adds exactly those.

The whole design obeys one sentence: **the surface gets smarter; the
authority does not move.** If a section reads like the frontend framework
gained a credential, a store, or a turn loop, it is wrong — re-derive it as
a translation of a stream that already exists or a call the viewer could
already make.

---

## 1. The Bridge (CX0)

### 1.1 What AG-UI is, and why this dialect

AG-UI is the open agent↔UI event protocol (versioned event vocabulary:
`RUN_STARTED/FINISHED/ERROR`, `TEXT_MESSAGE_START/CONTENT/END`,
`TOOL_CALL_START/ARGS/END`, `TOOL_CALL_RESULT`, `STATE_SNAPSHOT/STATE_DELTA`,
`MESSAGES_SNAPSHOT`, `CUSTOM`), transported as JSON events over SSE, with a
`RunAgentInput` request shape (`threadId`, `runId`, `messages`, `tools`,
`state`, `forwardedProps`). CopilotKit consumes AG-UI natively; so do
assistant-ui and others — which is what makes it a *seam* rather than a
dependency. We adopt the vocabulary, not anyone's runtime.

### 1.2 chat-v1 → AG-UI (the dispatch thread)

The bridge is a **pure function** over frames the DO already emits — same
`seq`, same cursor, no second truth. It lives beside the fold code and is
unit-tested against recorded frame fixtures.

| chat-v1 frame | AG-UI event(s) | Notes |
|---|---|---|
| `turn` phase=start | `RUN_STARTED {threadId, runId}` | `runId` = `<chatId>:<turnSeq>` — derived, never stored |
| `delta {text}` | `TEXT_MESSAGE_CONTENT {delta}` | preceded by one `TEXT_MESSAGE_START` per assistant message |
| `msg` role=assistant | `TEXT_MESSAGE_END` + snapshot increment | the durable row closes the streamed message |
| `msg` tool phase=call | `TOOL_CALL_START {toolCallId, toolCallName}` + `TOOL_CALL_ARGS` | `toolCallId` = the loop's `tool_use` id, verbatim |
| `msg` tool phase=result | `TOOL_CALL_END` + `TOOL_CALL_RESULT {content}` | result payloads may carry a typed card (§4) |
| `msg` error=true | `RUN_ERROR {message}` then `RUN_FINISHED` | the honest error turn stays a first-class event |
| `turn` phase=done | `RUN_FINISHED` | |
| `hello {latestSeq,title}` | `STATE_SNAPSHOT {title, cursor}` | watch door only (§2.3) |

### 1.3 attach-v1 → AG-UI (the delegated-session lens)

Sessions are not conversations — they are activity streams. The bridge maps
them onto AG-UI's state + custom lanes so the *same component system* renders
them without pretending they are chat:

| attach-v1 event | AG-UI event | Notes |
|---|---|---|
| `state_changed {state}` | `STATE_DELTA [{op:"replace", path:"/state", value}]` | the AG7 state machine, verbatim |
| tool/step events | `TOOL_CALL_START/END/RESULT` | same card renderers as the thread |
| log/status lines | `CUSTOM {name:"activity", value}` | plane-tagged (§4), never merged into chat text |
| `cost_sample {tokens}` | `CUSTOM {name:"cost", value}` | the meter tick the lens renders live |
| approval_requested | `CUSTOM {name:"approval", value}` | renders the §6 card |
| hello/cursor | `STATE_SNAPSHOT` | resume watermark |

A **Managed run** (DX7) flows through the identical mapping — its transcript
events normalize to the same vocabulary, and the trust tier
(`Sealed run` / `Managed run`) rides `STATE_SNAPSHOT` so the lens renders it
permanently, never averaged away (DX lock 8, inherited).

### 1.4 Where the bridge lives

`apps/chat-worker/src/agui.ts` (chat dialect) and `agui-attach.ts` (session
dialect): pure modules, no bindings, no I/O — jest drives them directly with
recorded frames (the ChatThread/RelayCore discipline). The DO calls them only
at the two doors below. `packages/contracts/src/agui.ts` pins the event
vocabulary and the `RunAgentInput` subset we accept, with a `v: 1` dialect
version — protocol drift upstream becomes a versioned adapter change, never
a silent break.

---

## 2. The two doors (CX1)

### 2.1 The run door — turn = run

```
POST /v1/organizations/:orgId/agents/chats/:chatId/agui/run
Body: RunAgentInput { threadId, runId, messages: [tail], tools: ClientTool[], forwardedProps }
→ 200 text/event-stream: AG-UI events for exactly this turn
```

Semantics: the door **is** `sendChatTurn` with a streaming response bolted
on. api-edge authorizes the viewer (same policy action as the existing turn
route), forwards to the chat DO; the DO runs the normal turn loop and tees
the same frames it fans to WS heads through the chat bridge into this SSE
response. `messages` in the input is advisory tail only — **the DO's history
is the truth**; a mismatch is resolved by ignoring the client copy. One run
per thread at a time (the existing `turn_in_progress` refusal maps to
`RUN_ERROR {code:"turn_in_progress"}`).

Why turn-scoped rather than connection-scoped: it matches AG-UI's model
exactly (CopilotKit's `HttpAgent` POSTs a run and reads one stream), keeps
the door stateless, and leaves long-lived concerns — multi-viewer fan-out,
reconnect, presence — on the native WS protocol, which already does them
well. **The WS fold remains the resume authority**: on reconnect or on a
second browser, CopilotKit hydrates from the existing history GET + WS fold;
the run stream is only ever the requesting viewer's live turn.

### 2.2 Auth

The browser cannot set headers on SSE; the run door is a `fetch` POST, so
the bearer rides `Authorization` normally. The **watch** door (below) reuses
the established `access_token` query-param carve-out from AN2 (stripped at
the facade before forwarding), on these routes only.

### 2.3 The watch door — passive followers

```
GET /v1/organizations/:orgId/agents/chats/:chatId/agui/watch?from=<seq>
GET /v1/organizations/:orgId/agents/sessions/:id/agui/watch?from=<seq>
→ text/event-stream: bridged events from cursor, live thereafter
```

The same frames every WS head receives, through the same bridge, as SSE.
This is what the session lens (CX4) and any read-only embed consume. It is
deliberately equivalent to the existing SSE fallback plus translation — no
new fan-out machinery, the DO's hibernation posture unchanged.

---

## 3. Client tools — the agent operates the console (CX2)

The single highest-leverage copilot feature, and the one with real security
surface, so it gets the strictest design.

### 3.1 Shape

- The run door's `RunAgentInput.tools` advertises **client tools** for this
  turn: `{name, description, parameters}` from a **closed, versioned
  registry** in `packages/contracts` (`agui.clientTools.v1`). Free-form tool
  advertisement is rejected at the door — the model's tool surface is code,
  not client input.
- The DO merges advertised client tools into the model's tool roster for
  that turn only. When the model calls one, the loop emits
  `TOOL_CALL_START/ARGS` on the run stream and **pauses the tool round**
  awaiting a result (bounded: 60 s, then a synthesized
  `tool_result {error: "client_timeout"}` and the loop proceeds — a closed
  laptop never wedges a thread).
- The browser executes the action via `useCopilotAction` handlers that call
  **the existing SDK with the viewer's own session** — navigation, opening a
  work item, pre-filling (never submitting) a spawn form, copying a link.
  The result returns via
  `POST …/agui/run/:runId/tool-result {toolCallId, content}` — authorized as
  the same viewer, matched to the pending call by id, single-use.

### 3.2 The security stance (lock 4 made concrete)

The agent gains **zero** authority: every client tool either mutates pure UI
state (navigate, highlight, prefill) or performs a read the viewer could
already make. Anything credential-bearing or state-mutating stays a
*server* tool behind the existing AN5 verbs and the ladder. The registry's
review bar: a client tool that could not be safely executed by a hostile
model against a distracted viewer does not enter the registry — prefill,
never submit; open, never approve.

### 3.3 v1 registry

`ui_navigate(route)` · `ui_open_work_item(key)` · `ui_open_session(id)` ·
`ui_prefill_spawn({taskKey, profileId})` · `ui_copy(text)` ·
`ui_highlight_situation(section)`. Six verbs, all reversible, all visible to
the viewer as they happen (each renders a small action chip in the thread —
the agent's hands are always on camera).

---

## 4. Generative UI — cards speak the situation vocabulary

Tool results that reference platform nouns carry a **typed card payload**
beside their text: `{card: {plane: "work"|"session"|"governance", type,
data}}` where `data` is the *existing* contracts shape (`ReadyItem`,
`SessionCard`, `AttentionItem`, `BudgetEnvelope`, provider connection…).
The D5 two-plane guard is inherited: a work card renders fold evidence and
no session state; a session card renders infra state and no lifecycle rung.

CopilotKit's render slots map `card.type` → Northwind components — the same
components the Situation rail already uses, imported, not forked. A card
type without a renderer falls back to the text — generative UI is
progressive enhancement, never a contract the model can break.

---

## 5. The two lenses (CX3, CX4)

### 5.1 Frontend architecture — headless engine, Northwind skin

CopilotKit runs **headless**: `useCopilotChat` for thread state +
`useCopilotAction` for client tools + AG-UI `HttpAgent` pointed at the run
door, with history hydration and live-follow from the existing WS fold. No
CopilotKit CSS ships; every pixel is Northwind. The engine's value here is
the state machine (streaming, tool lifecycle, action dispatch, generative
slots) — not its chrome. All CopilotKit imports live under
`components/copilot/` (lock 8): swapping engines later touches one
directory.

### 5.2 The dispatch thread (CX3)

The DX2 left pane, rebuilt on the engine: streaming **markdown**
(`react-markdown`, already a dependency) with code blocks + copy; tool calls
as collapsible cards (name, args summary, result card or mono tail); action
chips for client tools; stop (interrupt the run door's fetch — the DO turn
finishes server-side and the durable rows stay authoritative, honest and
cheap) and regenerate (a new turn quoting the prior user message); optimistic
user bubble ≤ 100 ms; the composer gains slash-affordances for the AN5 verbs.

### 5.3 The delegated-session lens (CX4)

The session page's event wall, rebuilt on the same components via the
attach watch door: a state timeline (STATE_DELTA), tool cards identical to
the thread's, cost ticks rendered against the AF9 envelope, and
steer/interrupt as **action buttons** that call the existing verbs with the
viewer's credential. A Managed run renders through the same lens with its
tier pill permanent. The result the user feels: *a delegated agent reads
like a conversation you can steer,* and it is visually the same product as
the dispatch thread.

---

## 6. Approvals in-thread (CX5)

`approval_requested` (chat: the child session's event surfaces through the
existing watch of `inFlight`; lens: directly) renders an **approval card**
in-stream: what the agent wants, the tool, the diff/summary, Approve/Deny.
The buttons call the *existing* credentialed approval endpoint as the viewer
— the model cannot invoke them (they are not in the registry), a hostile
stream cannot forge one (the card renders only from server-emitted
`CUSTOM {name:"approval"}` events carrying a server-issued `requestId`).
AN lock 5 survives contact with generative UI.

---

## 7. Responsiveness budget (the DX discipline, extended)

| Moment | Budget |
|---|---|
| Optimistic user bubble | ≤ 100 ms after Enter |
| `RUN_STARTED` at the head | ≤ 400 ms p50 (edge DO, no runtime hop) |
| First `TEXT_MESSAGE_CONTENT` | ≤ 1.5 s p50 (model TTFT dominates; nothing added ≥ 50 ms) |
| Tool card paint after `TOOL_CALL_START` | same frame |
| Session lens first paint | ≤ 300 ms from cached history, live within 1 s |
| Bundle | copilot layer ≤ 90 KB gz over current route; code-split, never on non-chat routes |

The bridge adds **zero** server hops to the token path — that is the whole
point of Option B, and CX6 asserts it with a perf test.

---

## 8. Rollout & reversibility (CX6)

`dispatch.copilot` feature flag (org-scoped setting, default off → staged
on). The native thread and lens remain intact behind the flag through one
full milestone after GA. Kill switch: flag off returns to native rendering
with zero data loss (the DO rows were always the truth). The bridge modules
have no importers outside the two doors — deleting the epic is a bounded,
mechanical change. Protocol pinning: the contracts dialect (`v: 1`) is
asserted against `@ag-ui` types in CI; an upstream breaking change fails the
build loudly instead of drifting silently.
