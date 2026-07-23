# saas-repo-federation — Implementation Plan

Status: Normative for the RF cluster. As-built record in
`IMPLEMENTATION-STATUS.md`; decisions and human gates in
`risks-and-open-questions.md`.

Each milestone is independently valuable and reversible. RF0–RF2 change **no
repo boundaries** — they build and prove the shared substrate in place. RF3+
extract one repo at a time, cutting seams by coupling and ownership.

## RF0 — Publish the composition stack; consume it from a registry

**Scope**

- Publish `stack-tectonic` to `ghcr.io/sourceplane/stack-tectonic` via its
  existing `publish-stack` component (`stack-tectonic/component.yaml`), pinned
  by digest exactly as `kiox.yaml`/`kiox.lock` pin the Orun runtime.
- Flip *this* repo's `intent.yaml` `compositions.sources` from
  `kind: dir, path: stack-tectonic` to the registry/OCI source (the **BF10**
  consumption path). Keep `resolution.precedence`/`bindings` unchanged.
- Add a `stack-tectonic` version pin + a short "how the golden path is
  distributed" note to `core/repo.md` §Composition and CI Model.

**Done when** `orun plan`/`orun run` on this repo produce an unchanged plan DAG
sourced from the published stack (not the local dir), the stack version is
pinned by digest, and a `dir`→`oci` rollback is a one-line `intent.yaml` revert.

**Proves** the "still a golden-path repo" property is registry-portable — the
prerequisite for every later repo.

## RF1 — Publish the shared kernel as versioned `@saas/*`

**Scope**

- Stand up a publish pipeline for `packages/*` (contracts, shared, db,
  policy-engine, sdk, cli, testing, webhook-verifier, notifications-client, mcp)
  to the GitHub npm registry, managed with Changesets; semver policy strictest
  on `@saas/contracts` (the inter-service API surface).
- Introduce **dual-mode** resolution so nothing breaks in place: inside the
  monorepo consumers keep `workspace:*`; an extracted repo pins `^version`. A
  pnpm `overrides`/catalog overlay lets a transition repo resolve either way.
- Encode the rule the fork tool already knows — `packages/*` ship as **one
  foundation batch** (verify-only, no cloud) — as the kernel's release unit.

**Done when** every `@saas/*` package publishes a versioned artifact on merge,
the monorepo still builds green via `workspace:*`, and a scratch external
workspace can `pnpm install @saas/contracts@^x` and typecheck against it.

**Note** `dependsOn[].input: true` (billing→contracts/db) keeps `--changed`
correct *inside* a repo; across repos the equivalent signal is a version bump,
which RF2's contract test guards.

## RF2 — The federation contract (wiring graph + scaffolding)

**Scope**

- **Wiring contract:** promote the cross-worker service-binding graph to an
  explicit, checked-in manifest with a guard test (a sibling of the existing
  `tests/config-worker` guard and `tooling/wire/render.mjs` conventions). Once
  workers span repos, the binding graph is an inter-repo API: a rename in repo A
  that breaks a binding in repo B must fail a test, not a production deploy.
- **Per-repo scaffolding:** extend `tooling/fork/components.mjs` to emit, for a
  chosen component set, a ready `intent.yaml` (repo-scoped `metadata.name`,
  discovery roots, the OCI stack source from RF0), a `ci.yml`, and the resynced
  `pnpm-lock.yaml` — reusing its existing prerequisite-graph + SCC batching so
  the tool *draws* the seam instead of a human guessing it.
- Define the **repo topology** as data the tool validates against: `stack`,
  `kernel`, `infra`, `core-runtime` (api-edge · identity · membership · projects
  · policy · config · events · admin), `commerce` (billing · metering ·
  notifications · webhooks), `agents` (agents · chat · mcp · state ·
  integrations), `console` (web-console-next · web-docs · website). The
  validator refuses any topology that splits a binding SCC.

**Done when** `components.mjs --plan-repo <group>` prints the exact component
closure + emits a scaffold, the wiring-contract test fails on an induced binding
rename, and the topology validator rejects an SCC-splitting cut.

