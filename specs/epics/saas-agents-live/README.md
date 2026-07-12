# Epic: saas-agents-live

**Make the console a head, not a viewer.** `saas-agents` (AG5–AG12) built the
control plane: Daytona sandboxes on BYO keys, session-bound tokens, event
ingest with seq dedupe, leases and sweeps, a console session page. But the
console *watches* a session through a 5-second poll and cannot talk back —
steer, approvals, and the live tail are the explicitly-remaining AG6/AG7
slices. Meanwhile the paired orun epic (`orun/specs/orun-agents-live/`,
cluster **AL**, AL0–AL5) defines the **attach protocol**: one wire between a
session body and any number of interchangeable heads, with the Claude Code
driver, a local session host, and an interactive TUI head behind it. This
epic is the cloud half of that plane: the per-session **Durable Object relay
becomes an attach-protocol server**, the console session page becomes a
**full head** (chat parity with the TUI — composer, approval cards, streaming
turns), and api-edge exposes attach/input so an external head —
`orun agent attach as_…` from any laptop — is indistinguishable from the
console. A Daytona session can then be driven from the browser or the
terminal interchangeably, with every input attributed and sealed into orun's
proof chain.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — authored, ready for review; open decisions in `risks-and-open-questions.md` |
| Cluster | **AL** (agents live — cross-repo, shared with `orun`; **orun owns the protocol + driver + session host + TUI head (AL0–AL5)**, this repo owns the **relay + console head + handoff (AL6–AL9)**) |
| Owner(s) | `apps/agents-worker` (the per-session DO + attach/input routes) · `apps/api-edge` (attach facade, SSE pass-through) · `apps/web-console-next` (the console head) · `packages/contracts` (attach frame types + shared fixtures) · `apps/notifications-worker` (AL8) · `apps/metering-worker` (AL9) |
| Target branch | `claude/orun-agents-evolution-e1eyx5` (design PR), then `main` (PRs merged incrementally) |
| Builds on | **`orun/specs/orun-agents-live/` (AL0–AL5 — the protocol + fixtures; hard dependency, frozen at AL0)** · `saas-agents` AG5/AG6 as-built (provisioning, session tokens, `POST /sessions/{id}/events` ingest + seq dedupe, heartbeat/lease/sweep) · AG7 as-built (the Agents tab + session detail this epic upgrades in place) · `saas-event-streaming` (SSE conventions) · `apps/notifications-worker` (AL8 delivery) |
| Decisions locked | (1) **The DO relay speaks attach v1, nothing bespoke** — the relay's SSE frames and input queue are byte-identical to the frames the local unix socket carries; conformance is a file diff against the shared golden fixtures, so the console head and the remote TUI head are the same client by construction. (2) **The relay stays a relay** — it fans out, mirrors, dedupes, and queues; it holds no authority over the agent and no policy logic (the `saas-agents` §4.2 posture, unchanged). (3) **Deltas are never stored** — streaming text fans out live and dies; R2 + `session_events` mirror only the sealed event vocabulary. (4) **Every head input is attributed at the edge** — api-edge stamps the authenticated principal onto input frames; the body logs it into the tamper-evident chain; the relay never trusts a self-declared identity. (5) **The console head and the TUI head share a presentation contract, not code** — same event folding, same approval semantics, same four zoom levels (delta → activity line → checklist → tool cards), verified by rendering the same fixture sessions. (6) **`bootstrapScript` dies** — the in-sandbox supervisor is `orun agent serve` (orun AL4); this epic deletes the bash stand-in the moment the serve binding lands. |
| Gate | **Buildable vendor-free.** The DO relay, console head, and api-edge routes develop against the shared fixtures and a fake body (the same NDJSON files orun's tests replay); live Daytona verification rides the existing BYO-key posture. AL8 notifications reuse the shipped notifications plane. |

## Thesis

Claude Code remote proved the product shape: the session is the durable
thing, and web, desktop, and terminal are *surfaces* that attach, steer,
approve, and hand off — the handoff being the moment users feel the
architecture. This platform is unusually close to that shape already: the
event vocabulary is closed and shared, ingest dedupes by seq, sessions have
identities and leases, and the runtime is one binary in two contexts. What is
missing is symmetry — today the sandbox talks *at* the cloud and the console
reads a table. The attach protocol makes the relationship symmetric and
client-shaped: the body publishes one stream and consumes one input queue;
every surface — console, TUI, whatever comes next — is a peer head. The
prize on the cloud side is that this costs almost nothing new: the DO relay
AG6 already planned becomes the attach server rather than a bespoke SSE, the
session page already shipped becomes the head, and the seam to the terminal
is an api-edge facade over routes that must exist anyway. One protocol,
rendered three ways, sealed once.

## How it maps to the references

| Claude Code remote | Here |
|---|---|
| Session lives server-side; web/desktop/CLI attach | body in Daytona (`orun agent serve`); console + `orun agent attach as_…` are peer heads |
| Attach = replay then follow | `hello` → replayed `event`s (R2 mirror + relay index) → `live` → SSE fan-out |
| Steering mid-run from any surface | `steer` input frames → DO return queue → body → attributed `message_user` |
| Permission prompts travel to whoever is watching | `approval_requested` renders on every attached head; first valid `verdict` wins; resolution attributed |
| "Continue in terminal" handoff | session page shows `orun agent attach as_…` copy affordance; the TUI shows the console URL |
| Notifications when unattended | approval-waiting + terminal-state pushes via notifications-worker (AL8) |

## Read order

1. This README.
2. **`orun/specs/orun-agents-live/`** — the paired epic (read first):
   README → design → `attach-protocol.md` (the frames this epic serves).
3. [`design.md`](./design.md) — the DO relay as attach server, the console
   head, the api-edge facade, handoff + presence + notifications, metering.
4. [`implementation-plan.md`](./implementation-plan.md) — AL6–AL9.
5. [`risks-and-open-questions.md`](./risks-and-open-questions.md).

## Milestones at a glance (cloud-owned; AL0–AL5 in `orun/specs/orun-agents-live/`)

| ID | Milestone | Status |
|----|-----------|--------|
| AL6 | The relay as attach server: per-session DO — ingest (existing route, now frame-shaped) → R2 mirror + `session_events` index → SSE fan-out of attach frames; the input return queue (`POST …/input` → body long-poll); delta pass-through (never stored); presence; conformance against the shared fixtures | 🏗️ Core shipped (codec + fixtures + DO + head routes; R2 mirror + body dial-out routes + api-edge facade remaining) |
| AL7 | The console head: the session page becomes the chat — streaming turns via SSE (retiring the 5s poll), composer, sticky approval cards, tool cards, activity line + checklist, the inspector proof pane (brief/affected/cost/sandbox facts) | 🏗️ Core shipped (folded conversation + composer + approval cards + input over api-edge; SSE tail retiring the poll rides AL8) |
| AL8 | Interchangeable heads + handoff: api-edge attach/input facade for external heads (`orun agent attach as_…`); principal attribution end-to-end; presence chips; notifications (approval waiting, session terminal); "continue in terminal" / console-URL handoff affordances | 🏗️ Core shipped (bootstrapScript retired for `orun agent serve`; handoff affordance; edge attribution + facade from AL7; notifications remaining) |
| AL9 | Suspend/resume + metering completion: suspend snapshots with harness-session capture (orun AL1) so resume continues the conversation; `agents.session_minutes` / `agents.tokens` from relayed `cost_sample`s; retention + relay GC; delete `bootstrapScript` (rides orun AL4) | 🏗️ Metering shipped (tokens + minutes close AG10; suspend/resume choreography needs live Daytona) |

## Scope boundary

| In scope (cloud) | Out of scope |
|----------|--------------|
| The per-session DO attach server + R2 mirror + input queue; api-edge attach/input facade + SSE pass-through; the console session head + spawn-adjacent UX; presence + notifications; suspend/resume choreography; live-plane metering; attach-protocol TS codec + shared fixtures in `packages/contracts` | **The protocol definition, the runtime input seam, the Claude Code driver, the session host, the TUI head, `orun agent serve`** — all `orun/specs/orun-agents-live/` (AL0–AL5); sandbox provisioning/identity/leases (`saas-agents` AG5/AG6, shipped — reused, not rebuilt); the fleet view + profiles + provider connections (AG7/AG12, shipped); dispatch/autonomy (AG9); work-plane surfaces |

## Relationship to existing work

- **`orun/specs/orun-agents-live/` (AL0–AL5)** — the other half; hard
  dependency, but a *file-shaped* one: the protocol freezes at orun AL0 as
  golden fixtures copied into `packages/contracts`, so AL6/AL7 build in
  parallel against a fake body with no cross-repo build coupling.
- **`saas-agents` (AG5–AG12)** — the substrate this epic completes. AL6 is
  the "remaining AG6 slice" (DO relay + SSE) done right — as the shared
  protocol rather than a bespoke tail; AL7 upgrades AG7's session page in
  place; AL9 finishes AG10's session_minutes/tokens meters, unblocked by
  cost samples finally flowing.
- **`saas-console-ux` / `saas-event-streaming`** — the SSE and presentation
  conventions the console head follows.
- **`saas-product-experience`** — the notification and deep-link grammar AL8
  plugs into.
- **[`saas-agents-fleet/`](../saas-agents-fleet/) (AF4–AF9)** — the successor
  epic for the workforce plane: delegation trees over the sessions this epic
  made drivable (child events ride these same relays), the fleet home as a
  derived attention plane (generalizing AL7's attention badge), routines,
  earned autonomy, and budgets (extending AL9's meters into ceilings). Pairs
  `orun/specs/orun-agents-fleet/` (AF0–AF3).
