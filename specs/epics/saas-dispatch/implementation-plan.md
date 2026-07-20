# saas-dispatch — Implementation Plan

DX0–DX5, each with a "done when". AN/AF/WP/AG/ES are consumed, never changed.
Buildable vendor-free through DX1 (fixtures + fake lane + fake model); DX2/DX4
add a live `ANTHROPIC_API_KEY` for chat smoke only.

---

## DX0 — The Situation read-model

**Build.** `packages/contracts/src/dispatch.ts`: the `Situation` wire shape
(`ready`/`inFlight`/`waitingОnMe`/`budget`/`cursor`), each item plane-tagged
(`work|session|governance`) and evidence-bearing for work items; closed
vocabularies, error codes. `apps/api-edge`: the `GET
/v1/organizations/:orgId/dispatch/situation` facade composing the WP work
fold, the AG7 session list (viewer-scoped, live states), the AF6 attention
feed, and the AF9 budget read — fanned out with the resolved actor, folded,
never stored. `packages/sdk`: `dispatch.situation(orgId)`.

**Done when.** The facade returns the four sections, each authorized to the
viewer and plane-tagged, with work items carrying fold evidence; a member who
cannot see a project's sessions gets an empty `inFlight` for them (authorization
test); recorded-fixture tests cover the compose + the empty/first-run shape;
p50 server fold ≤ 250 ms on the fixture set; contracts + api-edge + sdk
typecheck + lint green.

---

## DX1 — The DispatchIndex + live push

**Build.** `apps/chat-worker`: a new SQLite `DispatchIndex` DO class
(`ws:<orgId>`), migration + binding (repeated per env, top-level migration,
the AN1 DO idiom). ES-lane subscription as a **doorbell** (`onLaneEvent` →
`classify` → `bumpCursor` → `situation:invalidate(section)` fan-out); a cached
viewer-agnostic shell (section counts + skeleton) for snapshot-first paint;
attach-v1 head socket extended with `situation:snapshot`/`situation:invalidate`
frames; reconnect-by-cursor. The 5s fleet/work poll on this surface retires;
a 30s degraded-mode backstop remains. api-edge WS pass-through for the dispatch
socket (the AN2 upgrade-forward pattern).

**Done when.** A world-change fixture (a `session.*` lane event) pushes a
`situation:invalidate(inFlight)` to attached heads ≤ 2 s (fake lane, no wall
clock in tests); a reconnect resumes by cursor with no missed section; the DO
hibernates and wakes snapshot-first; the object holds no authorized content
(unit-asserted); chat-worker typecheck + tests + `wrangler deploy --dry-run`
green.

---

## DX2 — The Dispatch surface

**Build.** `apps/web-console-next`: `/orgs/:slug/dispatch` — the two-pane
command surface. Left: the Workspace Agent thread on the AN2 socket client
(optimistic user bubble, streaming deltas, inline tool + child-session cards).
Right: the Situation rail — four live cards (Ready hand-off → `session_spawn`
through the ladder; In-flight chips with steer/interrupt; Waiting-on-me
approval cards → session page; Budget with the AF9 refusal posture). D5
two-plane card rendering (pure, tested presentation model in
`lib/dispatch/model.ts`). Cmd-K over the fold; guided first-run empty state
with the AG12 provider affordances.

**Done when.** The acceptance narrative (design §9) renders end-to-end against
recorded model + situation fixtures; two-plane cards never merge a status; the
presentation model maps every closed-vocabulary state; console build green;
the responsiveness budget's *client* assertions (snapshot-first paint, optimistic
ack) hold on synthetic.

---

## DX3 — The front door

**Build.** `nav-items.ts`: a **Dispatch** home row; `/orgs/:slug` redirects to
`/orgs/:slug/dispatch` under `feature.dispatch_home`; Overview demotes to
`…/overview` (content unchanged, `saas-workspace-overview`), reachable from the
rail + a Dispatch header link; `isLinkActive` gains the home-row exact-match
rule. Mobile: a stacked, command-first layout (thread over a collapsible
Situation sheet). a11y pass.

**Done when.** With the flag on, the workspace root lands on Dispatch and
Overview stays reachable; with it off, nothing moves; the nav model stays pure
and its unit tests cover both rail states; U-track empty/skeleton/URL-scope/
Cmd-K pass; mobile + a11y checks green.

---

## DX4 — Proactive dispatch

**Build.** Ship AN6's deferred proactive plane into Dispatch. `apps/chat-worker`:
`schedule()` on the WorkspaceAgent for the standing brief (an attributed,
mutable turn) + an ambient "N pending" badge sourced from the Situation;
per-thread mute persisted in DO storage. AF routine `target: workspace-agent`
lands as a gated chat turn (dedupe/concurrency/budget, the AN6 §7 contract).
Notifications ride AL8, deduped against the pull-rendered brief.

**Done when.** A scheduled brief renders as an attributed, mutable turn and
can be muted per thread; an AF routine firing shows as a gated turn and its
spawn appears in In-flight; the brief rides the AF9 envelope (an exhausted
envelope parks it, never mid-mangles); recorded-fixture tests cover the
schedule + the routine target.

---

## DX5 — Responsiveness + trust hardening

**Build.** The responsiveness budget (design §4) as CI synthetics (snapshot-first
paint, turn ack, situation-freshness, DO-wake); warm-on-focus (open `/dispatch`
wakes both DOs); custody-resolve reordered concurrent with brief assembly (the
AN path untouched, only parallelized); the cross-viewer authorization
regression; brief-injection fixtures added to the AN7 eval harness.

**Done when.** The perf suite gates the surface (a regression past budget is
red); the cross-viewer leak test is red without per-viewer folding; the
injection fixtures pass (no tool-exec, no verdict, no un-gated spawn from a
hostile fold); custody stays per-turn-and-never-stored (unchanged), verified.

---

## Sequencing notes

- **DX0 → DX1 is the spine**: get the fold right as a request, *then* make it
  live. Never invert (a live layer over a wrong fold ships a fast lie).
- **DX2 is demoable on DX0 alone** (poll the facade) — DX1's push is a
  responsiveness upgrade, not a blocker for a first internal demo.
- **DX3 waits on DX2** (there must be a surface to land on) and is otherwise a
  cheap, reversible, flagged reshuffle.
- **DX4 depends on nothing new** — AN6's runtime hooks (`schedule`, routine
  targets) exist; DX4 gives them a face. It can land in parallel with DX3.
- **DX5 closes the epic**: the budget only becomes a *contract* once CI holds
  the line.
