# saas-copilot-surface — Implementation Plan

CX0–CX6, each with a "done when". AN/DX/AG/AF are consumed, never changed.
Buildable vendor-free through CX2 (recorded frame fixtures + fake model);
CX3+ adds a live model key for chat smoke only.

---

## CX0 — The Bridge (vocabulary + pure translation)

**Build.** `packages/contracts/src/agui.ts`: the AG-UI event vocabulary we
emit (closed union, `v: 1` dialect tag), the `RunAgentInput` subset we
accept, the client-tool registry types, the card payload envelope
(`{plane, type, data}` over existing contracts shapes).
`apps/chat-worker/src/agui.ts` + `agui-attach.ts`: pure chat-v1→AG-UI and
attach-v1→AG-UI translators (no I/O, no bindings).

**Done when.** Recorded chat-v1 fixtures (a full turn: start → deltas → tool
call/result → durable msg → done; an error turn; a `turn_in_progress`
refusal) translate to the exact expected event sequences; attach fixtures
(state change, tool step, cost, approval) likewise; seq/cursor is preserved
through translation (asserted); contracts + chat-worker typecheck + lint +
tests green.

---

## CX1 — The run & watch doors

**Build.** chat-worker: `POST …/agui/run` on the chat DO (authorize like the
turn route → run the normal loop → tee bridged events into the SSE
response), `GET …/agui/watch` on chat + session (the existing SSE-fallback
path through the bridge). api-edge: pass-through for both (POST body +
SSE; the `access_token` carve-out on watch only). `packages/sdk`:
`agents.aguiRun(orgId, chatId, input)` (returns the event stream) and
`aguiWatchURL(...)` helpers.

**Done when.** A fixture turn driven through the run door yields a valid
AG-UI SSE stream ending in `RUN_FINISHED`; a concurrent second run answers
`RUN_ERROR {turn_in_progress}`; watch resumes from `?from=` with no gap or
duplicate against the WS fold (property test on recorded frames); the DO
hibernation posture is unchanged (no new alarms, no retained SSE state
across hibernation beyond what the existing fallback holds); api-edge +
chat-worker + sdk green, `wrangler deploy --dry-run` green.

---

## CX2 — Client tools

**Build.** contracts: `clientTools.v1` registry (the six §3.3 verbs).
chat-worker: accept `tools` at the run door (registry-validated, rejected
otherwise), merge into the turn's roster, pause-on-client-call with the
60 s synthesized-timeout result, `POST …/agui/run/:runId/tool-result`
(viewer-authorized, id-matched, single-use). sdk: the result post-back.

**Done when.** A fake model that calls `ui_open_work_item` produces
`TOOL_CALL_START/ARGS` on the stream, the loop blocks, the posted result
resumes it, and the final turn embeds the result; the timeout path
synthesizes the error result and completes the turn; an unregistered tool
in the input is rejected at the door (422, test); a result posted by a
different subject or a reused id is refused; all green.

---

## CX3 — The copilot dispatch thread

**Build.** web-console: `components/copilot/` — AG-UI `HttpAgent` against
the run door; headless `useCopilotChat` wired to history GET + WS fold for
hydration/live-follow; Northwind message components (streaming markdown via
`react-markdown`, collapsible tool cards, card renderers over the Situation
components, action chips); stop + regenerate; the six `useCopilotAction`
handlers (SDK calls with the viewer session); optimistic bubble; the
`dispatch.copilot` flag gating the DX2 left pane swap.

**Done when.** Flag on: a turn streams markdown ≤ the §7 budgets (perf
assertions on fixture turns); tool calls render cards with text fallback;
each client action renders its chip and executes viewer-side (jsdom tests
on handlers + presentation model); flag off: the native thread renders
byte-identical to today (snapshot); bundle delta ≤ 90 KB gz, code-split
(size assertion in CI); console tests + typecheck + lint green.

---

## CX4 — The delegated-session lens

**Build.** web-console: the session page event wall on the same components
via the attach watch door — state timeline, tool cards, cost ticks against
the AF9 envelope, steer/interrupt action buttons through the AN5 verbs;
Managed-run rendering with the permanent tier pill; same flag.

**Done when.** A recorded sealed-run session renders timeline + cards +
cost from the watch stream and resumes from cursor after a simulated drop;
a recorded managed-run session renders through the same components with the
tier pill asserted present; steer/interrupt dispatch the existing verbs
(mocked SDK, assertion on args); green.

---

## CX5 — Approvals in-thread

**Build.** The approval card (server-emitted `CUSTOM {name:"approval"}`
only), Approve/Deny through the existing endpoint as the viewer, resolved
state folding back into the stream; surfaced in both lenses.

**Done when.** The card renders only from server events (a forged
client-side event cannot produce it — unit-asserted at the fold); buttons
call the existing endpoint and the resolution event collapses the card; the
model cannot invoke approval verbs (not in the registry — asserted); green.

---

## CX6 — Hardening

**Build.** Perf tests pinning §7 (no added hop on the token path — trace
assertion), a11y pass on both lenses (keyboard, focus, reduced motion,
contrast), the dialect-pin CI check against `@ag-ui` types, kill-switch
drill (flag off e2e), bundle-size regression gate, docs page.

**Done when.** All budgets asserted in CI; the kill-switch e2e passes; a
simulated upstream AG-UI type change fails the dialect-pin check; a11y
checklist recorded in the epic; IMPLEMENTATION-STATUS.md written.
