# saas-bootstrap-factory — implementation plan

Status: Draft. Milestone IDs BF0–BF14. Each milestone is one orchestrator task
(one reviewable outcome), independently valuable, and ordered so every step
builds on the previous. "Human help" is called out per milestone; the
consolidated register lives in `risks-and-open-questions.md`.

Phases:

- **A — Truth & typed parameters:** BF0, BF1, BF2
- **B — Identity & wiring:** BF3, BF4, BF5, BF6
- **C — Infra completeness:** BF7, BF8, BF9
- **D — The factory:** BF10, BF11, BF12
- **E — Prove & sustain:** BF13, BF14

---

## Phase A — Truth & typed parameters

### BF0 — Truth pass: docs match code reality

**Why now.** The root `README.md` still says Workers/Hyperdrive/migrations are
"not yet implemented" (~280 PRs stale) and pins a contributor's personal
machine path for `kiox`. `specs/core/orun-golden-path.md` cites Orun `v2.3.0`
while `kiox.yaml` pins `v2.14.0`. A factory whose own front door lies about
the product cannot be cloned with confidence, and agents keep re-deriving
reality from git instead of docs.

**Scope.**
- Rewrite root `README.md`: actual component inventory (12 workers + console +
  db-migrate + 5 terraform + packages), actual status, generic `kiox`/orun
  invocation (no `/Users/...` paths).
- Update `specs/core/orun-golden-path.md` version references to track
  `kiox.yaml` (state "the pinned version in `kiox.yaml`" instead of a literal
  where possible).
- Sweep `agents/orchestrator.md` and `specs/core/access-and-infra.md` for the
  same machine-specific paths and stale-version claims.

**Done when.** A new contributor (or instantiated repo) can follow the README
end-to-end; no doc names a personal filesystem path; version claims have one
source of truth.

**Human help.** None.

### BF1 — Encode the real infra dependency DAG

**Why now.** `supabase → bootstrap` and `cloudflare-hyperdrive → supabase`
ordering is real (Hyperdrive reads the Secrets Manager document Supabase
writes) but only implicit. Orun cannot enforce or even see it. Any fresh
instance hits this immediately because nothing exists yet and ordering
actually matters.

**Scope.**
- Add `dependsOn` edges: `supabase → bootstrap`,
  `cloudflare-hyperdrive → supabase`, `db-migrate → supabase` (infra edge, in
  addition to the existing `db` package edge). `cloudflare-kv` stays
  independent; `cloudflare-domain → web-console-next` already exists.
- Validate with `orun plan --view dag` for full and `--changed` plans; confirm
  no cycle and no unintended fan-in serialization on PR verify lanes.
- Record in `ai/context/decisions.md` whether the known cross-environment
  `dependsOn` limitation (see the `db → db-tests` note) bites here; if it
  does, document the constraint in the composition README and keep the edge on
  matching environments only.

**Done when.** The compiled plan DAG shows the edges; removing a hand-ordered
assumption from docs does not change behavior.

**Human help.** None.

### BF2 — Parameterize the Terraform + stack identity surface

**Why now.** Three classes of literals make the stack non-reusable at the
*composition* layer — exactly the layer that is supposed to be published and
shared: (1) the AWS account ID / role ARNs hardcoded inside three Stack
Tectonic job templates (`terraform-validate`, `cloudflare-domain-validate`,
`db-migrate-run`); (2) the Supabase org ID and region hardcoded in
`infra/terraform/supabase/terraform/main.tf` (not even variables); (3)
assorted `default = "sourceplane..."` values scattered through `.tf` files.

**Scope.**
- Lift role-assumption inputs into the affected composition `schema.yaml`s as
  required typed parameters (e.g. `awsRoleArnPlan`, `awsRoleArnApply` or an
  `awsAccountId` + naming convention) with values supplied via
  `intent.yaml` `parameterDefaults.terraform`. Stack Tectonic job templates
  must contain **zero** account literals afterward.
