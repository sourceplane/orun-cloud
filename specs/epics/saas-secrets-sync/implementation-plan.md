# saas-secrets-sync — Implementation Plan

Status: Normative for the SS cluster. As-built record in
`IMPLEMENTATION-STATUS.md`; decisions and human gates in
`risks-and-open-questions.md`.

## SS0 — Escrow convention + committed secrets manifest

**Scope**

- Define the escrow document: one AWS Secrets Manager secret per environment
  at `sourceplane/orun-cloud/worker-secrets/<env>`, JSON shape:

  ```json
  {
    "identity-worker": {
      "GITHUB_OAUTH_CLIENT_SECRET": "…",
      "GOOGLE_OAUTH_CLIENT_SECRET": "…",
      "OAUTH_STATE_SECRET": "…"
    },
    "billing-worker": { "POLAR_ACCESS_TOKEN": "…", "POLAR_WEBHOOK_SECRET": "…" }
  }
  ```

  This matches the wire-live fetch shape (`<component>__<env>.json`) so the
  composition step that already fetches wiring payloads can fetch escrow with
  the same mechanism and IAM grant (`sourceplane/orun-cloud/*` is already in
  the plan/deploy role policies).

- Commit `tooling/secrets-sync/secrets.manifest.json` — the **non-secret**
  declaration of which secret *names* each worker requires per environment.
  Derived today from the `wrangler secret put` comments in each
  `wrangler.template.jsonc`; becomes the single source of truth those comments
  point at.

- Record the convention in `specs/core/access-and-infra.md` (follow-up edit,
  same PR or next).

**Done when** the manifest is committed, covers every worker template's
documented secrets (identity, billing, webhooks, config, integrations), and
`access-and-infra.md` names the escrow path.

## SS1 — `secrets-check` drift detector

**Scope**

- `tooling/secrets-sync/check.mjs` — zero-dependency Node script, sibling in
  style to `tooling/wire/render.mjs` (fail-loud, `--`-flag CLI, no cloud SDK
  imports; payloads are fetched by the composition step, not the script).
- Modes:
  - `--escrow-dir <dir>`: validate fetched escrow payloads against the
    manifest — every required `worker/SECRET_NAME` present, no unknown extras
    (typo detection). Values are never printed; only names and SHA-256
    fingerprints.
  - `--deployed-dir <dir>`: validate `wrangler secret list` JSON output per
    worker (fetched by the lane) against the manifest — every required name
    deployed.
  - `--fixture <file>`: committed `escrow.fixture.json` with dummy values so
    PR verify lanes run offline, exactly like `wiring.fixture.json`.
- Exit non-zero listing every missing/unknown entry; never echo a value.
- Enforcement: a `tests/secrets-sync` quick-check component (standard
  turbo-package test shape) runs the checker against the fixture and the
  failure paths on every PR, and asserts the manifest covers exactly the
  worker templates that document a `wrangler secret put`.

**Done when** the checker runs green against the committed fixture in the PR
verify lane and red (with a complete, value-free report) when a manifest
entry is removed from the fixture.

## SS2 — `secrets-live` deploy-lane sync

**Scope**

- New `secrets-live` step in the Stack Tectonic worker deploy profile,
  ordered **after** `wrangler deploy` and before `smoke`: a first-boot worker
  must exist before secrets can be pushed (avoids the BF6b binding-cycle
  class of footgun), and `wrangler secret bulk` rolls a new version
  immediately, so smoke observes the synced state.
- Idempotence + value-drift: a non-secret fingerprint record
  (`<org>/<repo>/worker-secrets-fingerprints/<env>`, map of
  `worker → SECRET_NAME → sha256(value)[:16]`) lives next to the escrow in
  Secrets Manager — readable by checkers, unlike Cloudflare-side state —
  and is updated only after a successful push.
- Skip-if-unchanged: when fingerprints match the record, the step pushes
  nothing (no worker-version churn). The decision logic is the pure
  `tooling/secrets-sync/sync.mjs`; all cloud I/O stays in the composition
  step, mirroring the wire-live split.
- Pre-SS3 safety: no escrow document at all = clean skip (existing
  manually-put secrets untouched); escrow present but missing a required
  secret = hard failure (never deploy a worker with known-incomplete
  secrets).

**Done when** a worker whose escrow value changes gets the new value on the
next deploy with no human step, and an unchanged deploy does not create a new
secret version.

## SS3 — Escrow seeding of currently-manual secrets ⛔ human-gated

**Scope**

- Human writes the live values into
  `sourceplane/orun-cloud/worker-secrets/{stage,prod}`:
  identity (GitHub/Google client secrets + `OAUTH_STATE_SECRET`), billing
  (`POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`), webhooks/config/integrations
  (`SECRET_ENCRYPTION_KEY` — current values, pre-SS4), integrations GitHub App
  bundle when `saas-integrations` D1 lands.
- Provide a small seeding helper (`tooling/secrets-sync/seed.md` runbook or
  `aws secretsmanager put-secret-value` one-liners) that never echoes values.
- **Ordering constraint:** existing `SECRET_ENCRYPTION_KEY` values must be
  escrowed *as-is* (they encrypt data at rest — regenerating them bricks
  stored webhook endpoints/integration tokens).

**Done when** SS1's escrow check passes against live Secrets Manager for
stage and prod with zero manual `wrangler secret put` remaining in runbooks.

## SS4 — Shared secrets via Cloudflare Secrets Store

**Scope**

- Move account-level shared secrets (today: `SECRET_ENCRYPTION_KEY` used by
  webhooks-, config-, and integrations-worker) from three per-worker copies
  to one Secrets Store entry with three bindings.
