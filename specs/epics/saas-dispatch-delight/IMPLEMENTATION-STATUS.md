# saas-dispatch-delight — implementation status

**Status: Implemented (v1)** — DD1–DD12 landed on `feat/dispatch-delight`
(2026-07-22). Worker, contracts, db, and console suites green
(chat-worker 111, console 789, agents-worker 224, contracts 174, db 976;
api-edge's 12 pre-existing wrangler.jsonc ENOENT env failures are unrelated
and reproduce on pristine main).

## As-built record

- **DD1 — client-tool deadlock.** Fixed in the BRIDGE, not the tracker: for
  registry (client) tools, `translateChatFrame` emits `TOOL_CALL_END` at the
  *call* phase and suppresses it at the *result* phase
  (`packages/contracts/src/agui-bridge.ts`). The browser tracker (unchanged)
  now completes the call while the server loop is paused; regression tests
  wire the tracker against the server's real emission order and pin
  exactly-one-END for both tool kinds (`tests/web-console-next/src/copilot-door.test.ts`).
- **DD2 — single transcript.** `foldEngineEvent` folds to one `items[]`
  (user | assistant | tool | error | note) in arrival order;
  `historyToItems` reconstructs the same shape from durable rows, pairing
  tool call+result, and renders an empty-text assistant turn as a note.
  Order-jump and dangling-stream cases are pinned in tests.
- **DD3 — thread naming.** `deriveChatTitle` (pure, tested) + first-turn
  auto-title in `ChatThread.runTurn`; `setTitle` on thread/DO/index; `title`
  frame fans to live heads and folds in `chat-live.ts`; `PATCH /chats/:id`
  route + `sdk.agents.renameChat`; list UI shows title + relative activity,
  rename/delete inline, `ch_…` demoted to tooltip.
- **DD4 — honest board.** `partitionInFlight` splits `requested` into a
  Queued lane (with age via `humanizeDurationMs` — "19 h", the "1163m"
  regression is a unit test); the brief counts active and queued separately;
  the sweeper reclaims stalled `requested` sessions on the same 30 m horizon
  the UI copy promises (`packages/db` lapsed query + `sweep.ts`
  `never_started` reason; both repos, both tested).
- **DD5 — no raw internals.** `workspaceSystemPrompt` takes the public
  identity (`org_<hex>` + optional slug) with an explicit no-raw-UUID
  instruction; session page header is "«RunKind» run" with the id as
  metadata; `spawnedBy` compacts via `shortPrincipal`.
  *Deferred:* resolving `spawnedBy` to a member display name (needs a
  members read on the session page; follow-up).
- **DD6 — error bubbles.** `RUN_ERROR` and thrown sends append transcript
  error items with a Retry affordance; the transient banner state is kept
  only as the composer's retry source.
- **DD7 — surface-aware advertisement.** `buildActionHandlers` includes
  `ui_highlight_situation` only when the surface provides `highlight`; the
  door advertises `CLIENT_TOOLS_V1 ∩ handlers` — narrowing only.
- **DD8 — per-row busy.** `busyKeys: Set<string>` in the Ready lane.
- **DD9 — rail failure state.** `useSituation` exposes `error`; the rail
  renders an honest retry card instead of `null`.
- **DD10 — composer alive.** Input stays editable during a turn; the
  double-send guard is a synchronous ref; Enter is inert while running.
- **DD11 — a11y.** `aria-live` on streaming/status and degraded chip;
  budget `progressbar` with values; labels on rename/delete/regenerate/tool
  cards; composer `aria-label`.
- **DD12 — scroll/layer.** `pb-24` reservation under the sticky composer;
  follow-scroll disengages when the viewer scrolls up (with a
  "Jump to latest" chip) and re-engages on send.

## Remaining tails

- Deploy + live smoke on app.orun.dev (the container cannot deploy); verify
  turn-latency budget with a live key — the deadlock fix bounds client-tool
  cost by construction, but the p95 numbers need the credentialed gate.
- `spawnedBy` → member display name resolution (DD5 tail).
- The dead "3 in flight" sessions in `ogpic` will clear on the first cron
  tick after deploy (the DD4 sweeper covers `requested`).
- CX's own deferred items (generative cards, chat-thread approval mirror,
  a11y CI lane) remain with the CX epic.
