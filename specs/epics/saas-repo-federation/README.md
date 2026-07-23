# Epic: saas-repo-federation

**Many repos, one golden path.** Evolve `orun-cloud` from a single monorepo
into a small set of independently-releasable repositories **without** any repo
ceasing to be an Orun golden-path repo. The composition stack, the shared
kernel, and the CI contract are extracted into shared, versioned artifacts; each
service-group repo consumes them and keeps the exact `orun plan` / `orun run`
workflow it has today. This is the productized form of the extraction seams the
constitution already requires (`core/constitution.md` §"Extraction of a
component from the monorepo must not require client-visible contract changes")
and the "later extraction into separate repos" `core/repo.md` was written to
enable — executed deliberately, not by shattering.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft (not started)** |
| Cluster | **RF** (RF0–RF6) |
| Owner(s) | `stack-tectonic` (publish-stack), `intent.yaml` composition sources, `packages/*` publishing, `tooling/fork/components.mjs`, `tooling/wire/*`, `.github/workflows/ci.yml`, `specs/core/repo.md` §Extraction Model |
| Target branch | `main` |
| Builds on | **BF10** (OCI stack consumption — `saas-bootstrap-factory`), BF5/BF6/BF6b (deploy-time wiring, ✅), `tooling/fork/components.mjs` (prerequisite-graph + SCC batching), `core/repo.md` §Extraction Model, `core/operating-model.md` §First Extraction Candidates |
| End-state target | The baseline ships as **one forkable golden-path platform repo** plus a published composition stack and versioned `@saas/*` kernel; a service group can move to its own repo — consuming stack + kernel from registries — with its Orun jobs, service bindings, and deploy lanes intact and no client-visible contract change |

## Thesis

The monorepo is not just how we build `orun-cloud`; for a product whose pitch is
"fork one desired-state repo and reconverge the whole platform," the single repo
**is** the flagship artifact. So the goal is not to break it up — it is to make
the platform *federatable*: extract the reusable substrate so any number of
repos can share one golden path, and only then let a bounded context leave home
when it has earned its own release cadence.

Splitting is governed by four coupling axes, and only two of them constrain us:

1. **Runtime coupling (service bindings) — does not block.** `api-edge` binds
   all 13 backend workers; `billing → membership, policy`; and a genuine
   strongly-connected cycle exists (`billing ↔ membership ↔ events ↔
   notifications`). But Cloudflare service bindings resolve **by service name
   within one account** (`membership-worker-prod`), not by repository, and the
   BF5/BF6 wiring manifest is already shared infrastructure. Cross-repo bindings
   work unchanged; the only rule is *never cut a binding SCC across a repo
   boundary*.
2. **Data coupling — already clean.** Per `core/repo.md`, each context owns its
   schema, no worker queries another domain's tables, migrations extract without
   rewriting clients. Nothing to do.
3. **Build-time coupling (`workspace:*`) — the real work.** 54 `package.json`
   files import `@saas/*` via pnpm's workspace protocol and bundle those
   packages into the worker artifact (`billing-worker` even marks
   `contracts`/`db` as `dependsOn[].input`). `workspace:*` only resolves inside
   one pnpm workspace, so the shared kernel must become **versioned published
   packages** before any worker can live in a different repo.
4. **Orchestration coupling (one intent → one plan → one convergence) — the
   cost.** One `intent.yaml` compiles one plan DAG and converges the whole
   deviation against one remote-state scope. Split ⇒ N intents, N plans, N
   state scopes. Cross-repo `dependsOn` edges are lost (Orun orders *within* a
   plan), and atomic cross-cutting refactors become versioned multi-PR changes.
   This is the price; the RF ladder is sequenced to pay it only where a real
   ownership/cadence boundary justifies it.

The single enabler that makes every future repo "still a golden-path repo" for
free already exists: `stack-tectonic/component.yaml` is a `publish-stack`
targeting `ghcr.io/sourceplane/stack-tectonic`. Publish it once and each repo
references the stack from the registry (the **BF10** OCI-consumption path)
instead of a local `dir` source. Zero composition duplication, one source of
truth.

**Strategy: extract the substrate, keep the platform whole.** Four repos before
seven, seven before seventeen, and seventeen probably never.

## Read order

1. `README.md` (this file).
2. `implementation-plan.md` — RF0–RF6 with scope and "done when".
3. `risks-and-open-questions.md` — decision points + human-input register.
4. `IMPLEMENTATION-STATUS.md` — as-built record.

## Milestones at a glance

| ID | Milestone | Human help? | Status |
|----|-----------|-------------|--------|
| RF0 | Publish `stack-tectonic` to GHCR; flip this repo's `intent.yaml` composition source `dir → oci` (proves BF10; no split) | No | 🗓️ Planned |
| RF1 | Publish the shared kernel (`packages/*`) as versioned `@saas/*`; dual-mode consumers (`workspace:*` ↔ `^version`) | No | 🗓️ Planned |
| RF2 | Federation contract: cross-repo **wiring contract** + guard test (binding graph as an inter-repo API) and per-repo `intent.yaml`/`ci.yml` scaffolding emitted by `tooling/fork/components.mjs` | No | 🗓️ Planned |
| RF3 | Extract the **frontend** repo (`web-console-next` + `web-docs` + `website`) — public-API-only, lowest blast radius | Repo creation + secrets | 🗓️ Planned |
| RF4 | Extract the **infra** repo (`infra/terraform/*` + `db-migrate`); runtime repos consume wiring outputs via the manifest | Repo creation + OIDC roles | 🗓️ Planned |
| RF5 | Extract the first **bounded-context service group** (commerce: billing · metering · notifications · webhooks), SCC kept intact | Repo creation + owning team | 🗓️ Planned |
| RF6 | Federated golden-path hardening: reusable CI workflow published from the stack repo, per-repo state scoping, upstream-sync/`factory upgrade` tie-in (BF11–BF14), doctor preflight | No | 🗓️ Planned |

## Non-goals

- **One repo per worker.** Seventeen repos with no matching team/cadence
  boundaries is pure coordination overhead; the ladder stops at service groups.
- **Splitting a binding SCC across repos.** `billing ↔ membership ↔ events ↔
  notifications` (and the `api-edge` fan-out) stay whole; `tooling/fork/
  components.mjs` already computes these SCCs and must draw the seams.
- **Breaking the forkable baseline.** After every RF milestone the platform must
  still be forkable as one primary golden-path repo + shared substrate — never
  "clone eight repos to stand up the starter."
- **Any client-visible contract change.** Extraction is a packaging move; public
  and event contracts in `packages/contracts` stay stable (constitution rule).