- Convert Supabase `org_id`/`region` to variables fed the same way.
- Normalize `.tf` identity defaults so `orgName`/`owner`/`repo`/`baseDomain`
  flow from intent defaults; keep harmless local defaults only where Terraform
  requires one.
- Verify with `orun plan` + a stage `plan-only` lane that rendered Terraform
  inputs are unchanged for this instance (pure refactor).

**Done when.** `grep -r "306024784101\|dwazxcrywsdbxpuouifa" stack-tectonic
infra` returns nothing outside `intent.yaml`; the stack is account-agnostic
and publishable as-is.

**Human help.** None (no live values change for this instance).

---

## Phase B — Identity & wiring

### BF3 — App identity via config indirection

**Why now.** Identity is hardcoded *inside source code*:
`apps/api-edge/src/cors.ts` (workers.dev subdomain constant + constructed
console origins), `apps/web-console-next/src/lib/api.ts` (api-edge URLs),
console branding in `layout.tsx`/`login`, and the webhooks `User-Agent`.
Templating TypeScript is brittle; reading configuration is not. This is the
decision that keeps the eventual blueprint surface tiny: **source stays
literal and committed; only config is generated.**

**Scope.**
- Introduce one identity config seam per app (e.g. `src/app.config.ts` or a
  shared `@saas/contracts` identity type + per-app values) carrying:
  `productName`, `orgName`, `baseDomain`, `workersDevSubdomain`,
  `workerNamePrefix`, per-env console/api origins.
- Refactor `cors.ts`, `lib/api.ts`, branding, and the webhooks UA to consume
  it. Values flow from existing build/deploy inputs (wrangler `vars`,
  `NEXT_PUBLIC_*`) so runtime behavior is identical.
- Update the affected tests (`tests/api-edge/src/cors.test.ts` fixtures) to go
  through the seam.
- Align `component.yaml` smoke commands to derive hostnames from parameters
  (`${WORKERS_DEV_SUBDOMAIN}`, `${ORUN_ENVIRONMENT}`) instead of literals
  where the harness already exposes them.

**Done when.** `grep -rn "rahulvarghesepullely\|sourceplane" apps/*/src
packages/*/src` returns only the config seam files (and `@saas/` package
names); stage smoke is green.

**Human help.** None.

### BF4 — Generalize runtime binding names

**Why now.** Every DB-using worker binds Hyperdrive as `SOURCEPLANE_DB`, and
code reads that name. Binding names are API between infra and code; a generic
name removes a whole class of rename churn from instantiation.

**Scope.**
- Rename `SOURCEPLANE_DB` → `PLATFORM_DB` (final name decided in
  `risks-and-open-questions.md`) across all 13 `wrangler.jsonc` files and
  every `env.` accessor; same for any other branded binding/var names found in
  the sweep.
- One mechanical PR; deploy is config-only per worker. Verify stage smoke per
  worker after deploy.

**Done when.** No branded binding names remain; stage and prod deploy green.

**Human help.** Deploy approvals only (stage/prod `requireApproval: true`).

### BF5 — Wiring manifest: Terraform publishes resource outputs

**Why now.** Hyperdrive IDs (×2 envs × 13 workers), the KV namespace IDs, and
the zone ID are created by Terraform but hand-pasted into configs. Before the
consumption side can change (BF6), the production side needs a stable,
machine-readable home.

**Scope.**
- Each infra component writes its consumable outputs into a single per-env
  wiring document: `<org>/<repo>/wiring/<env>` in AWS Secrets Manager (or SSM
  — decide in risks doc; Secrets Manager keeps one access pattern with the
  Supabase doc), e.g. `{ hyperdrive_id, kv_api_edge_idempotency_id, zone_id,
  console_custom_domain }`.
- Each component owns only its keys (merge-on-write or per-component
  sub-paths aggregated by a tiny reader — prefer per-component paths
  `wiring/<env>/<component>` to avoid write contention).
- Extend the `terraform` composition contract so "publish outputs to wiring"
  is a typed capability, not a per-component shell snippet.

**Done when.** Stage + prod wiring documents exist, populated by `apply` runs,
and a read script can assemble the full per-env wiring map in CI.

