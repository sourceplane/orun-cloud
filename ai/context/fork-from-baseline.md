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
  everywhere, replaced by the placeholder `your-workers-subdomain`.

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
- [ ] Real workers.dev subdomain: replace `your-workers-subdomain` in
  `apps/api-edge/src/app-config.ts`,
  `apps/web-console-next/src/lib/app-config.ts`,
  `apps/web-console-next/component.yaml`, and
  `apps/identity-worker/wrangler.jsonc` once the Cloudflare account's
  subdomain is known
- [ ] AWS-side provisioning under the new names (via `aws-admin`):
  GitHub OIDC roles for `sourceplane/orun-cloud` (plan +
  production-deploy per env), Secrets Manager write scope
  `sourceplane/orun-cloud/*`
- [ ] Supabase projects `orun-cloud-stage` / `orun-cloud-prod`
- [ ] `orun.dev` Cloudflare zone + DNS for `stage.orun.dev` /
  `prod.orun.dev`
- [ ] Register GitHub Apps for the integrations cluster (baseline gate
  D1: per-env App registration + worker secrets)
- [ ] Triage the inherited Dependabot alerts (75 reported on first push
  — baseline lockfile, visible because this repo is public)
