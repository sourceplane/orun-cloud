# saas-agents-native — Implementation Plan (AN1–AN7, the cloud half)

The cloud-owned milestones. The WebSocket attach binding (AN0) lives in
`orun/specs/orun-agents-native/`. Design refs are to `design.md` (§) here and
`attach-protocol.md` (P§) in the orun AL epic — the frames this epic carries
are frozen there and do not change in AN.

Cross-repo coupling is smaller than AL's by construction: AN0 swaps a
carriage under an unchanged frame vocabulary, and every cloud milestone
through AN3 develops against the existing golden fixtures and fake body.
AN4–AN6 are cloud-only. Nothing below waits on a live sandbox except final
verification, and nothing below waits on AN0 at all (the HTTP body binding
remains valid indefinitely).

---

## AN1 — The relay on the SDK — 🗓️ Planned

- Adopt `agents` in `apps/agents-worker`; land `AttachRelay extends Agent`
  as a `new_sqlite_classes` migration beside the KV `SessionRelay` (§2.4).
- `RelayCore` carried verbatim; `HeadSink` backed by SDK `Connection`s
  (§2.2); WS head attach (`onConnect` = hello → replay → live) and WS head
  inputs (`onMessage`); body routes (`/events`, `/stream`, `/inputs`,
  `/inputs/ack`) and the SSE `GET /attach` fallback in `onRequest`,
  byte-identical to today.
- `handlers/relay.ts`: `getAgentByName`, WS upgrade forwarding; authz walls
  unchanged (§2.3). Session-epoch routing: new sessions → `AttachRelay`,
  draining sessions → old class; removal flag for the KV class one release
  later.
- Conformance: the attach-v1 golden fixtures replay through the WS path and
  the SSE path with identical frame logs; hibernation smoke (idle attached
  head → DO evicted → frame delivery resumes on wake).

**Done when:** a fixture body streamed through `AttachRelay` reaches a WS
head and an SSE head identically (replay + live); a WS-posted verdict
arrives on the body long-poll exactly once; a hibernated DO wakes on both a
body POST and a head message without frame loss or duplication (net of seq
dedupe); the KV-class drain plan is exercised in staging (old sessions
readable to seal, new sessions on SQLite); fixture round-trips are
byte-identical.

## AN2 — The console on the socket — 🗓️ Planned

- `session-detail.tsx` moves to the SDK client (`useAgent` against the
  api-edge facade, custom path — SDK-default routing off, §2.3/§3);
  reconnect = attach-cursor resume; presence chips + deltas live.
- api-edge: WS pass-through on the attach route (upgrade forwarded, actor
  stamped as today).
- **Delete the 5s poll** (no demoted fallback — SSE server-side is the
  fallback, §3). Fixture parity suite re-run over the socket transport.

**Done when:** a live fixture session streams token-level into the console
with sub-second input echo over WS; killing the socket mid-stream resumes
with no gap and no duplicate turns (cursor proof); `LIVE_POLL_MS` and the
poll path are gone from the codebase; parity fixtures render identically to
the AL7 baseline.

## AN3 — Lifecycle in the object — 🗓️ Planned

- `this.schedule(leaseTtl)` lease-lapse timer armed at init, reset on every
  heartbeat; on fire, the relay reports lapse through the public reclaim
  path (the DO reports, the control plane decides — §4). Retention GC timer
  armed at seal.
- The global cron demoted to backstop auditor: unchanged scan, now expected
  to find nothing; a nonzero find is a warn-level signal (a DO that never
  woke).
- `relay-do` internal HTTP surface → typed RPC; `handlers/relay.ts` and
  runtime ingest call methods, not URLs.

**Done when:** a fixture session whose heartbeats stop is reported for
reclaim by its own timer within one lease TTL with the cron disabled; the
backstop cron run on a healthy fleet reports zero findings; no
`stub.fetch("https://relay/…")` call sites remain.

## AN4 — The Workspace Agent: the voice — 🗓️ Planned

- New `apps/chat-worker`: `WorkspaceAgent extends AIChatAgent`, named
  `chat:<chatId>`, immutable workspace binding at init (§5.1); **no
  control-plane service bindings** (§5.1, §8).
- AI SDK loop on the workspace Anthropic key via config-worker custody at
  turn time (lock 6); durable thread history in the DO; resumable streaming.
- Toolset v1: platform MCP over Streamable HTTP as MCP client, **read-only
  tools enabled** (§6.1 first row); tool calls carry the chat owner's
  credential through api-edge.
- Console: Chat surface (thread list + thread view, `useAgentChat`-class
  streaming, tool-call cards); `agent.chat` permission registered,
  deny-by-default.