- Terraform-manage the store entry (Cloudflare provider) with the value
  sourced from escrow; workers bind via `secrets_store_secret` in their
  templates.
- Keep per-worker secrets (OAuth, Polar) as plain worker secrets — Secrets
  Store earns its keep only where one value has multiple consumers.

**Done when** rotating the key in escrow updates all three workers through a
single store entry, and the per-worker copies are deleted.

## SS5 — Rotation runbook + BF9 preflight integration

**Scope**

- Per-class rotation runbook: provider-issued (Polar, OAuth — rotate at
  provider, escrow, redeploy), repo-generated (`OAUTH_STATE_SECRET` — free
  rotation), data-encrypting (`SECRET_ENCRYPTION_KEY` — requires re-encrypt
  migration; document the grace-window pattern already used by webhook secret
  rotation).
- Database credentials stay inside the Terraform component (rotation must
  update Supabase + Hyperdrive together; Secrets Manager auto-rotation
  lambdas would rotate one side only — explicitly out of scope).
- Wire SS1 checks into the BF9 preflight doctor when it lands.

**Done when** each secret class has a tested runbook and the doctor reports
escrow completeness per environment.

## Sequencing

SS0 → SS1 shipped (#342); SS2 shipped (#346); SS6a shipped (#348). SS6b-secrets
(this PR) wires the deploy lane to the SS6a layout, replacing the old
`worker-secrets/<env>` escrow read. SS3 unblocks on operator seeding of the
per-integration + `platform-secrets` documents; SS6b-config follows. SS4 after
SS3 (Secrets Store sources the shared key from the platform document); SS5
closes alongside BF9.

## SS6 — Integration documents (config + secret co-located per provider)

The escrow path is keyed by *worker* and holds *secrets only*. But a single
provider integration (GitHub OAuth, Polar, the GitHub App) has two halves: a
non-secret identifier/config (`GITHUB_OAUTH_CLIENT_ID`, `POLAR_PRODUCT_MAP`)
that today lives hardcoded in `wrangler.template.jsonc`, and a secret in
escrow. Re-registering or rotating an integration touches both places. SS6
makes **one provider integration = one document** holding both halves, so SM
is the single config point for integrations as well as secrets.

**Model.** `tooling/secrets-sync/integrations.manifest.json` is the source of
truth: each provider integration declares its `config` keys, `secret` keys,
and consuming workers; non-integration secrets (`SECRET_ENCRYPTION_KEY`,
`OAUTH_STATE_SECRET`, `INTEGRATIONS_STATE_SECRET`) share one `platform`
document. Storage:

- `<org>/<repo>/integrations/<name>/<env>` — config + secret per provider
- `<org>/<repo>/platform-secrets/<env>` — non-integration secrets

**Boundary.** Config keys are non-secret (may appear in logs, plan output, a
future config UI); secret keys never do. Both are tagged in the manifest and
projected into separate outputs.

### SS6a — model, projector, checker, seeding (this PR)

- `integrations.manifest.json` (source of truth) + `integrations.fixture.json`
  (offline dummy docs).
- `assemble.mjs` (pure, no cloud): `--project-manifest` regenerates the
  per-worker `secrets.manifest.json` (now a GENERATED projection, keeping the
  shipped SS1/SS2 contract intact); `--env/--docs-dir|--fixture` validates the
  fetched documents and emits the per-worker **secrets** view (feeds the
  unchanged `sync.mjs`) and the per-worker **config** view (for SS6b). Fails
  closed on any missing/empty required key.
- `tests/secrets-sync` gains assemble coverage + a consistency test asserting
  the committed `secrets.manifest.json` equals the projection.
- `seed.md` rewritten for the per-integration layout.

**Done when** the projector round-trips to the committed per-worker manifest,
the fixture covers every declared key, and the suite is green — with no change
to the deployed `secrets-live` behavior.

### SS6b — deploy-lane assembly + de-hardcode (follow-up)

Lands in two parts to decouple the secret hydration (mechanism) from the
template de-hardcoding (template churn across five workers).

**SS6b-secrets** (this PR — required to consume the SS6 layout)

- Rewrite `secrets-live` in `cloudflare-worker-turbo-verify-deploy.yaml` to:
  fetch the active per-integration documents (and `platform-secrets/<env>`)
  via `assemble.mjs --list-docs --env <env>` (skips fully-deferred
  integrations) + `aws secretsmanager get-secret-value` per doc; project them
  via `assemble.mjs --env <env> --docs-dir <dir> --out-secrets …`; feed the
  per-worker secret view into the unchanged `sync.mjs`.
- Transition contract: `ResourceNotFoundException` on a doc is tolerated and
  treated as "absent"; **all docs absent = clean-skip** (pre-SS3); **any
  doc seeded but partial = hard-fail** (assemble.mjs fails closed with a
  list of missing keys); non-NotFound errors fail hard. Drops the old
  `worker-secrets/<env>` escrow path.
- No template edits; client IDs and other Category-A `vars` stay hardcoded
  until SS6b-config.

**SS6b-config** (follow-up, larger blast radius)

- Add the `assemble` projection of the per-worker **config** view into the
  `tooling/wire/render.mjs` token mechanism (or a parallel step) so wrangler
  `vars` are rendered from the same fetched docs.
- Convert the Category-A `vars` in each `wrangler.template.jsonc` to wiring
  tokens and delete the hardcoded values, so SM becomes the only source.
- Extend SS1's verify-lane check to assert config-name coverage too.

**Done when** the OAuth client IDs, Polar product map, and email-from config
are rendered from SM at deploy and no longer committed in templates.
