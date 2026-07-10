# saas-agents-live — Implementation Plan (AL6–AL9, the cloud half)

The cloud-owned milestones. The protocol, driver, session host, and TUI head
(AL0–AL5) live in `orun/specs/orun-agents-live/implementation-plan.md`.
Design refs are to `design.md` (§) here and `attach-protocol.md` (P§) in the
orun epic.

The cross-repo coupling is deliberately file-shaped: orun AL0 freezes the
frames as golden fixtures; this repo vendors them into
`packages/contracts/src/agents-attach/fixtures/` and builds everything
against a fake body that replays them. No milestone below waits on a live
sandbox except final verification.

---

## AL6 — The relay as attach server — 🗓️ Planned

- `packages/contracts/src/agents-attach/`: the attach frame types (TS codec)
  + vendored fixtures; round-trip conformance tests (the worklens Go↔TS
  discipline).
- The per-session DO in `apps/agents-worker`: ingest hand-off from the
  existing route (unchanged gate/dedupe) → WAL buffer → R2 chunk mirror +
  `session_events` index → SSE fan-out (§2.1–§2.2); the `stream` delta
  route (fan-out only); the `inputs` long-poll return queue with cursor +
  at-least-once; `attach` SSE with `Last-Event-ID` resume; presence frames.
- Policy: `agent.session.interact` action registered; input routes
  authorize deny-by-default; api-edge facade forwards `attach`/`input`.
- Fake-body test harness: replays fixture NDJSON through ingest, drives
  verdict races and resume-mid-stream against the DO.

**Done when:** a fixture body streamed through the DO reaches two attached
SSE clients identically (replay + live); an input frame posted by either
client arrives on the body's long-poll exactly once (net of `ref`
idempotency); DO eviction mid-session loses nothing sealed (R2/index replay
proves it); the vendored fixtures round-trip byte-identically in TS.

## AL7 — The console head — 🗓️ Planned

- `session-detail.tsx` rebuilt as the head (§3): SSE subscription with
  cursor resume (poll demoted to fallback), conversation rendering (turns /
  deltas / tool cards / activity line / checklist), the composer
  (steer + interrupt + end), sticky approval cards with resolution
  attribution, inspector rail additions (brief, policy, cost, presence).
- Attention badges: fleet rows + topbar for unattended
  `awaiting_approval` (§3).
- Fixture parity suite: the shared golden sessions render in component
  tests; folding output diffed against the documented presentation contract.

**Done when:** a live fixture session is steerable and approvable from the
browser with sub-second echo; the 5s poll no longer runs when SSE is
healthy; an approval cannot be scrolled out of view while pending; parity
tests pass on every fixture the TUI head also renders.

## AL8 — Interchangeable heads + handoff — 🗓️ Planned

- Principal stamping on input frames at api-edge (drop inbound self-declared
  identity — the `x-actor-*` discipline extended to frames, §4).
- External-head verification: orun's remote-attach client (AL4) driven
  against the staging relay; the interchangeability diff (console head vs
  TUI head against one fixture body → identical logs).
- Handoff affordances: "Continue in terminal" copy on the session page; the
  console deep link surfaced to orun (attach hello metadata) for the TUI
  inspector; link pair in spawn/dispatch surfaces.
- Notifications via notifications-worker: unattended-approval and
  terminal-state pushes with deep links + attach command (§4).

**Done when:** the design §8 narrative passes end-to-end against staging
with a real Daytona body (jointly with orun AL4); a verdict from the TUI is
visible in the console attributed correctly within a second; an unattended
ask produces exactly one notification to spawner + owner; `bootstrapScript`
is deleted from `provision.ts` in favor of `orun agent serve`.

## AL9 — Suspend/resume + metering completion — 🗓️ Planned

- Resume choreography: harness-session id mirrored from the log; resume path
  re-provisions from snapshot and passes `--resume` (§5); heads re-attach on
  cursor with no gap; suspended/running timeline dividers in both heads.
- Metering: `agents.tokens` from aggregated `cost_sample`s;
  `agents.session_minutes` on terminal transition from lease brackets;
  emitted fire-and-forget through the shipped binding (§6). Console Usage
  rollup + session-detail cost close AG10's console remainder.
- Retention: R2/index GC after seal + retention window; replay-from-sealed
  fallback for old sessions (§5).

**Done when:** a suspended-overnight fixture session resumes with the
conversation intact and both meters land within tolerance of the fixture's
known totals; a GC'd session's page still renders (from the sealed replay);
AG10's remaining-items list is empty.

---

## Sequencing note

**AL6 → AL7 → AL8 → AL9.** AL6 and AL7 are fixture-driven and vendor-free —
buildable immediately after orun AL0 lands the fixtures, in parallel with
orun AL1–AL3. AL8 is the joint milestone with orun AL4 (the handoff story is
one test executed from two repos). AL9 rides last because resume needs the
Claude Code driver's harness-session capture (orun AL1) in real sandboxes.
The headline demo is AL8's §8 narrative; everything before it is that story's
load-bearing scaffolding.