**Human help.** Deploy approvals only.

### BF6 — Deploy-time wiring in the worker compositions (keystone)

**Why now.** This closes the only true end-to-end blocker. After BF6, a fresh
environment is: run infra applies → wiring manifest exists → workers deploy
with bindings resolved from it. No committed resource IDs, ever.

**Scope.**
- Commit `wrangler.template.jsonc` per worker; the committed file carries
  structure + identity placeholders, not resource IDs.
- Add a `wire` capability/step to `cloudflare-worker-turbo` and
  `cloudflare-workers-assets-turbo` job templates (between `pre-deploy` and
  `deploy`): read the wiring manifest for `{{ .orun.environment.name }}`,
  render the deployable `wrangler.jsonc`, fail loudly on missing keys.
- PR `verify` profile keeps working without cloud access: dry-run renders
  with committed placeholder values (a checked-in `wiring.fixture.json`), so
  `--dry-run` stays offline.
- Pilot on `api-edge` (it consumes both Hyperdrive and KV), then one
  mechanical rollout PR for the remaining 12 workers + console.
- Delete every hardcoded Hyperdrive/KV ID from the repo; add a CI guard
  (lint or composition step) that rejects hex resource IDs in `wrangler*`.

**Done when.** `grep -rn "08f7c605\|ab2c21c2\|2f5a03d0\|fac1d319" .` is empty;
stage + prod deploys are green through the wire step; a deliberately missing
wiring key fails the deploy with a clear message.

**Human help.** Deploy approvals only.

---

## Phase C — Infra completeness

### BF7 — Finish cloudflare-domain v5 re-import (existing deferred task 0085b)

**Why now.** The console custom-domain attachment was dropped from state in
the v4→v5 provider migration (Phase 1); the output is a placeholder. A
bootstrap that cannot attach a custom domain is not "production same
standard".

**Scope.** As specced in the 0085b deferral: re-import the live attachment as
`cloudflare_workers_custom_domain` under provider `~> 5.0`, restore real
outputs, publish `zone_id`/domain into the BF5 wiring manifest, and make
`zoneMode: managed` a tested path (zone creation for greenfield instances).

**Done when.** Custom domains for stage/prod are Terraform-managed again;
`worker_custom_domain_id` is real; a managed-zone plan renders cleanly.

**Human help.** Deploy approvals. Registrar access **only if** NS/DNS records
need touching during re-import (expected: none for `zoneMode: existing`).

### BF8 — Foundation component: fresh-account bootstrap

**Why now.** Everything upstream of `bootstrap` (GitHub-OIDC IAM roles, S3
state buckets `sourceplane-<env>`, the lock table) lives in the external
`aws-admin` repo. A new instance in a new AWS account has no automated path to
that baseline — today it is the largest unautomated prerequisite.

**Scope.**
- New `infra/terraform/foundation` component that can create the OIDC
  provider, repo-scoped plan/apply roles, state buckets, and lock table for a
  **fresh** account, parameterized by the BF2 inputs.
- Chicken-and-egg handled explicitly: foundation runs once with bootstrap
  credentials and local state, then migrates its own state into the bucket it
  created (documented `terraform-local` profile path, mirroring the existing
  composition profile).
- For *this* instance, foundation is import-only/no-op: `aws-admin` remains
  the owner; the component documents and verifies, it does not duplicate.
  Record the ownership decision in `ai/context/decisions.md`.

**Done when.** A documented one-command path prepares a fresh AWS account to
the point where the existing `bootstrap` component passes; this instance's CI
behavior is unchanged.

**Human help.** **Yes (one-time per new account):** AWS administrator
credentials to run the first foundation apply, plus the decision on
`aws-admin` ownership boundaries for this instance.

### BF9 — Preflight doctor

**Why now.** A fresh clone fails late and cryptically (missing GitHub secret,
under-scoped Cloudflare token, absent Supabase org token, unassumable role).
Every external prerequisite should be checkable in one command before any
plan/apply runs.

