# Epic: saas-copilot-surface

**Give the Dispatch a world-class copilot experience without moving the
brain.** `saas-dispatch` (DX) made Dispatch the front door: a durable
Workspace Agent on Cloudflare, a live Situation rail, delegation through the
AG9 door into sealed sandboxes and managed runs. The *substrate* is the best
version of itself. The *conversation surface* is not: a hand-rolled thread
that renders plain text, a one-line mono row per tool call, no markdown, no
generative UI, no way for the agent to operate the console it lives in. This
epic closes that gap the only way that doesn't sacrifice the moat: the
Durable-Object loop, custody, RBAC, metering, and cursor-resume stay exactly
where they are, and the product adopts **AG-UI** — the open agent↔UI event
protocol — as a second dialect on the same door, with **CopilotKit** (run
headless, styled Northwind) as the frontend engine over **both** surfaces:
the dispatch chat *and* the delegated-agent session lens.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** (design PR) |
| Cluster | **CX** (copilot experience — cloud-only; composes AN/DX/AG/AF, changes no authority) |
| Owner(s) | `apps/chat-worker` (CX1 the AG-UI run/watch doors, CX2 client tools) · `apps/api-edge` (SSE/POST pass-through) · `apps/web-console-next` (CX3 the copilot thread, CX4 the session lens, CX5 approvals-in-thread) · `packages/contracts` (CX0 the AG-UI event vocabulary + card payloads) · `packages/sdk` (run/watch clients) |
| Builds on | `saas-agents-native` AN2/AN4/AN5/AN7 (attach + chat sockets, the Workspace Agent, session verbs, metering) · `saas-dispatch` DX0–DX7 as-built (Situation, DispatchIndex, the surface, managed runs) · `saas-agents` AG7/AG9/AG12 (fleet reads, the dispatch door, BYO custody) · **AG-UI protocol** (`@ag-ui` event vocabulary: `RUN_*`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_*`, `CUSTOM`) · **CopilotKit** (headless `useCopilotChat`, `useCopilotAction`, generative-UI render slots) |
| Decisions locked | (1) **The loop never moves** — no CopilotRuntime ever owns a turn; the DO remains the only author of turns and the bridge is a stateless dialect, not a service. (2) **One protocol, two streams** — chat-v1 and attach-v1 both translate to AG-UI, so one component system renders the dispatch thread and the delegated-session lens. (3) **Turn = run** — an AG-UI run maps 1:1 onto a chat turn; passive followers and reconnect stay on the native WS fold, which remains the resume authority. (4) **Client tools are viewer-credentialed** — the agent may *request* a frontend action; the browser *executes* it with the viewer's own session; RBAC is unchanged by construction. (5) **Generative UI speaks the situation vocabulary** — cards are the plane-tagged shapes from `@saas/contracts`; the D5 two-plane guard is inherited, never re-litigated. (6) **Approvals render, never resolve, in-thread** — AN lock 5 stands; the card answers through the existing credentialed endpoint. (7) **Feature-flagged coexistence** — the native thread stays behind a flag until the CX budget is met; the adapter can be deleted without touching the loop. (8) **Vendor-portable seam** — CopilotKit imports live only in the surface layer; AG-UI is the contract, so the frontend engine is swappable without a backend change. |
| Gate | **Buildable vendor-free through CX2.** The adapter and client-tool loop develop against recorded chat-v1/attach-v1 fixtures and a fake model; CX3+ needs a live model key for chat smoke only (the AN gate discipline, unchanged). |

## Thesis

Every credible 2026 agent product converged on the same finding: the moat is
the runtime — durability, governance, custody, metering, resume — and the
differentiation users *feel* is the surface: instant streaming markdown, tool
calls that render as living cards, an agent that can act on the page it
inhabits, approvals that resolve where the conversation happens. We have the
first half in production and the second half hand-rolled to about 20% of its
potential. The wrong fix is to adopt a copilot framework's *runtime* and
re-implement custody, RBAC, metering, and resume inside it — slower at
runtime, faster only to a demo. The right fix is a **bridge**: teach the
existing Durable-Object streams to speak AG-UI (a bounded, versioned, open
event vocabulary), and let a copilot frontend engine — CopilotKit, headless,
wearing the Northwind design system — do what frontend engines are for.

The payoff compounds across both planes. The **dispatch thread** gains
markdown, streaming polish, generative cards, stop/regenerate, and frontend
actions (the agent opens the work item, pre-fills the spawn form, navigates —
always with the viewer's own credential). The **delegated-agent lens** gains
the same component system over attach-v1: a session becomes a readable
activity stream — state timeline, tool cards, cost ticks — with steer and
interrupt as in-thread actions, and a Managed run renders through the
identical lens with its trust tier visible (DX8 discipline, inherited). Two
streams, one dialect, one component system.

## The one genuinely new noun: the Bridge

Everything else is reuse. The Bridge is the stateless translation layer that
makes the existing wire speak AG-UI:

- **chat-v1 → AG-UI**: `turn:start` ⇒ `RUN_STARTED`; `delta` ⇒
  `TEXT_MESSAGE_CONTENT`; tool phases ⇒ `TOOL_CALL_START/ARGS/END/RESULT`;
  `msg` (durable) ⇒ `MESSAGES_SNAPSHOT` increments; `turn:done` ⇒
  `RUN_FINISHED`. Same `seq`, same cursor, no second truth.
- **attach-v1 → AG-UI**: session events ⇒ `CUSTOM`-typed activity events plus
  `STATE_DELTA` for the state machine; the same fold watermark.

It owns no table, holds no credential, and can be deleted in an afternoon —
which is precisely the property that makes adopting it safe.

## What ships

| Milestone | One line |
|---|---|
| CX0 | The AG-UI vocabulary + pure bridge (chat-v1/attach-v1 → events), contracts + tests |
| CX1 | The run & watch doors: `POST …/agui/run` (turn ⇒ SSE event stream) + passive watch, via api-edge |
| CX2 | Client tools: connect-time registry, DO exposure to the model, credentialed result post-back |
| CX3 | The copilot dispatch thread: CopilotKit headless + Northwind components, markdown, generative cards |
| CX4 | The delegated-session lens: attach-v1 through the same components; steer/interrupt as actions |
| CX5 | Approvals in-thread: HITL cards that resolve through the existing endpoint |
| CX6 | Hardening: perf budget, kill switch, a11y, bundle discipline |

## What this epic refuses to do

No CopilotRuntime service. No LangGraph/CrewAI hop. No second store of
messages. No tool the model didn't already have or the viewer couldn't
already call. No CopilotKit CSS — Northwind renders every pixel. No removal
of the native WS protocol: it remains the resume + multi-viewer authority,
and the flag can always fall back to it.
