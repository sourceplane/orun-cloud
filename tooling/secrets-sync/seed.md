# SS3/SS6 — Seeding the integration & platform documents (human runbook)

One-time (per environment) operator action that moves the manually-managed
worker secrets **and** their paired non-secret config into AWS Secrets
Manager. After this, the deploy lane owns Cloudflare-side secrets and config —
never run `wrangler secret put` by hand, and never edit a client ID / product
map in a `wrangler.template.jsonc` again. Rotate by updating the document and
letting the next deploy push it.

## Storage model (SS6)

`integrations.manifest.json` is the source of truth. Each **provider
integration** is one document holding its config + secret(s); non-integration
secrets share one **platform** document.

| Document (per `<env>`) | Keys |
|---|---|
| `sourceplane/orun-cloud/integrations/github-oauth/<env>` | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` |
| `…/integrations/google-oauth/<env>` | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| `…/integrations/polar/<env>` | `BILLING_PROVIDER`, `POLAR_SERVER`, `POLAR_PRODUCT_MAP`, `POLAR_SUCCESS_URL`, `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` |
| `…/integrations/cloudflare-email/<env>` | `NOTIFICATIONS_PROVIDER`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` (no secret) |
| `…/integrations/github-app/<env>` | GitHub App config + secrets — **deferred** until the App is registered (`saas-integrations` D1) |
| `…/integrations/slack-app/<env>` | `SLACK_APP_CLIENT_ID`, `SLACK_APP_CLIENT_SECRET`, `SLACK_APP_SIGNING_SECRET` (per-environment Slack App, IH9) |
| `…/integrations/supabase-oauth/<env>` | `SUPABASE_OAUTH_CLIENT_ID`, `SUPABASE_OAUTH_CLIENT_SECRET` (per-environment Supabase OAuth app, IH9) |
| `…/platform-secrets/<env>` | `SECRET_ENCRYPTION_KEY`, `SECRET_KEK`, `OAUTH_STATE_SECRET`, `CLI_JWT_SIGNING_KEY`, `INTEGRATIONS_STATE_SECRET` |

**Critical:** `SECRET_ENCRYPTION_KEY` encrypts data at rest — escrow the value
currently deployed, do NOT generate a new one (a fresh key bricks stored
webhook endpoints and integration tokens).

**`SECRET_KEK` is the opposite** (saas-secret-manager SM2 — config-worker's
master key that wraps each workspace's data-encryption key). It is net-new:
nothing is encrypted under it until it is first present (v:2 envelopes begin
then; pre-existing v:1 rows keep decrypting under `SECRET_ENCRYPTION_KEY`), so
**generate a fresh 64-hex value** — `openssl rand -hex 32` — distinct per env.
Because `put-secret-value` replaces the whole platform document, fetch the
current doc, add `SECRET_KEK`, and write it back with every existing key intact.

## Steps (per environment: stage, then prod)

1. In a private shell (never a repo checkout, never echoed), build one JSON
   file per document above. Use the **current live values**; for config keys,
   copy what's in the matching `wrangler.template.jsonc` `vars` today. Shape
   for an integration doc, e.g. `github-oauth-stage.json`:

   ```json
   { "GITHUB_OAUTH_CLIENT_ID": "Ov23li…", "GITHUB_OAUTH_CLIENT_SECRET": "…" }
   ```

2. Validate completeness offline (fingerprints only, never values). Drop the
   per-doc files into a directory named `<doc>.json` (e.g. `github-oauth.json`,
   `polar.json`, `platform.json`) and run the projector for that env:

   ```bash
   node tooling/secrets-sync/assemble.mjs --env stage \
     --docs-dir /tmp/seed-stage \
     --out-secrets /tmp/ws.json --out-config /tmp/wc.json
   # exit 0 = every required key present; non-zero lists what's missing
   ```

3. Upload each document:

   ```bash
   aws secretsmanager create-secret \
     --name sourceplane/orun-cloud/integrations/github-oauth/stage \
     --secret-string file://github-oauth-stage.json
   # …repeat for google-oauth, polar, cloudflare-email, and platform-secrets
   # (use put-secret-value if the secret already exists)
   ```

4. Shred the local files: `shred -u *-stage.json`.

5. Deploy any worker (or merge any PR touching one). The `secrets-live` step
   pushes only what changed; first run after seeding pushes everything.

   **All-or-nothing per env**: `secrets-live` fetches every active
   integration doc + the platform doc. If the env is fully unseeded it
   clean-skips (existing wrangler-put secrets untouched). If *any* doc is
   present but the projection is incomplete (e.g. github-oauth seeded but
   google-oauth missing), the step **hard-fails** and lists the missing
   keys — never deploys a worker with half-seeded secrets. Seed every doc
   listed above for an env before triggering a deploy in that env.

6. Confirm: the deploy log shows `secrets-live: … pushing N secret(s)`; a
   second deploy shows `in sync — nothing to push`.

## Rotation (after seeding)

Update the value in the relevant document (`put-secret-value` with the full
updated JSON), then deploy the affected worker. Never touch Cloudflare
directly. For a config change (e.g. a new Polar product id), edit the `polar`
document — no code change, no template edit.