**Scope.**
- `tooling/preflight` (or `packages/factory` subcommand): red/green checklist
  for — required GitHub secrets present (`ORUN_BACKEND_URL`,
  `CLOUDFLARE_API_TOKEN` + scope probe, `CLOUDFLARE_ACCOUNT_ID`,
  `SUPABASE_API_KEY`), AWS role assumable + state bucket reachable, Supabase
  org accessible, zone resolvable, wiring manifest present per env, `kiox`
  provider pin resolvable.
- Expose it both as a local command and as an early Orun job (a `preflight`
  component subscribed `dev`/`verify`) so CI fails fast with a human-readable
  report.

**Done when.** On this repo all checks pass; deleting a secret in a test run
produces a precise, actionable failure before any Terraform runs.

**Human help.** None to build. Humans supply whatever secrets it reports
missing (that is its purpose).

---

## Phase D — The factory

### BF10 — Consume the published OCI stack

**Why now.** The composition stack is published to GHCR (`publish-stack`) but
nothing consumes it; this repo uses `kind: dir`. Cross-repo reuse — the whole
point of a golden-path stack — is therefore unproven.

**Scope.**
- Verify the `release` profile actually publishes `stack-tectonic` (post-BF2,
  now account-agnostic) and that versioning/locking behaves.
- Add a consumer fixture (e.g. `tests/stack-consumer/` or a scratch repo): a
  minimal `intent.yaml` with `kind: oci` source pointing at the published
  stack + one `turbo-package` and one `cloudflare-worker-turbo` smoke
  component; `orun validate` + `orun plan` must succeed against the OCI
  artifact.
- Golden repo itself **stays** on `kind: dir` (deliberate dogfooding —
  `ai/context/decisions.md`); instantiated repos will pin OCI.

**Done when.** The fixture validates and plans against
`ghcr.io/sourceplane/stack-tectonic:vX` with no repo-local compositions.

**Human help.** GHCR package permissions if the release publish lacks them
(likely already in place — CI logs into GHCR today).

### BF11 — Blueprint + Instance contracts

**Why now.** With BF2–BF6 done, the per-instance surface is small and
enumerable. Freeze it as a typed contract before building the tool — the same
contract-first rule the constitution applies to APIs.

**Scope.**
- `specs/core/contracts/blueprint.schema.yaml`: a Blueprint is `metadata` +
  `requires` (stack + catalog version ranges) + `parameters` (JSON-Schema,
  draft-07, mirroring the existing `ComponentSchema` style) + `modules[]`
  (`name`, `type`, `target` path, `content` mode `template|copy|consume`,
  `bind` — which files take which parameters, `wiring`, `dependsOn`) +
  `overlays[]`.
- `specs/core/contracts/instance.schema.yaml`: concrete values — org/product
  names, base domain, workers.dev subdomain, package scope, Cloudflare/AWS
  account IDs, Supabase org + region, env set, billing product map, feature
  toggles.
- Author `blueprint.yaml` at the repo root **describing this repo as a
  blueprint of itself** (the repo-structure map is derived from module
  `target`s and validated against `intent.yaml` discovery roots — never
  authored separately).
- Decide and record copied-vs-consumed per module: `contracts`, `sdk`, `db`,
  `policy-engine`, `shared` are designated **consume** (dependency, not
  copy); workers/console/infra/intent are **template**; plain `turbo-package`
  tests follow their subject.

**Done when.** Schema validation passes on `blueprint.yaml` +
`instance.yaml` for this repo's own values; every templated file is listed in
exactly one module's `bind`.

**Human help.** None.

### BF12 — Instantiator v1

**Why now.** All prior milestones shrank the rendered surface to:
`intent.yaml`, per-component env/parameter values, wrangler template identity
fields, app config seeds, Terraform defaults, optional package-scope rename.
Now the tool is small.

**Scope.**
- `tooling/factory` (or `packages/factory`): `factory instantiate
  --blueprint . --values instance.yaml --out <dir>` → renders a complete,
  normal Orun repo; `kiox.yaml` pins the published stack (BF10);
  `.orun/provenance.lock` records blueprint version + stack version + values
  hash.
