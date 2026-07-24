# saas-agent-supervision — Implementation Plan

SV0–SV7, each with a "done when". AN/AG/AF/DX/CX are consumed, never
changed. Buildable vendor-free except where a live model key is named
(chat smoke only); every wake/digest/guard/fold is pure and
fixture-tested.

---

## SV0 — Origin taint

**Build.** `packages/contracts/src/agents.ts`: the `origin` shape
(`kind | ref | label | backfilled?`) on `AgentSession`; the closed kind
union. `packages/db`: `origin` JSONB column + `(org_id, kind, ref)`
expression index; migration with backfill (`session` ⇐ parentSessionId,
`work` ⇐ workRef, else `human`, all `backfilled: true`).
`apps/agents-worker`: the AG9 door records origin from the authenticated
caller's context (chat-worker session verbs pass the thread ref; work
surfaces pass workRef; routines pass routine id; parent-session spawns pass
`as_…`; everything else lands `human`) — a client-supplied origin field is
ignored. `packages/sdk`: `origin` on session reads. Console: origin chip
component + rendering on fleet rows and the implementer cockpit header
(chip deep-links to the origin).

**Done when.** Spawns through each of the five provenances land the
expected origin (integration fixtures per door); a forged body origin is
ignored (test); backfill inference covered by db tests; PATCH/mutation of
origin is impossible by construction (no code path — assert repository has
no setter); chips render with correct deep links; contracts + db + workers
+ console typecheck/lint/tests green.

---

## SV1 — The roster fold

**Build.** `apps/agents-worker`: `GET …/agents/chats/:chatId/implementers`
— a per-viewer fold: sessions where `origin = {dispatch, ch_x}`, split
active/terminal, joined with the needs-you fold (AF6) and cost; authorized
`session.read`, viewer-credentialed (DX lock 4 inherited). Contracts + SDK
(`chatImplementers`). Console: the roster side panel on the thread page —
snapshot-first, invalidated by the DX1 doorbell's existing situation
frames, with the liveness poll safety-net shared from the session page.

**Done when.** The fold returns exactly the tainted sessions (fixtures:
mixed origins, mixed states); a viewer without `session.read` on the org
gets none (authz test); the panel renders active implementers with state
pill / tier / cost / last-event age and updates without a manual refresh
(poll fallback asserted in a component test); a spawn from the thread
appears in the panel on door-ack; green across the stack.

---

## SV2 — The dispatcher principal

**Build.** `apps/agents-worker`: mint-on-first-enable a per-workspace
dispatcher service principal (reuse the profile-principal machinery);
grants exactly `session.read` + `session.interact` (+ door-mediated spawn);
custody-held token, never persisted plaintext. `apps/chat-worker`: the AN5
verbs gain a credential parameter — owner bearer on human-prompted turns
(unchanged), dispatcher principal on supervisor turns; the relay input
route needs no change (it already stamps the authenticated actor).
Console + TUI cockpit: dispatcher-principal steers render as
"Workspace Agent · steer" (distinct identity, existing principal
rendering).

**Done when.** A supervision-context steer lands in the sealed log
attributed to the dispatcher principal; a human-prompted one stays
owner-attributed (both fixture-tested through the relay); the dispatcher
principal cannot read settings/secrets or mutate work (authz denial
tests); the cockpit renders the two attributions distinctly; green.

---

## SV3 — The supervision loop

**Build.** `apps/chat-worker` (`DispatchIndex` + `WorkspaceAgent`): the
wake-kind list in contracts; the index routes wake events for
dispatch-origin sessions to `chat:ch_x`; per-thread coalescing window →
typed digest (bounded, built from sealed events only); the DO runs the
supervisor turn — no user message, `supervisor: true` sealed marker,
roster + digest as structured tool results, verb roster minus `ui_`
client tools; escalation card on `approval_requested` (surface +
deep-link, never resolve). Guards: shared turn-rate ceiling; AF9 budget
burn + park mark; reflexivity filter (dispatcher-caused events don't ring
within the window; terminal/approval always ring); per-thread
`supervision: on | observe | off` setting + UI toggle.

