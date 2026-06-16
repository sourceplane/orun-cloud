# Implementation Status — saas-secrets-sync

As-built record for the SS cluster. Design intent is in
`implementation-plan.md`; trust code over this doc — re-derive from `git`/PRs
on boot.

## Summary

| ID | Status | Evidence / notes |
|----|--------|------------------|
| SS0 | ✅ Shipped (#342) | Escrow convention documented (`access-and-infra.md` § Worker runtime secrets); `tooling/secrets-sync/secrets.manifest.json` committed — names derived from the `wrangler secret put` comments across the five secret-bearing worker templates (identity, billing, webhooks, config, integrations-deferred). |
| SS1 | ✅ Shipped (#342) | `tooling/secrets-sync/check.mjs` + `escrow.fixture.json` committed; enforced in verify lanes by the `tests/secrets-sync` quick-check component (jest suite covers green/missing/typo/empty/strict/deployed paths and manifest↔template coverage). |
| SS2 | ✅ Shipped (#346) | `secrets-live` step in `cloudflare-worker-turbo` deploy profile (after `deploy`, before `smoke`); pure decision tool `tooling/secrets-sync/sync.mjs` + 7 jest cases; `secretsWorker` parameter set on the five secret-bearing workers. |
| SS3 | 🛠️ In progress (human) | SS2 live on main (merge run 27428163400: all 15 worker deploy lanes green, secrets-live clean-skip pre-seeding). Operator seeding the stage/prod escrow per `tooling/secrets-sync/seed.md`. |
| SS4 | 🗓️ Ready | Secrets Store entitlement confirmed on the account (2026-06-12). Implement after SS3 seeding (Terraform sources the shared key from the escrow). |
| SS5 | 🗓️ Planned | Pairs with BF9 preflight doctor. |
| SS6a | ✅ Shipped (#348) | `integrations.manifest.json` (source of truth) + `integrations.fixture.json`; `assemble.mjs` projects per-integration/platform documents → the per-worker secret view (regenerates the now-GENERATED `secrets.manifest.json`, keeping SS1/SS2 intact) + a per-worker config view. 8 jest cases incl. a projection-consistency guard; `seed.md` rewritten for the per-integration layout. Deployed `secrets-live` behavior unchanged. |
| SS6b (secrets-half) | 🛠️ In progress | `secrets-live` step rewritten to fetch the per-integration + platform docs and project them via `assemble.mjs --env … --docs-dir …`, then feed the resulting per-worker view into the unchanged `sync.mjs`. `assemble.mjs --list-docs --env <env>` emits the fetch list (active integrations + platform; fully-deferred integrations excluded). Transition contract: no docs at all = clean-skip (pre-SS3); any doc seeded but partial = hard-fail via `assemble.mjs`. 4 new jest cases for `--list-docs`. Config-vars rendering into `wrangler vars` follows in SS6b-config. |
| SS6b (config-vars) | 🗓️ Planned | Render the per-worker config view from `assemble.mjs --out-config` into `wrangler.template.jsonc` `vars` via `tooling/wire/render.mjs` tokens; de-hardcode the Category-A `vars` (GITHUB_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_ID, POLAR_PRODUCT_MAP, EMAIL_FROM_ADDRESS, …) from the worker templates. |

## Decisions taken

- SS2 ordering: secrets-live runs **after** `wrangler deploy` — a first-boot
  worker must exist before `wrangler secret bulk` can target it; the bulk
  push rolls a new version immediately and `smoke` runs after it.
- SS2 fingerprint record lives in Secrets Manager
  (`<org>/<repo>/worker-secrets-fingerprints/<env>`), not as a worker var:
  Cloudflare-side state is awkward to read back; the SM record is readable
  by the same checkers that read escrow.
- Pre-SS3: absent escrow document = clean skip; present-but-incomplete
  escrow = hard failure.

- Escrow path: `sourceplane/orun-cloud/worker-secrets/<env>` (one JSON
  doc per environment, `worker → SECRET_NAME → value`), shaped to be fetchable
  by the same composition mechanism as BF6 wire-live payloads.
- AWS Secrets Manager is the system of record; Cloudflare worker secrets /
  Secrets Store are deploy-time copies. Workers never read AWS at runtime.
- Baseline-first: the epic ships here; forks consume it via fork-sync and
  seed their own escrow values under their own `<org>/<repo>` namespace.
- SS6 storage model (operator decision, 2026-06-13): **one merged document per
  provider integration** (config + secret co-located), with non-integration
  secrets in a single `platform-secrets` document. `assemble.mjs` projects this
  into the per-worker secret view the shipped tools already consume, so the
  storage reorg does not rewrite the live `secrets-live` contract.
- Config/secret boundary held: config keys are non-secret and projected
  separately from secrets; no tool prints a secret value.
