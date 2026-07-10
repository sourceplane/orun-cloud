# saas-agents-live — Design (the relay as attach server, the console as head)

Status: Draft (normative once AL6 lands)

Written against repo reality as of 2026-07-10: `apps/agents-worker` ships
provisioning (Daytona, BYO keys), the three-way-gated runtime routes
(`heartbeat` / `events` ingest with `ON CONFLICT (session_id,seq)` dedupe /
lease-gated `token`), the `*/5` sweep, autonomy + dispatch, and entitlement.
The console ships the Agents fleet view and a session detail page that polls
`session_events` at 5s (`LIVE_POLL_MS`, `session-detail.tsx`) and renders raw
event rows. The sandbox runs `bootstrapScript` (a bash heartbeat loop) because
`orun agent serve` does not exist yet. The per-session DO, R2 mirror, SSE
tail, and the steer/approval return queue are the explicitly-remaining AG6
slices. The paired orun epic (`orun/specs/orun-agents-live/`) defines attach
v1 — frames, transports, multi-head semantics — with golden fixtures as the
cross-repo contract.

---

## 1. What changes, in one table

| Piece | Today (AG as-built) | After this epic |
|---|---|---|
| Event path | sandbox → `POST /events` → Postgres; console polls at 5s | sandbox → DO (ingest unchanged in shape) → R2 mirror + Postgres index + **SSE fan-out of attach frames** to every head |
| Return path | none (steer/approvals unreachable) | head → `POST …/input` → DO queue → body long-poll → driver; attributed `message_user`/`approval_resolved` in the sealed log |
| Console session page | read-only event rows | a full head: streaming chat, composer, approval cards, tool cards, inspector |
| External heads | impossible | `orun agent attach as_…` — the TUI over the same api-edge facade, indistinguishable from the console |
| In-sandbox supervisor | `bootstrapScript` bash loop | `orun agent serve` (orun AL4); the bash dies |
| Cost meters | `sessions_started` only | `session_minutes` + `tokens` from relayed `cost_sample`s (closing AG10) |

## 2. The per-session DO: an attach server, still a relay

The DO keeps the `saas-agents` §4.2 contract — **fan-out, never authority** —
and gains exactly the attach-v1 surface (`orun/specs/orun-agents-live/
attach-protocol.md`, P§):

### 2.1 Upstream (body-facing)

- `POST /sessions/{id}/events` — unchanged route, unchanged three-way gate;
  batch items are attach `event` frames (they already share the sealed
  `AgentSessionEvent` shape, so this is a formalization, not a migration).
  The DO dedupes by seq, appends to its write-ahead buffer, flushes to R2
  (chunked segments) + the `session_events` index, then fans out.
- `POST /sessions/{id}/stream` — **new, best-effort**: `delta` frames.
  Fan-out only; never buffered past the connected heads, never stored, never
  metered. A dropped delta costs smoothness, nothing else (P§2).
- `GET /sessions/{id}/inputs?cursor=` — the return queue: the body long-polls
  for head input frames (steer / verdict / interrupt / end), FIFO with a
  cursor, at-least-once (the body's `ref`-keyed idempotency absorbs
  redelivery). Gated identically to ingest — only the session's own
  principal, only within lease.

### 2.2 Downstream (head-facing)

- `GET /sessions/{id}/attach` — SSE. Emits `hello` (session meta + latest
  seq), replays `event`s from R2/index past the client's `Last-Event-ID`
  cursor, emits `live`, then fans out live frames including deltas and
  `presence`. SSE ids are the event seq, so browser auto-reconnect *is* the
  resume protocol (P§5).
- `POST /sessions/{id}/input` — one head frame per call. api-edge stamps the
  authenticated principal (§4); the DO enqueues and `ack`s (frame-level ack
  relayed back on the SSE channel).

Authorization: heads need `agent.session.read` (attach) and a new
`agent.session.interact` (input) — deny-by-default through the policy worker
like every `agent.session.*` action. Interact is distinct from read
deliberately: watching a session and steering it are different grants, and
approval authority is the sharpest permission in the product.

### 2.3 Durability posture (unchanged in kind)

The DO is reconstructible: R2 + `session_events` carry everything sealed;
the input queue is small and lease-bounded (a lost queue on DO eviction means
a head re-sends — `ref` idempotency again). The system of record remains
orun's sealed session; the relay remains a projection. N sessions = N DOs.

## 3. The console head (AL7)

The session page (`components/agents/session-detail.tsx`) upgrades in place
from event-row viewer to head. The presentation contract is shared with the
TUI head (orun design §5) — same folding, same affordances, web-native
rendering:

- **Conversation**: user turns (attributed, with principal chips), agent
  turns as rendered markdown, deltas streaming into the in-progress turn.
- **Tool cards**: collapsed one-liners, expandable to args/result fetched
  from transcript refs; bursts coalesce.
- **The activity line**: current tool / thinking, elapsed, token ticker from
  `cost_sample`s.
