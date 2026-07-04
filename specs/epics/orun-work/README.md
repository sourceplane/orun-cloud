# orun-work (v2) — the work lens (cloud half)

> Cross-repo epic. The authoritative spec lives in **`sourceplane/orun`**
> (`specs/orun-work/`, v2); this folder is the orun-cloud half: what this repo
> owns, how it binds to the platform, and the as-built record. The v1 design
> and its code were scrapped (see "v1 teardown" below); v1's frozen spec is
> archived at `orun/specs/archive/orun-work-v1/`.

| | |
|---|---|
| **Status** | In progress — WP0–WP3 shipped, WP4/WP5 shipped orun-side; WP1b console depth + the WP4 remote leg + the P2-gated overlay call site remain |
| **Repos** | `sourceplane/orun` (model/fold oracle, CLI, import), `sourceplane/orun-cloud` (logs, ingesters, query API, console) |
| **Cluster** | **WP** (`WP0 → WP5`, plan in `orun/specs/orun-work/implementation-plan.md`) |
| **Pairs with** | `saas-resources-runtime` (P2 — `liveObservation` → `revision_live`), `saas-integration-tenancy` (IT — the webhook ingester's tenancy), `teams-ownership` (TO — owner→team routing for blast radius), `saas-console-ux` (U — the board surfaces) |

## The one-paragraph thesis

Every tracker is a ledger of human opinions about the state of the world;
people drag cards to simulate reality. orun owns the world — the component
graph, the diff→component engine, execution truth, the deployment overlay —
so the work plane stores no opinions about anything the platform can observe.
It is **two append-only logs** — coordination (what people intend: assign,
comment, order, pin, cancel) and observation (what the world did: branches,
PRs, gate results, live revisions) — and **lifecycle is a derived query**
(`Draft → Ready → In Progress → In Review → Done → Released`), never a stored
column. Pins are public, attributed overrides rendered *beside* observed
truth. Agents get a four-tool write surface with no way to assert progress:
the category "agent lies about status" is unrepresentable.

## What orun-cloud owns

- **The `work` bounded context (fresh schema, WP0):** `work.specs`,
  `work.tasks` (fold caches of the coordination log), `work.events`
  (coordination log), `work.observations` (observation log, `dedupeKey`
  idempotency). No status column anywhere; every read model is a droppable
  fold cache. Vocabularies and the fold per
  `orun/specs/orun-work/data-model.md` (the Go fold in `orun` is the
  conformance oracle; the TS fold replays its fixtures).
- **The mutator surface + query API (api-edge):** coordination mutators
  (create/edit/contract/assign/comment/order/pin/cancel — deliberately no
  status mutator), structured verdicts, and the fold query API returning
  lifecycle *with evidence*.
- **Ingesters:** GitHub PR webhooks (integrations-worker, riding the IT
  install), the native-coordination run stream → `gate_result`
  (state-worker), and resources-runtime `liveObservation` → `revision_live`.
  Each is a named source with a versioned fact contract that fails loudly on
  shape drift.
- **The console (WP0 read-only list → WP1 local-first board):** snapshot
  bootstrap + cursor replay over SSE/LISTEN-NOTIFY, optimistic apply behind
  the transport-agnostic mutation/verdict seam. No Durable Object, no
  bespoke WebSocket protocol.
- **Principals:** membership subjects only (`usr_`/`sp_`/`team_`); agents
  are service principals with a mandatory responsible owner. No work-local
  identity table.

## v1 teardown (as-built record)

The v1 work plane (stored-status, Initiative/Epic/Task, D1/Durable-Object
sync design) landed as consumer-free library cores and was scrapped whole:

- `packages/db/src/work/` (model, repository, sync, autolink, delivery,
  ingest, webhook) — **removed**; no route, worker, SDK, or console surface
  ever consumed it.
- `packages/db/src/bridge/` (the runtime→work Released bridge) — **removed**
  with it.
- Migration **`490_work_teardown`** drops the `work` schema created by
  `200_work_foundation` (which stays in the manifest as applied history).
- orun-side: `internal/work` + `internal/workbridge` removed; spec archived.

What carries forward into v2: append-only events with mandatory actor
provenance, the one-mutator-surface discipline, seal determinism, and the
conformance-oracle pattern (Go model ↔ TS mirror over shared fixtures).

## Milestones (cloud view)

| ID | Cloud deliverable | Status |
|----|-------------------|--------|
| WP0 | `work` context v2 schema + mutators + fold + query API + read-only console list; import target for `orun work import` | ✅ Shipped — substrate (#318: `560_work_foundation_v2`, `@saas/db/work` v2 model+fold+repositories) + read surface (WP1 PR: fold query API with evidence, mutator routes with verdicts, import apply, SDK `WorkClient`, console Work page) |
| WP1 | Local-first console store (snapshot + cursor replay over SSE), optimistic apply + verdicts, pins, activity feed | ✅ Shipped — read surface (#319) + WP1b: pin/unpin + comment actions with inline mutator verdicts, and log-cursor live refresh (the events endpoint polled from the last seen seq; the transport-agnostic seam means SSE can replace the poll without touching anything else). Also fixed here: `work.read`/`work.write` were missing from the policy engine's ALL_KNOWN_ACTIONS registry, so every console call denied as unknown_action → resource-hiding 404 (the "Work page not found" bug) — regression-tested |
| WP2 | GitHub webhook ingester (+ affected-set producer contract), claim join, drift inbox | ✅ Shipped — the inbox drain projects normalized scm.* PR/branch events into `work.observations` in the same delivery transaction (semantic dedupe keys, task keys parsed from branch/title); `POST …/work/observations` admits the named `ci` producer for affected sets; claim join (key parse + unambiguous overlap) and the drift inbox were already in the WP0 fold and now light up from live facts |
| WP3 | Run-stream `gate_result` + overlay `revision_live` ingesters; Done/Released rungs light up | 🏗️ Mostly shipped — the run projector emits `gate_result` facts from terminal job phases keyed to the run's git revision (P-3: orun execution truth, never GitHub statuses; idempotent per run/job/phase), and the `deploy-overlay → revision_live` bridge is built + tested; the Done→Released walk is proven from facts. Remaining: the runtime call site for `workObservationFromLiveDeployment` awaits `saas-resources-runtime` (P2, not started) — Released lights up the moment that feed lands, no rework |
| WP4 | Seal/pull support (workspace-routed refs) | 🏗️ Orun-side shipped (orun #458): seal core (canonical JSON, ContentID, intent-only SpecSnapshot, chained log segments) + `orun spec pull` with pin verification, sealed client-side from this repo's fold API. Remaining here: server-side sealing + the refs/work remote leg |
| WP5 | MCP write path through the same mutators | ✅ Shipped orun-side (orun WP5 PR): `orun mcp serve` — reads with evidence + sealed briefs; exactly four write tools through this repo's WP1 mutator routes; no lifecycle/pin tool exists (asserted). This repo's mutators already enforce the server-side guardrails (agent-pin 422) |

## Design rules this repo must not break

1. **No stored fact.** A PR adding a lifecycle/gate/released column — or any
   write to a read model outside the fold — is a rejected PR.
2. **Two logs only.** Mutators write `work.events`; named ingesters write
   `work.observations`; nothing else writes anything.
3. **Provenance.** Every event has an actor; automation never wears a name;
   agents never pin.
4. **Honest degradation.** Unknown-to-orun renders unknown (never green);
   ambiguous auto-claims suggest, never link; unresolved `affects` keys
   render, never drop.