## RF3 — Extract the frontend repo

**Scope**

- Move `web-console-next` + `web-docs` + `website` to their own repo. This is
  the cleanest cut in the system: `core/repo.md` already mandates the console
  talk to the **public API, not internal Worker bindings**, so it has no
  service-binding edges to sever.
- New repo consumes the OCI stack (RF0) and `@saas/sdk`/`@saas/contracts` as
  versioned deps (RF1). Its `intent.yaml` uses the
  `cloudflare-workers-assets-turbo` composition unchanged.
- Console remains *usable* only once `api-edge` + `identity-worker` are live —
  expressed as a documented runtime dependency, not a cross-repo `dependsOn`.

**Done when** the frontend repo plans/deploys `stage`/`prod` on its own CI with
the standard `orun plan`/`orun run` workflow, the console renders against the
existing public API, and the baseline monorepo still builds without it.

## RF4 — Extract the infra repo

**Scope**

- Move `infra/terraform/*` + `infra/db-migrate` to an `orun-infra` repo that
  provisions the shared data plane (Supabase, Hyperdrive, KV, domain) on its own
  cadence. Runtime repos consume outputs **only** through the BF5/BF6 wiring
  manifest in Secrets Manager — never committed IDs (BF6 invariant).
- Preserve the infra ordering (`bootstrap → supabase → cloudflare-hyperdrive →
  db-migrate`; `cloudflare-kv` before `api-edge`; `cloudflare-domain` last) as
  an *intra-repo* DAG so Orun still orders it in one plan.

**Done when** infra converges from its own repo, runtime repos resolve wiring
tokens at deploy time with no hand-pasted resource IDs, and a fresh account
still boots per the FORKING first-boot expectations.

## RF5 — Extract the first bounded-context service group

**Scope**

- Extract the **commerce** group — billing · metering · notifications ·
  webhooks — the cluster `core/operating-model.md` §First Extraction Candidates
  names first. Keep the `billing ↔ membership ↔ events ↔ notifications` SCC
  intact: if `membership`/`events` stay in `core-runtime`, the commerce→core
  edges become stable name-based bindings (RF2 contract); if the SCC must be
  whole in one repo, the topology validator says so and the group absorbs them.
- Use `components.mjs` to copy the closure + tests, resync the lockfile, and
  emit the repo scaffold (RF2). First convergence follows the documented
  binding-cycle seed (bootstrap deploy without bindings, then restore) and the
  "re-run the full workflow, never failed-jobs-only" rule.

**Done when** the commerce repo deploys `stage`/`prod` independently, its
workers bind to core workers by name across the repo boundary, end-to-end
billing still passes, and no client-visible contract changed.

## RF6 — Federated golden-path hardening

**Scope**

- Publish `ci.yml` as a **reusable GitHub workflow** from the stack repo so all
  repos share one CI definition (plan `--changed` + `orun run` matrix) instead
  of N drifting copies; publish a shared `intent` fragment for the common
  environment/trigger scaffold.
- Formalize per-repo Orun **state scoping** (`<org>/<repo>/…`, already
  parameterized) and document the promotion/approval model per repo.
- Tie federation into the **upstream-sync / `factory upgrade`** work
  (`saas-bootstrap-factory` BF11–BF14 / `orun` scaffolding): keeping N repos
  current with the baseline is strictly harder than one, so provenance-lock +
  upgrade must land alongside, not after, the first runtime split.
- Add a federation preflight to the BF9 doctor: stack pin present, kernel
  versions resolvable, wiring contract satisfied, no SCC split.

**Done when** a new golden-path repo is created from the scaffold + reusable
workflow with no hand-copied CI, the doctor validates a federated repo, and the
upstream-sync path can carry a baseline change into an extracted repo.

## Sequencing

RF0 → RF1 → RF2 are substrate work in the current monorepo and unlock
everything; do them first and in order. RF3 (frontend) is the lowest-risk first
real extraction and should precede RF4/RF5. RF5 is gated on a real owning team
(see risks). RF6 hardening runs alongside RF3–RF5 and must not lag the first
runtime split.