- **Approval cards**: sticky above the composer, impossible to miss;
  approve/deny posts a `verdict`; resolved cards show who answered, from
  which surface. The fleet view and the org-wide topbar get an
  **attention badge** for unattended asks (the `awaiting_approval` state
  already exists — it finally has a doorbell).
- **Composer**: always-on input; send = `steer` (optimistic "queued" until
  the log echoes it); interrupt and end as explicit buttons (the web is not
  modal — no Esc semantics).
- **Inspector rail**: the existing infra facts + task/PR/snapshot pills,
  joined by the brief id, tool policy, cost-to-date, and presence chips
  (who's attached, TUI or console).
- **The poll dies**: SSE with `Last-Event-ID` resume; the 5s poll remains
  only as a degraded fallback when SSE is unavailable.

Fixture-driven: the page renders the shared golden sessions in Storybook/da
tests exactly as the TUI renders them in Go tests — the "same head, two
renderers" claim is checked, not asserted.

## 4. The api-edge facade & external heads (AL8)

api-edge forwards `GET …/attach` (SSE pass-through, actor headers set as
everywhere) and `POST …/input`. The **principal stamp happens here**: the
input frame envelope gains `principal` from the resolved bearer — a console
user, or a CLI user via the existing `cliauth` bearer path — and the DO/body
treat any inbound self-declared identity as spoofing (dropped, the
`x-actor-*` discipline applied to frames).

`orun agent attach as_…` (orun AL4) is then just another consumer of these
two routes. Nothing in the relay distinguishes it from the console — that is
the interchangeability property, and it is tested by driving both head types
against one fixture body and diffing the logs.

**Handoff affordances** (the product moment):

- Session page → "**Continue in terminal**": copies `orun agent attach
  as_7f3c…` (the desktop-app grammar users already know).
- TUI inspector → the console deep link (`/orgs/{slug}/agents/{sessionId}`),
  printed on attach and on `orun agent ps`.
- Spawn dialogs and dispatch notifications carry the same link pair.

**Notifications** (AL8, via notifications-worker): `approval_requested`
older than a threshold with zero attached heads → push/email to the session
spawner and profile owner ("implementer is waiting for permission:
`contract_propose` on ORN-142"); terminal states → outcome notification with
the PR link. Notification taps deep-link to the session page; the email
variant includes the attach command.

## 5. Suspend/resume, completed (AL9)

Suspend (idle or explicit) already snapshots the box; what it loses today is
the *conversation*. With the harness session id captured as a
`harness_event` (orun AL1) and mirrored here, resume = re-provision from
snapshot → `orun agent serve --resume` → the driver continues the same
harness session; heads simply re-attach (their cursor never went stale —
seq is global to the session, not the box). `state_changed{suspended}` /
`{running}` render as timeline dividers in both heads.

Retention: R2 mirror + relay index follow the sealed session's lifecycle;
after seal + configurable retention, the mirror GCs and reads serve from the
sealed object (replay), keeping the relay a cache in the limit.

## 6. Metering (closing AG10's remainder)

`cost_sample` events now actually flow (the Claude Code driver emits them;
the relay sees every one): agents-worker aggregates per session →
`agents.tokens`; lease heartbeats already bracket wall-clock →
`agents.session_minutes` on terminal transition. Both emit through the
shipped metering binding, fire-and-forget. Input frames are deliberately
unmetered in v1 (steering your own agent is not a billable verb).

## 7. Security posture, delta only

Everything in `saas-agents` §9 stands. New surface, new lines:

- **`agent.session.interact`** is the only new permission; approval verdicts
  and steering ride it. Read ≠ interact (§2.2).
- **Frames are data, never instructions to the platform.** The relay parses
  frame envelopes only; payloads pass opaque. The body validates inputs
  against its pending state (a verdict for a non-pending request is a no-op
  ack) — the cloud cannot be tricked into approving by replay.
- **Attribution is edge-stamped** (§4); the sealed log's `principal` fields
  are therefore as trustworthy as api-edge's actor resolution, which is the
  platform's existing trust root.
- **Deltas leak nothing new**: they carry the same text the sealed
  `message_agent` will carry; they are simply earlier and unstored.

## 8. Acceptance narrative (the story both repos must pass)

Dispatch from the Work tab boots a Daytona body. The console session page
streams the first turns live. A laptop runs `orun agent attach as_7f3c` and
replays into the same live state. The agent requests a gated tool; both
heads show the card; the terminal answers first; the console shows the
resolution, attributed to the laptop principal, within a second. The console
user steers; the TUI shows the steer with the console user's chip. The TUI
detaches; the session suspends idle overnight; morning resume continues the
same conversation; the session completes; both surfaces show the identical
sealed replay — conversation, approvals, principals — and so does
`orun agent replay as_7f3c` offline. Every sentence is a test somewhere in
AL6–AL9 (orun AL4 owns the terminal-side sentences).