- Validation gates built in: render → `orun validate` → `orun plan --dry-run`
  must pass before the tool reports success.
- **Idempotence test in CI:** instantiating with this repo's own
  `instance.yaml` reproduces this repo (allowing the documented
  blueprint-managed file list); diff must be empty. This single test keeps
  blueprint and reality from drifting forever after.
- Package-scope rename (`@saas/` → `@<scope>/`) implemented as a
  deterministic rename map over `package.json` + imports + turbo filters; the
  default is **keep `@saas/`** (it is already generic — see risks doc).

**Done when.** The idempotence test is green in CI; `factory instantiate`
with toy values produces a repo where `orun validate` and a full dry-run plan
succeed offline.

**Human help.** None.

---

## Phase E — Prove & sustain

### BF13 — First real instantiation rehearsal ("acme")

**Why now.** Nothing above counts until a second product exists. This
milestone is the acceptance test of the whole epic and the forcing function
for every gap the previous steps missed.

**Scope.**
- Instantiate `acme-saas` from `instance.yaml` into a new GitHub repo; run
  preflight (BF9); run foundation (BF8) against a scratch AWS account; let
  Orun converge: bootstrap → supabase → hyperdrive/kv → db-migrate → workers →
  console → domain; verify the live console + API smoke on the acme domain.
- Capture every manual touch in a runbook delta; anything that was manual but
  automatable becomes a follow-up task.
- Tear-down path documented (and exercised for the scratch account).

**Done when.** A second live SaaS (stage env minimum, prod optional) serves
traffic from values only, and the runbook's manual-step list matches the
human-help register exactly — no surprises.

**Human help.** **Yes — the heavy one (per new instance, by design):**
- New/scratch **AWS account** + admin creds for foundation's first apply.
- New **Cloudflare account/zone** + API token; **domain** + registrar NS
  delegation.
- New **Supabase org** + management token.
- New **GitHub repo** + the four Actions secrets.
- **OAuth apps** (GitHub/Google client IDs + secrets) and **billing products**
  (Polar/Stripe product IDs) if those surfaces are enabled.
- Plan-apply approvals throughout (`requireApproval: true`).

### BF14 — Upgrade path + conformance suite

**Why now.** Without an upgrade story every instance is a permanent fork and
the "factory" claim dies in six months. Without conformance, instances drift
off the constitution silently.

**Scope.**
- `factory upgrade`: re-render the new blueprint version against
  `.orun/provenance.lock` and 3-way-merge into the instance as a PR;
  file-ownership convention enforced (blueprint owns manifests, templates,
  generated config; humans own feature code; conflicts surface in the PR).
- Ship the conformance pack to instances: constitution checks
  (org-scoping invariant tests, contract tests from `packages/contracts`,
  the BF6 no-hardcoded-ID guard, envelope/event schema validation) wired as a
  standard `turbo-package` test component so `orun plan` runs it everywhere.
- Exercise end-to-end once: land a small change in the golden repo, publish,
  `factory upgrade` the acme instance, merge the generated PR, CI green.

**Done when.** A golden-repo change reaches the acme instance as a reviewed
upgrade PR with green conformance; divergent instance edits in human-owned
files survive untouched.

**Human help.** None beyond normal PR review on the instance.

---

## Sequencing rules for the Orchestrator

- BF0–BF2 are independent of each other and safe to run first/in parallel;
  everything in Phase B assumes BF2's parameter plumbing exists.
- BF6 must not start before BF5 lands on stage; pilot on `api-edge` before
  the fleet rollout.
- BF7 can run any time after BF5 (it feeds the wiring manifest).
- BF8 and BF9 are independent of Phase B and may interleave.
- BF11 must not start before BF3/BF4/BF6 have shrunk the bind surface —
  freezing the contract earlier bakes in the wrong shape.
- BF13 is the only milestone that *requires* the human-help register resolved
  up front; schedule it only when the register's "acme" column is fully
  supplied, per the deferred-decision protocol in `agents/orchestrator.md`.