**Done when.** Fixture streams drive the full loop vendor-free with a fake
model: N coalesced events → 1 digest → 1 turn; terminal event → completion
card; `approval_requested` → escalation card and **no** verdict call
(asserted — the verb doesn't exist, the test proves no input frame of type
verdict is emitted); storm fixture (100 events/min) → ≤ ceiling turns;
reflexivity fixture (dispatcher steer echo) → no wake; budget-exhausted →
parked with sealed mark; `observe` mode → digest cards, zero model calls;
live-key smoke: one real supervised completion produces a sensible summary
card. Green.

---

## SV4 — The IA: Agents and Implementers

**Build.** `apps/web-console-next`: nav rename **Dispatch → Agents**
(route alias kept; Cmd-K entries updated); the Agents surface becomes
thread-first with the SV1 roster panel per thread; the fleet page becomes
**Implementers** — full list, origin/state/interface/profile facets,
attention queue unchanged, terminal implementers listed here only; the
implementer cockpit gains the "Supervised by ⟨thread⟩" banner (origin
dispatch only) and origin chip. Empty states, mobile stacking, a11y pass
per U-track discipline.

**Done when.** Route aliases 301/redirect cleanly (no dead links from
existing deep links, test); facets filter correctly against fixture
fleets; active-only invariant on Agents holds (a terminal implementer
disappears from the roster panel and appears under Implementers — fold
test); nav/Cmd-K tests updated; screenshot-level review of the two
surfaces; green.

---

## SV5 — Takeover (the control protocol)

**Build.** `packages/contracts` + `apps/agents-worker` (relay):
`control_taken` / `control_returned` in the closed event vocabulary;
relay-held control state (principal + mode + expiry), server-enforced:
input frames of type steer/interrupt from the dispatcher principal are
refused with `control_held` while a human holds control; implicit control
on human steer (sliding window, default 10 min); release on explicit
return, expiry, or terminal state, with a sealed resume marker.
`packages/sdk` + console: Take control / Return control on the cockpit;
the roster card shows "human at the wheel" while held.

**Done when.** The refusal is enforced at the relay (fixture: dispatcher
steer during held control → `{ok:false, reason:"control_held"}` and no
sealed input event); implicit window refreshes on human input and expires
on silence (clock-injected tests); all four transitions sealed and
rendered; the cockpit is byte-identical before/after takeover except the
control affordance (the unified-transcript guarantee — snapshot test);
green.

---

## SV6 — Executor-agnostic supervision

**Build.** The DX7 Managed feeder emits the same wake kinds into the
doorbell; steer/interrupt against Managed sessions ride the Managed API
under the same attribution rules; roster/roll-up cards render tier chips
and the "no mid-run approvals" statement on Managed cards; spawn-from-
dispatch honors the profile's `interface` untouched.

**Done when.** A fixture Managed session drives the same digest → turn →
card path as a sealed one (recorded Managed event fixtures); the
approval-escalation path is provably absent for Managed (no such wake kind
can occur — type-level + fixture); a mixed roster (sealed + managed)
renders both tiers side by side; live-key smoke: one Managed implementer
supervised end-to-end; green.

---

## SV7 — The foreman brief + hardening

**Build.** The roll-up card ("N running · M waiting on you · K done") as
an on-demand answer and as a DX4 proactive brief section — every numeral
from the SV1 fold (one truth). Injection fixtures (hostile log lines →
refusal + sealed record + unchanged escalation card); the storm synthetic
in CI; `chat.supervision.turn` metering + the envelope's human-vs-
supervision split view; responsiveness budget assertions for the roster
panel (snapshot paint, push-or-poll freshness bound).

**Done when.** Injection fixture suite green (the §9 cases verbatim);
metering rows land with the right meter + tokens on the workspace key
(recorded-fixture test); the envelope view shows the split; the brief's
numbers equal the fold's under a property test; CI carries the storm
synthetic; docs: IMPLEMENTATION-STATUS updated to as-built; green.

---

## Sequencing & dependencies

```
SV0 ─→ SV1 ─→ SV3 ─→ SV6 ─→ SV7
        │      ↑
        └─ SV2 ┘        SV4 (after SV1) · SV5 (after SV2, before SV3 ships default-on)
```

SV0–SV2 are pure substrate and land independently behind no flag. SV3
ships with `supervision: observe` as the initial default, flipped to `on`
per-workspace after SV5's enforcement exists (a dispatcher that cannot yet
yield must not steer unsupervised). SV4 can land any time after SV1.
