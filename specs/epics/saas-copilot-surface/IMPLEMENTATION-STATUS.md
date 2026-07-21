# saas-copilot-surface — Implementation Status

As-built truth, recorded 2026-07-21. CX0–CX6 shipped in five PRs on the
merge-and-verify loop (#542 CX0, #543 CX1, #544 CX2, #545 CX3, #546 CX4+CX5,
CX6 riding the closing PR). All milestones landed against their done-whens;
deviations from the design are recorded below, none silent.

## Shipped

| Milestone | PR | As built |
|---|---|---|
| CX0 | #542 | Dialect v1 in `@saas/contracts/agui`; PURE translators (chat-v1 + attach-v1 → AG-UI) — re-homed to `@saas/contracts/agui-bridge` in CX1 so both workers share one bridge; 22 fixture tests |
| CX1 | #543 | Run door (`POST …/agui/run`, turn = run, virtual head on the thread's own fan-out, refusals in-dialect) + watch doors (chat DO + session relay, translation at source); api-edge pass-through; sdk stream clients; 8 door tests over the real ChatThread/RelayCore |
| CX2 | #544 | Per-run `ClientToolBroker` (registry-spec precedence, id-matched single-use resolve, 60 s synthesized timeout); executor seam; `toolId` threaded onto durable rows (the loop's tool_use id rides the stream verbatim); tool-result route 404/403/409 |
| CX3 | #545 | `components/copilot/` — `DispatchDoorAgent extends @ag-ui/client AbstractAgent`, pure door-events fold, six viewer-credentialed action handlers, Northwind thread (streaming markdown, tool cards, action chips, stop/regenerate), `dispatch.copilot` flag |
| CX4 | #546 | Session lens over the watch door: state timeline + permanent tier pill, shared tool lanes, cost ticks, activity, EventSource transport with cursor resume; flag-gated beside the untouched native page |
| CX5 | #546 | Approval card ONLY from server `CUSTOM {name:"approval"}` (guard tested both ways); resolution collapses by requestId; Approve/Deny on the page's existing verdict wire |
| CX6 | closing PR | Dialect-pin CI test against `@ag-ui/core` EventType; kill-switch parse guard (default OFF, explicit opt-in only); this document |

## Design deviations (recorded, deliberate)

1. **The engine is `@ag-ui/client`, not `@copilotkit/react-core`.** The
   design named CopilotKit headless; implementation surfaced that
   `AbstractAgent` (thread state, run lifecycle, abort, subscribers) IS the
   headless engine, while react-core adds ~247 packages (katex, websandbox…)
   the §7 bundle budget cannot absorb — for hooks our resume-authority
   design would bypass. Lock 8 and risk R2 pre-authorized exactly this
   swap. **The seam is kept honest:** `DispatchDoorAgent` is a stock
   `AbstractAgent` — it plugs into CopilotKit's `selfManagedAgents`
   unchanged if the full framework is wanted later, zero backend rework.
2. **CX4 is additive, not a replacement.** The design said "the session
   page's event wall, rebuilt"; the native page (ConversationView,
   approvals, steer, kill) is mature and shipped, so the lens renders
   *beside* it behind the flag rather than tearing it out — the same
   kill-switch philosophy, applied to our own milestone.
3. **CX2's pause model vs stock AG-UI tool flow.** Stock AG-UI ends a run
   on tool calls and expects the client to start a new run with results;
   our loop pauses server-side mid-run and takes a result post-back. The
   door agent owns this divergence client-side (tracker + side channel), so
   the engine above it sees an ordinary continuous stream.
4. **Approvals surface in the session lens (CX5), not the chat thread.**
   Approval events are session-plane facts; the thread's inFlight cards
   already deep-link to the session page where the card now renders
   in-stream. A chat-thread mirror would need a child-session watch fan-in
   — deferred as a tail, not silently dropped.

## Tails (open, tracked)

- **Perf assertions as CI wall-clock tests** (§7): the architectural
  guarantee (zero added hops on the token path — the bridge tees the
  existing fan-out) is structural and reviewed; latency budget *tests*
  against fixture turns were not landed. The bundle gate is likewise
  enforced by dependency discipline (rxjs deduped to 7.8.1; react-core
  rejected) rather than a size-assertion job.
- **a11y pass** (keyboard/focus/reduced-motion audit of the two lenses).
- **Watch-door fan-out ceiling** (Q2) unmeasured.
- **Chat-thread approval mirror** (deviation 4).
- **Generative cards from the situation vocabulary** (design §4): the card
  envelope ships in contracts; tool results don't yet attach typed cards —
  the thread renders text summaries. Wire card payloads in the tool
  executors when the Situation-card renderers are lifted into shared
  components.
