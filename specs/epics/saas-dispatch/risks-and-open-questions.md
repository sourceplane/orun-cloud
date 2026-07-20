# saas-dispatch — Risks & Open Questions

## ⛔ Still open — confirm before building

| # | Question | Default lean |
|---|----------|--------------|
| DX-Q1 | **Per-viewer fold vs shared cache.** The Situation authorizes per viewer (lock 4), so the live object is a doorbell, not a shared authorized cache. At high head-count per workspace this re-folds per viewer per invalidate. Is that acceptable, or do we need a role-bucketed shared cache? | Per-viewer fold in v1 (correctness over cleverness; coarse invalidation keeps re-folds cheap and section-scoped). Revisit with a **role-bucketed** cache only if telemetry shows fold cost dominating — never a single shared cache (the cross-viewer leak test forbids it). |
| DX-Q2 | **Default-landing.** Does Dispatch *replace* Overview as the workspace landing, or coexist with a user/workspace preference? | Replace behind `feature.dispatch_home`, Overview demoted to a reachable metrics view; a later per-user "land on" preference is cheap if asked for. Big-bang replacement without a flag is out. |
| DX-Q3 | **Situation freshness source.** Push via the ES lane doorbell (DX1) vs a periodic reconcile. | Push + a **slow reconcile backstop** (30s), the AN3 doorbell-plus-backstop pattern — the lane catches DOs that missed an event, the backstop catches a lane gap. Neither alone. |
| DX-Q4 | **Mobile shape.** Two-pane command surface on a phone. | Stacked, command-first: the thread is primary, the Situation is a collapsible sheet with the "N pending" badge as the pull affordance. Revisit if usage shows the rail is the primary read on mobile. |
| DX-Q5 | **Proactive brief spend.** Does the standing brief count against the workspace's `agents.chat_tokens`/AF9 envelope? | Yes — one tree, one envelope (AF9). A muted thread schedules nothing; an exhausted envelope parks the brief. Keeps "the platform meters coordination, the tenant pays the model" honest (AN lock 6). |

## ✅ Decisions made (inherited or set here)

| # | Decision | Resolution |
|---|----------|------------|
| DD1 | **Composition, not capability** | Dispatch adds no tool, mutator, authority, or execution path. It renders shipped folds and calls the AN5 verbs. If a feature needs new authority, it is out of scope. |
| DD2 | **The Situation is a fold** | "Pending" is computed per request, never stored. The WP no-status constitution is inherited; agents still cannot assert progress. |
| DD3 | **Execution never on Cloudflare** | The AN §10 amendment is upheld verbatim — Dispatch converses and routes; sandboxes execute. |
| DD4 | **Per-viewer authorization** | The DispatchIndex is a doorbell/debouncer; every situation item is folded with the viewer's own credential. |
| DD5 | **Approvals human** | AN lock 5 stands; Dispatch surfaces `approval_requested` prominently and answers none. |
| DD6 | **Snapshot-first** | No dispatch paint blocks on a live fold or a hibernated-DO wake; a cached shell renders first. |
| DD7 | **Unprivileged host** | DispatchIndex lands in chat-worker (no control-plane bindings); a compromised dispatch brain's blast radius is its owner's credential. |
| DD8 | **Attach v1 is the wire** | The dispatch socket extends the frozen attach-v1 vocabulary with two frames; no second sync protocol (AN decision 2). |

## Risks

| Risk | Mitigation |
|------|------------|
| **Fan-out cost** — many heads re-folding on every workspace event. | Coarse, section-scoped invalidation (a `work.*` event never invalidates `inFlight`); per-head debounce; counts-first, rows-lazily; the role-bucketed cache stays in reserve (DX-Q1). |
| **Notification duplication** — the proactive brief vs the AL8 doorbell both nagging. | The brief is a *surface* (pull-rendered from the Situation), not a second doorbell; AL8 stays the only push; the brief deep-links, never re-alerts. |
| **A fast lie** — a live layer over a wrong fold ships wrongness quickly. | DX0 lands and is fixture-verified before DX1 makes it live; the sequencing note forbids inverting them. |
| **Two-plane collapse** — a well-meaning UI merges session state and work rung into one "status" pill. | The presentation model is pure and tested to keep the planes distinct (D5); a card that merges them fails the model test. |
| **Cross-viewer leak** — a shared-object optimization exposes another viewer's pending item. | The DispatchIndex holds no authorized content; DX5's cross-viewer regression is red the moment a shared authorized cache appears without role-bucketing. |
| **Front-door regret** — replacing Overview annoys workspaces that lived in it. | `feature.dispatch_home` makes it a per-workspace rollout; Overview is demoted, not deleted, and one header link away. |
| **Responsiveness rot** — the budget degrades silently over releases. | DX5 makes the budget a CI synthetic; a regression past budget fails the build, not a dashboard nobody reads. |

## Non-blocking notes

- The Situation's *Waiting-on-me* section and the AF6 attention plane overlap
  by design — Dispatch is the attention plane given a conversational home, not
  a competing inbox. Keep one vocabulary; cross-link, don't fork.
- Warm-per-workspace `DispatchIndex` snapshots (pre-computed section counts on
  a slow timer) are a later optimization the snapshot-first contract already
  permits without an interface change.
- If inbound-email-to-dispatch is ever wanted, it rides AN's parked email
  transport — a firing becomes a chat turn, no new execution path.
