# saas-agents-native — Implementation status (as-built)

Status: **In flight** — epic authored 2026-07-17 (design merged same day); AN1 shipped.

| Milestone | Status | As-built notes |
|-----------|--------|----------------|
| AN0 (orun) | 🗓️ Planned | — |
| AN1 | ✅ Shipped | **The relay on the SDK.** `agents@0.17.4` adopted in `apps/agents-worker`. `src/attach-relay.ts`: `AttachRelay extends Agent` — hibernatable WS head attach (`onConnect` = hello → replay → live, `onMessage` = head inputs with edge-stamped principal + in-socket acks, `onClose` = presence), the AL6 body routes + SSE fallback byte-identical in `onRequest`; identity chatter off (`sendIdentityOnConnect: false` — the wire is attach v1 only, lock 2). `src/relay-shell.ts`: the transport-agnostic glue (vendor-free, structurally typed) both jest and the DO share — WS sink, connect/rejoin/message handling, the HTTP surface; `RelayCore` carried verbatim **plus one additive method** `rejoin(sink)` (hibernation wake re-registration — no hello/replay, presence-only; a closed relay answers bye). `src/relay-epoch.ts` + env (`ATTACH_RELAY`, `RELAY_CUTOVER_AT`): session-epoch routing (lock 7) — new sessions on the SQLite SDK class, pre-cutover sessions drain on `SessionRelay` (WS upgrade on a draining session refuses 426 → client falls back to SSE); wrangler v2 migration `new_sqlite_classes: ["AttachRelay"]`, both bindings per env. **The AL6 remainder closed:** `handleIngestSessionEvent` now mirrors accepted batches to the relay DO as attach-v1 event frames (best-effort — DB stays the record); the budget interrupt rides the same epoch routing. Head attach/input routes now 404 unknown sessions (no phantom DOs). Conformance: golden fixtures driven through the shell over fake WS connections and the SSE sink produce **byte-identical frame logs**; WS input acks byte-equal the HTTP POST path's; hibernation rejoin shows no loss/duplication/second-hello; agents-worker suite 189 green, typecheck/lint/build green. **Deviation noted:** handlers keep `idFromName` (not `getAgentByName`) so route modules stay vendor-free and jest-testable — same resolution semantics. Live staging drain exercise rides the deploy. |
| AN2 | 🗓️ Planned | — |
| AN3 | 🗓️ Planned | — |
| AN4 | 🗓️ Planned | — |
| AN5 | 🗓️ Planned | — |
| AN6 | 🗓️ Planned | — |
| AN7 | 🗓️ Planned | — |

Pre-existing substrate this epic builds on (shipped elsewhere, recorded here
for orientation): the AL6 relay as-built (`relay-do.ts` + `relay-core.ts` +
attach-v1 contracts/fixtures), the AL7/AL8 console head + edge attribution,
AG5–AG9 provisioning/dispatch/autonomy, AF4–AF9 gates/routines/budgets, and
the MCP0–MCP10 platform tool plane. See each epic's own
`IMPLEMENTATION-STATUS.md` for their as-built truth.
