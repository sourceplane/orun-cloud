# Fork tracking — orun-cloud from the baseline SaaS starter

This repo is an instantiation of the reusable multi-tenant SaaS starter
(`sourceplane/multi-tenant-saas`) as **Orun Cloud**. This document tracks
every transformation applied on top of the baseline so the delta stays
auditable and a future re-import or upstream sync knows what to re-apply.

Last updated: 2026-06-12

## Provenance

| | |
|---|---|
| Baseline repo | `sourceplane/multi-tenant-saas` |
| Baseline commit | `11a9f5d273...` ("fix(db-migrate): trigger apply — integrations migrations 180/190 never ran (#334)") |
| Import method | `git archive` snapshot, history stripped (no shared git history with upstream; upstream syncs are manual cherry-picks of content) |
| Import commit here | `93fcec4` ("Initial import from sourceplane/orun-cloud @ 11a9f5d" — message says orun-cloud due to a later sweep; the source was multi-tenant-saas) |
| Import verified | Secret sweep over the full tree and the 6-commit delta since the originally planned snapshot point (`3f44d35`): only synthetic test fixtures and documentation prose matched; no credentials, no committed resource IDs (BF6 discipline) |

## Transformation log

Applied as the Phase 3 rebrand PR (#4), in order:

### 1. Repo-derived parameters (`f191fb5`)
- `multi-tenant-saas` → `orun-cloud` in every repo-derived value:
  `intent.yaml` (`metadata.name`, per-env `repo:` params), root
  `package.json` name, every `apps/*/component.yaml` `repo:` field,
  AWS Secrets Manager paths (`sourceplane/orun-cloud/<component>/<env>`),
  GitHub OIDC role names (`<env>-github-sourceplane-orun-cloud-{plan,production-deploy}`),
  Supabase project names (`orun-cloud-stage`, `orun-cloud-prod`), docs.
- Removed `ORUN_BACKEND_URL: ${{ secrets.ORUN_BACKEND_URL }}` from
  `.github/workflows/ci.yml`. The orun backend URL resolves from
  `intent.yaml` (`execution.state.backendUrl`) — single source of truth;
  the unset secret would have injected an empty-string override.

### 2. Product domains (`1124624`)
- `sourceplane.ai` → `orun.dev` wherever it is the *product* domain:
  `BASE_DOMAIN`, `CONSOLE_CUSTOM_DOMAIN` (`stage.orun.dev`,
  `prod.orun.dev`), Polar success URLs, OAuth allowed console origins,
  CORS tests, infra/spec docs.
- **Kept**: `https://orun-api.sourceplane.ai` (the orun state backend,
  not a product domain) and company email addresses
  (`sales@sourceplane.ai`).

### 3. Deploy names, display strings, de-personalization (`00c65d1`)
- Worker/Pages names: `sourceplane-web-console*` → `orun-web-console*`
  (wrangler `name`, component `workerName`, `workerNamePrefix`, OAuth
  origins, specs).
- Wire-visible user agents: `Orun-Webhooks/1.0`,
  `orun-integrations-worker` (test assertions updated in lockstep).
- Console branding seam (`apps/web-console-next/src/lib/app-config.ts`,
  BF3): `PRODUCT_NAME = "Orun"`, manifest `Orun Console` /
  `Orun`, smoke-test grep `'Orun Console'`, localStorage namespace
  `orun.next`.
- Personal workers.dev subdomain (`rahulvarghesepullely`) removed
  everywhere, replaced by the placeholder `oruncloud`.

### 4. Code identifiers: SDK class + CLI bin (`1647158`)
- SDK: `Sourceplane` → `OrunCloud`, `SourceplaneError` →
  `OrunCloudError` (+ `ErrorInit`, `Resource`, `Factory`,
  `EventEnvelope`, `ComponentManifest` schema titles). This was the
  rename the baseline deferred to the BF12 blueprint rename map.
- CLI (via the `packages/cli/src/brand.ts` BF3 seam + hardcoded usage
  strings): bin `sourceplane` → `orun-cloud`, keychain service
  `orun-cloud-cli`, config dir `~/.config/orun-cloud`, env override
  `ORUN_CLOUD_CONFIG_DIR` (`brand.ts` derivation now maps hyphens to
  underscores so the env var name stays valid).
- Default API base: `api.sourceplane.dev` → `api.orun.dev`.
- Remaining product UA: `orun-identity-worker`.

### 5. BF6b — deploy-time wiring rollout to the worker fleet (PRs #6–#9)

The first main apply failed deploying identity-worker: every worker except
api-edge carried the baseline account's committed Hyperdrive config IDs
(`08f7c605…` stage / `ab2c21c2…` prod), which do not exist in the new
Cloudflare account. The baseline's BF6 ("pilot — api-edge only") already
defined the fix; this fork completed the fleet rollout the baseline had
staged as BF6b ("Inert until this worker gets a wrangler template"):

- 11 workers (admin, billing, config, events, identity, integrations,
  membership, metering, notifications, projects, webhooks):
  `wrangler.jsonc` → committed `wrangler.template.jsonc` with
  `@@wiring(cloudflare-hyperdrive/<env>:hyperdrive_id)@@` tokens; rendered
  config is gitignored; `wiring.fixture.json` + `wire:fixture` script per
  app; component.yaml gains `wranglerTemplate`/`wiringComponents`/
  `wiringEnvs`/`wiringFixture` and `dependsOn: cloudflare-hyperdrive`.
- `tests/config-worker/src/deployment-config.test.ts` re-anchored from
  "IDs match the known account" to the BF6 invariants: rendered configs
  carry valid, distinct 32-hex IDs; committed templates carry wiring
  tokens and never literal IDs (mirrors the composition's
  verify-worker-structure guard). Tolerant of partial rollout.

First-boot notes (observed while converging CI):
- PR (verify) lanes plan Terraform only; the supabase component's
  Secrets Manager secret (`sourceplane/orun-cloud/supabase/<env>`) is
  written on apply, so `cloudflare-hyperdrive` plans are red on a PR
  until the first main apply has run. Expected; converges post-merge.
- GitHub Actions `rerun_failed_jobs` deadlocks orun's remote state
  (`--exec-id <run>-<attempt>` changes while dependency jobs are not
  re-run). Always re-run the full workflow.
- **PR sizing principle (recorded 2026-06-12): keep PRs to a few
  components at a time.** Large PRs fan out 30–70 CI jobs that saturate
  the runner pool and starve every other run (the original fleet-wide
  BF6b PR #5 was closed for this reason and split into #6–#9).
- Worker service bindings (Cloudflare 10143) make first-boot creation
  order-sensitive: billing/membership/notifications/events form a
  binding cycle and policy-worker is bound by nearly everything. Seeded
  by temporarily emptying stage/prod `services` in the cycle templates
  (one PR), restoring them immediately after (next PR), then re-running
  the dependents' deploy runs. A future BF7-9 preflight should automate
  this two-phase bootstrap.
- Cloudflare free plan caps the account at 5 cron triggers (10072);
  integrations-worker's cron pushed past it. Resolved by upgrading to
  Workers Paid (same as the baseline — its #333 notes "Workers Paid
  lifted the trigger limit").

**Converged 2026-06-12 ~08:50 UTC**: all 12 workers + api-edge +
web-console deployed green across dev/stage/prod with deploy-time
wiring (live Hyperdrive IDs from the Secrets Manager manifest) and full
service bindings; supabase/hyperdrive/kv/domain/bootstrap applied;
migrations run.

## Intentionally NOT changed

| What | Why |
|---|---|
| GitHub org `sourceplane` (`owner:`, `namespace:`, `github.com/sourceplane/...`, `ghcr.io/sourceplane/orun`) | It is the org, not the product |
| `apiVersion: sourceplane.io/v1` in intent/component manifests | Manifest schema identifier owned by the orun tooling |
| `https://orun-api.sourceplane.ai` | orun state backend, declared in `intent.yaml` |
| S3 state buckets `sourceplane-<env>`, terraform `orgName`/`owner`/`namespace` defaults | Org-scoped shared infra (owned by `aws-admin`) |
| GitHub App slugs `sourceplane-dev\|stage\|prod` | Registered GitHub Apps; re-registration is an operator action (slugs are globally unique on GitHub) |
| npm scope `@saas/*` | Already product-neutral (baseline decision D4) |
| Company emails (`sales@sourceplane.ai`) | Real mailboxes |

## Pending operator actions

- [x] GitHub Actions secrets: `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_API_TOKEN`, `SUPABASE_API_KEY` (set 2026-06-12)
- [x] Real workers.dev subdomain: `oruncloud` (discovered from the
  api-edge prod deploy log; set 2026-06-12)
- [ ] AWS-side provisioning under the new names (via `aws-admin`):
  GitHub OIDC roles for `sourceplane/orun-cloud` (plan +
  production-deploy per env), Secrets Manager write scope
  `sourceplane/orun-cloud/*`
- [ ] Supabase projects `orun-cloud-stage` / `orun-cloud-prod`
- [x] `orun.dev` zone live: apex = marketing site (wrangler custom
  domain on the `website` worker), `app.orun.dev` = prod console,
  `stage.orun.dev` = stage console. Console domains are managed by the
  re-enabled v4 `cloudflare_workers_domain` resource in
  `infra/terraform/cloudflare-domain` — the baseline had fenced it
  mid-0085a/b provider migration; this fork has clean state so the v4
  resource is active (rename to `cloudflare_workers_custom_domain` on
  the eventual v5 provider upgrade)
- [ ] Register GitHub Apps for the integrations cluster (baseline gate
  D1: per-env App registration + worker secrets)
- [x] Cloudflare Workers Paid plan (cron trigger limit; upgraded
  2026-06-12)
- [x] Dependabot triage round 1 (2026-06-12): 47 audit findings → 9
  (0 critical/high). next 15.0.3→15.5.18, @opennextjs/cloudflare
  1.0.4→1.17.1, vitest ^2→^3.2.6, fast-xml-parser override >=4.5.5,
  in-range `pnpm update -r`. Remaining 2 low + 7 moderate are
  transitive without in-range patches; revisit periodically
- [ ] Upstream the deploy-profile wire-fixture fix (PR #10) to
  multi-tenant-saas — its api-edge deploy lane has the same latent gap
