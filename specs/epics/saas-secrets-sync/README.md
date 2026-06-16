# Epic: saas-secrets-sync

**One write path for every secret.** AWS Secrets Manager is the system of
record; Cloudflare holds deploy-time copies. Humans and Terraform write
secrets in exactly one place (`<org>/<repo>/…/<env>`), and the deploy lane
hydrates Cloudflare from it — no hand-run `wrangler secret put`, no
unrecoverable write-only copies, and a fresh Cloudflare account re-hydrates
from escrow with one apply. Lands in this baseline first; forks (e.g.
`orun-cloud`) pick it up through the normal fork-sync path with only the
`<org>/<repo>` namespace differing.

## Status

| Field | Value |
|-------|-------|
| Status | **In progress (SS0–SS2 shipped; SS3 operator seeding)** |
| Cluster | **SS** (SS0–SS5) |
| Owner(s) | `tooling/secrets-sync/` (new), `tests/secrets-sync/` (new), `stack-tectonic` worker compositions, `infra/terraform/*`, all `wrangler.template.jsonc` surfaces, `specs/core/access-and-infra.md` |
| Target branch | `main` |
| Builds on | BF5 (wiring manifest, ✅), BF6/BF6b (deploy-time wiring, ✅), `core/access-and-infra.md` secret namespace, `tooling/wire/render.mjs` conventions |
| End-state target | Every runtime worker secret is seeded once into AWS Secrets Manager, synced to Cloudflare by the deploy lane, drift-checked in verify lanes, and rotatable via a documented runbook |

## Thesis

The platform has two secret planes and only one of them is governed. The
**control plane** (Terraform-generated Supabase credentials, Hyperdrive/KV
wiring manifests) already follows `core/access-and-infra.md`: written to AWS
Secrets Manager under `<org>/<repo>/<component>/<env>`, OIDC-scoped IAM,
CloudTrail audit, consumed at deploy time by the BF6 wiring renderer.

The **runtime plane** (OAuth client secrets, `OAUTH_STATE_SECRET`,
`POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `SECRET_ENCRYPTION_KEY`, the
GitHub App bundle) is manual: per-env `wrangler secret put`, documented only
in template comments. Cloudflare worker secrets are write-only — they cannot
be read back, audited centrally, or recovered. Nothing guarantees a worker's
secrets exist before it deploys (the first-boot footgun BF6b hit live),
nothing detects drift between environments, and `SECRET_ENCRYPTION_KEY` is
hand-pasted into three workers (webhooks, config, integrations) with no
shared source.

The fix reuses the rails BF5/BF6 built rather than inventing new ones:

1. **Escrow convention** — one Secrets Manager document per environment,
   `<org>/<repo>/worker-secrets/<env>`, mapping `worker → SECRET_NAME →
   value`, plus a committed non-secret
   `tooling/secrets-sync/secrets.manifest.json` declaring which secrets each
   worker requires (SS0).
2. **Drift detection in verify lanes** — a zero-dependency checker (sibling
   of `tooling/wire/render.mjs`) that fails loudly when escrow is incomplete
   against the manifest or deployed secret names diverge, enforced by the
   `tests/secrets-sync` quick-check component (SS1).
3. **Deploy-lane sync** — a `secrets-live` step in the worker deploy lane
   that pushes escrow values to Cloudflare (after `deploy`, so first-boot
   workers exist; before `smoke`), with a non-secret fingerprint record in
   Secrets Manager for idempotence and value-drift detection (SS2).
4. **Seed + dedup** — humans escrow the currently-manual values once (SS3);
   shared keys move to Cloudflare Secrets Store bindings so one secret serves
   the three encryption-key consumers (SS4).
5. **Rotation + preflight** — a rotation runbook per secret class and escrow
   completeness wired into the BF9 doctor (SS5).

Anti-goals: workers never fetch AWS Secrets Manager at request time (latency,
SigV4 from the edge); secret values never appear in Terraform plans, CI logs,
job summaries, or this spec tree.

## Read order

1. `README.md` (this file).
2. `implementation-plan.md` — SS0–SS5 with scope and "done when".
3. `risks-and-open-questions.md` — decision points + human-input register.
4. `IMPLEMENTATION-STATUS.md` — as-built record.

## Milestones at a glance

| ID | Milestone | Human help? | Status |
|----|-----------|-------------|--------|
| SS0 | Escrow convention + committed secrets manifest | No | ✅ Shipped (#342) |
| SS1 | `secrets-check` drift detector enforced in verify lanes | No | ✅ Shipped (#342) |
| SS2 | `secrets-live` deploy-lane sync (escrow → Cloudflare) | Deploy approvals only | ✅ Shipped (#346) |
| SS3 | Escrow seeding of all currently-manual secrets | **Yes — human supplies/writes values** | 🛠️ In progress (operator) |
| SS4 | Shared secrets via Cloudflare Secrets Store | No (entitlement confirmed) | 🗓️ Ready — after SS3 |
| SS5 | Rotation runbook + BF9 preflight integration | No | 🗓️ Planned |
| SS6 | Integration documents: config + secret co-located per provider | **Yes — re-seed in the new layout** | 🛠️ In progress (SS6a shipped #348; SS6b secrets-half in flight; config-vars next) |