- Recorded-model fixtures for the loop (turn folding, tool-call rendering,
  custody failure → honest error turn).

**Done when:** a workspace member converses with the agent about live
catalog/runs/work-plane state with streamed responses; a second browser
resumes the same thread mid-stream; a revoked Anthropic connection produces
a visible, retryable error turn (never a hung thread); the chat principal's
audit trail shows every MCP call attributed; no write-capable tool is
reachable (CI-asserted against the tool manifest).

## AN5 — The Workspace Agent: the hands — 🗓️ Planned

- Session verbs: `session.spawn` (→ the AG9 dispatch door via api-edge, all
  AF gates applying), `session.steer`/`session.interrupt` (→ AL input
  route, agent-attributed), `session.watch` (chat DO attaches to the child's
  `AttachRelay` as a standing head, `surface: "workspace-agent"`, §6.1).
- Live child-session cards in the thread (folded from the standing head's
  frames); approval cards bridged into chat, **answered only by humans**,
  attributed to the answering human (lock 5, §6.2).
- Autonomy-ladder rendering: `assist` → confirm card before spawn;
  `auto-dispatch`+ → proceed-and-say-so (§6.3).
- Gated platform-MCP write tools enabled (task_create, task_comment,
  contract_propose — the MCP5 set) under the same visible-in-thread
  discipline.

**Done when:** the design §11 narrative passes end-to-end against staging
through the "child seals with a PR link" sentence; a spawn refused at the
budget door renders the refusal reason in-thread; a verdict POST authored by
the chat principal is rejected server-side (the lock-5 test); presence on
the child session page shows the standing head; every chat-caused session
is indistinguishable in governance terms from a console-dispatched one
(same gates hit, same audit rows — diff-proven on fixtures).

## AN6 — Memory + the proactive plane — 🗓️ Planned

- `WorkspaceMemory` instance per workspace; provenanced entries (content ·
  source ref · author · timestamp); RPC read at brief assembly;
  `memory.remember` tool with visible in-thread confirmation (§7).
- Console memory page: list, inspect provenance, edit, delete.
- Scheduled behaviors via `this.schedule()`: morning brief + watched-PR
  digest, rendered as attributed agent turns, per-thread mute.
- AF routines gain `target: workspace-agent`: a firing = a chat turn
  through the same dispatch gates; parked-routine and refusal semantics
  unchanged (§7).

**Done when:** a remembered fact demonstrably shapes a later thread's brief
(fixture: brief content diff with/without the entry); deleting a memory
entry removes it from subsequent briefs; a routine firing produces exactly
one attributed thread turn gated identically to a session firing; a muted
thread receives no scheduled turns; every memory entry in the console shows
a working provenance link.

## AN7 — Trust: evals · meters · guardrails — 🗓️ Planned

- Eval harness (extending the MCP8 pattern): fixture suites for tool choice,
  grounded answers (no fabricated run/task state), refusal correctness
  (execution requests route to spawns, never to fabricated capability), and
  **injection regression** (hostile content in MCP results / child events /
  memory attempting spawn-escalation, verdict-forgery, memory poisoning —
  all must fail structurally, §8).
- Metering: `agents.chat_tokens` from loop usage; chat spend joins the AF9
  tree/workspace envelopes with graceful in-thread refusal at exhaustion
  (§9).
- Observability: per-turn traces (tools called, tokens, latency) in the
  admin plane; thread-level cost visible to the user.
- Hardening pass: rate limits on chat turns, thread retention policy,
  export, deletion; docs + `IMPLEMENTATION-STATUS` truthing.

**Done when:** the eval suite runs in CI on recorded fixtures and gates
chat-worker merges; an injection fixture that once reached a gate now fails
the suite if regressed; a workspace at 100% budget shows a parked chat with
a working "raise budget" affordance; meters land within tolerance on a
known-cost fixture; a deleted thread is gone from DO state and export
within the retention SLA.

---

## Sequencing note

**AN1 → AN2 → AN3** is the re-platform arc — strictly ordered, fixture-driven,
vendor-free, and immediately useful (AN2 pays AL7's outstanding debt).
**AN4 → AN5 → AN6 → AN7** is the Workspace Agent arc; AN4 can start in
parallel with AN2 (different workers, different surfaces), but AN5 lands
after AN1 (the standing head wants the WS relay, not two transports).
**AN0 (orun) is independent** — it improves verdict latency whenever it
lands and blocks nothing here. The headline demo is AN5's §11 narrative;
AN7 is what makes it shippable to strangers.
