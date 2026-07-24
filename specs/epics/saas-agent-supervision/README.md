# Epic: saas-agent-supervision

**From a fleet you watch to a workforce that reports.** `saas-agents` (AG)
put the runtime in a box; `saas-agents-fleet` (AF) governed delegation;
`saas-agents-native` (AN) gave the workspace a durable voice with hands
(`session_spawn / session_steer / session_watch`); `saas-dispatch` (DX) made
that voice the front door and opened a second executor (Claude Managed
Agents); `saas-copilot-surface` (CX) + the cockpit unification gave every
conversation one look and feel. What is still missing is the relationship
the whole industry converged on in 2026 — the **Claude-dispatch /
Claude-Code shape**: a *dispatcher* that owns a roster of *implementers*,
talks to them **so the human doesn't have to**, reports their status in its
own thread, steers them when they drift, and yields the moment a human takes
the wheel. Today the Workspace Agent only touches its delegates when a human
happens to prompt a turn; between turns the fleet runs unsupervised and the
human is the polling loop. This epic closes that loop: implementer events
*wake* the dispatcher, the dispatcher supervises with credentials of its own
(attributed, budgeted, injection-hardened), provenance is a first-class
taint on every implementer, and the console reorganizes around the pair —
**Agents** (dispatcher threads, each with its live implementer roster) and
**Implementers** (the full tainted fleet).

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — design complete, SV0 not started |
| Cluster | **SV** (supervision plane over **AN** + **DX** + **AF** + **CX**; composes shipped doors, changes none of them) |
| Owner(s) | `apps/chat-worker` (the supervisor loop, dispatcher principal plumbing) · `apps/agents-worker` (origin taint, control protocol, dispatcher grants) · `apps/api-edge` (facade pass-throughs) · `apps/web-console-next` (Agents/Implementers IA, roster panel, takeover UI) · `packages/contracts` + `packages/db` + `packages/sdk` (origin, control events, roster fold) |
| Target branch | `claude/copilotkit-interface-unify-0777tg` (design PR), then `main` (PRs merged incrementally) |
| Builds on | `saas-agents-native` AN4–AN7 as-built (the Workspace Agent + session verbs; **no verdict verb**, lock 5) · `saas-dispatch` DX1/DX7 (the `DispatchIndex` doorbell; the two delegation interfaces `orun-sandbox` / `anthropic-managed`) · `saas-agents-fleet` AF4/AF6/AF9 (spawn gates + tree, attention plane, budget envelopes) · `saas-agents-live` AL (attach protocol, heads/presence, steer attribution) · `saas-copilot-surface` CX + the cockpit unification (#605–#609: one transcript vocabulary, optimistic steers, the unified session head) · `orun-work` WP (work refs for work-element origins) |
| Decisions locked | (1) **Supervision adds no authority** — the dispatcher supervises with the AN5 verbs it already has; it still cannot answer an approval (AN lock 5 inherited verbatim); escalation means *surfacing to the human*, never resolving. (2) **One dispatch door** — implementers start only via the AG9 door with AF4 gates; a supervisor turn that spawns passes the same ladder as a human. (3) **Attributed autonomy** — every dispatcher-initiated steer/spawn is stamped with the **dispatcher's own service principal** in the sealed log; a human reading any transcript can always tell who drove. (4) **Wake, don't poll; budget every wake** — supervisor turns are event-driven (doorbell → debounce → digest), share the thread's turn-rate ceiling, and burn the AF9 envelope; a supervision storm is structurally bounded. (5) **Human presence wins** — while a human head holds control of an implementer the dispatcher observes but does not steer; takeover and release are one-click and sealed as events. (6) **Executor-agnostic supervision** — the same roster, status roll-up, and verbs over `orun-sandbox` and `anthropic-managed`; the trust tier is always rendered; divergences (no mid-run approval channel on Managed) are stated, never papered over. (7) **Origin is immutable provenance** — recorded once at the door, never mutated, rendered everywhere. (8) **Relayed output is untrusted input** — a supervisor turn treats implementer logs as data; injected instructions in a log line must not widen tools, spawn outside the ladder, or exfiltrate; fixture-tested. (9) **Two planes stay two planes** — implementer infra state and work rung render side by side in every roll-up, never merged into one "status". |
| Gate | **Buildable vendor-free through SV2 and SV4–SV5.** Origin taint, roster folds, dispatcher principal, IA, and the control protocol develop against recorded fixtures; SV3 (the loop) and SV6 (Managed parity) need a live model key for chat smoke only — the wake/digest/guard logic is pure and fixture-tested. |

## Thesis

The substrate is an inch from the product everyone actually wants. A human
opens one conversation, says "ship ORN-142", and from then on the
*dispatcher* does what a staff engineer does with a team: watches the
implementers it started, reads their output, nudges the one that drifted,
summarizes the one that finished, verifies the PR against the ask, and
raises its hand to the human only for the two things that are genuinely
human — approvals and judgment calls. Claude products proved the shape:
Claude-dispatch fronting Claude-Code sessions, the human talking to the
dispatcher, the dispatcher talking to the coders, and a seamless "take the
wheel" when the human wants hands-on. Every piece of that exists here —
the durable dispatcher (AN), the sealed implementers (AG/AL), the spawn
gates and budgets (AF), two executors behind one door (DX7), and one
cockpit language for all of it (CX + #605–#609). What does not exist is the
**standing relationship**: nothing wakes the dispatcher when its
implementer finishes; nothing marks a session as *belonging* to the thread
that started it; nothing tells the dispatcher a human took the wheel; and a
dispatcher steer would today be attributed to the human owner — a lie the
sealed log should never tell. SV builds exactly those four things and the
IA that makes them legible, and nothing else.

## The two genuinely new nouns

**Origin (the taint).** Every implementer records, at the dispatch door,
who set it running: a **dispatch thread** (`ch_…`), a **work element**
(a WP task / design doc / epic — `workRef`), a **routine**, a **parent
session**, or a **human** directly. Origin is immutable, carried on the
session row, rendered as a chip on every list and detail surface, and is
the join that makes "this thread's implementers" a fold rather than a
table (the AF constitution, inherited).

**The supervisor turn.** A dispatcher turn with no human prompt: the
doorbell coalesces implementer events (terminal states, approvals, budget
marks, stuck-ness) into a digest, and the thread runs a rate-limited,
budgeted, injection-hardened turn that may report, verify, steer, or
escalate — attributed to the dispatcher's principal, rendered in the thread
like any other turn, and structurally unable to approve anything.

## Milestones at a glance

| ID | Milestone | Buildable vendor-free? |
|----|-----------|------------------------|
| SV0 | **Origin taint** — `origin {kind, ref, label}` in contracts/db/SDK; recorded at the AG9 door for all five spawn provenances; backfill infers legacy rows; chips render on fleet rows + session detail. | ✅ |
| SV1 | **The roster fold** — "this thread's active implementers" as a per-viewer fold over sessions by origin + live state; `GET …/chats/:id/implementers`; the side-panel read model with the same liveness discipline as the Situation. | ✅ |
| SV2 | **The dispatcher principal** — a per-workspace service principal for the Workspace Agent with narrow grants (`session.read`, `session.interact`, door-mediated spawn); supervision verbs stamp it; sealed logs + cockpit render *"steer · Workspace Agent"* distinctly from human steers. | ✅ |
| SV3 | **The supervision loop** — the DX1 doorbell learns implementer events and rings the *owning* thread's DO; debounce → digest → supervisor turn (report / verify / steer / escalate-to-human); turn-rate + AF9 budget shared; loop guards; per-thread mute. | chat smoke live-key only |
| SV4 | **The IA** — nav renames **Dispatch → Agents** (thread-first; per-thread implementer side panel; only *active* implementers listed) and the fleet page becomes **Implementers** (full tainted list, filters by origin/state/interface); implementer detail gains the "Supervised by ⟨thread⟩" banner + origin chip. | ✅ |
| SV5 | **Takeover (head politeness)** — `control_taken` / `control_returned` sealed events; explicit Take-control on the implementer cockpit; implicit yield on human steer (sliding window); the dispatcher observes-only while a human holds control; identical cockpit either way. | ✅ |
| SV6 | **Executor-agnostic supervision** — Managed-run parity for roster/roll-up/steer; spawn-from-dispatch honors the profile's interface; the no-approval-channel divergence stated on the card; tier chips everywhere. | live key for smoke |
| SV7 | **The foreman brief + hardening** — the roll-up status card ("3 running · 1 waiting on you · 2 done — details") on demand and as a proactive brief; injection/storm fixtures; supervision metering (`chat.supervision.turn`); responsiveness budget. | ✅ (brief content smoke live-key) |

## Read order

1. This README.
2. [`design.md`](./design.md) — the model, origin, the dispatcher principal,
   the supervision loop, takeover, executor parity, the IA, security +
   metering.
3. [`implementation-plan.md`](./implementation-plan.md) — SV0–SV7 with
   "done when".
4. [`risks-and-open-questions.md`](./risks-and-open-questions.md).
5. [`IMPLEMENTATION-STATUS.md`](./IMPLEMENTATION-STATUS.md) — as-built
   (empty until SV0 lands).

## Scope boundary

| In scope (cloud) | Out of scope |
|----------|--------------|
| Origin taint (contracts/db/doors/SDK/UI); the roster fold + side panel; the dispatcher service principal + attributed verbs; the doorbell→digest→supervisor-turn loop with its guards, mute, and metering; the Agents/Implementers IA rename + filters; the control (takeover) protocol + sealed events; Managed-run supervision parity; the foreman brief | **The orun runtime, driver, sandbox, attach protocol** (orun-owned) · **the dispatch door, ladder, spawn gates, budgets themselves** (AG9/AF — consumed, unchanged) · **approval authority for any agent** (locked out — lock 1) · **the work fold + mutators** (WP — origins reference work, never write it) · **a second execution path** (supervisor turns re-enter shipped doors only) · **cross-workspace supervision** (a dispatcher supervises its own workspace's implementers only) · **implementer-to-implementer chat** (children report via the sealed `child_*` events, as today) |

## Relationship to existing work

- **`saas-agents-native` (AN)** — the dispatcher *is* the Workspace Agent;
  SV gives it what AN deliberately deferred: a reason to act between human
  turns, and an identity of its own to act as. The AN5 verb set is consumed
  unchanged; the missing-verdict lock is re-asserted, not re-litigated.
- **`saas-dispatch` (DX)** — SV completes DX's sentence. DX1's
  `DispatchIndex` doorbell gains implementer-event routing to the owning
  thread; DX7's two interfaces become two *supervised* interfaces. The
  Situation rail and the roster panel are siblings, not rivals: the
  Situation is the workspace's pending plane, the roster is one thread's
  workforce.
- **`saas-agents-fleet` (AF)** — origin is the AF tree made legible to
  product surfaces; supervision burns AF9 budgets and triggers no gate AF
  didn't already define. The attention plane stays the human's queue —
  supervisor turns *point at it*, never drain it.
- **`saas-copilot-surface` (CX) + the cockpit unification (#605–#609)** —
  the precondition for "same look and feel". One transcript vocabulary means
  a dispatcher thread, an implementer cockpit, and a takeover session are
  the same components; SV adds cards and chips, not a third chat UI.
- **`orun-work` (WP)** — work-element origins (`work design`, `epic
  implementer`) reference WP items by ref; the two-planes rule governs every
  roll-up card.
