# saas-secrets-sync — Risks & Open Questions

Live register. Remove entries when resolved; record the decision in
`IMPLEMENTATION-STATUS.md`.

## ⛔ Human-input gates (do NOT auto-pick)

| Item | Blocking decision | Unblock signal |
|------|-------------------|----------------|
| **SS3 — escrow seeding** | Human must write live secret values into `sourceplane/orun-cloud/worker-secrets/{stage,prod}`. The existing manually-`put` values (notably `SECRET_ENCRYPTION_KEY` — it encrypts data at rest) must be escrowed *as-is*, not regenerated. | Values present; SS1 escrow check green against live Secrets Manager. |
| **Fork instances** | Each fork (e.g. `orun-cloud`) escrows its own values under its own `<org>/<repo>/worker-secrets/<env>` path — values never sync across instances, only the mechanism does. | Fork operator seeds its escrow after syncing this epic down. |

## Open design questions

| Item | Question | Current lean |
|------|----------|--------------|
| Escrow granularity | One document per env (`worker-secrets/<env>`) vs one per worker per env. Per-env is one seed/IAM surface and matches the wire-live fetch shape; per-worker shrinks blast radius and per-secret rotation cadence. | Per-env now; revisit if a single worker's secrets need a distinct IAM principal. |
| Fingerprint exposure | `SECRETS_FINGERPRINT` publishes truncated `sha256(value)` as a worker var. Hashes of high-entropy secrets reveal nothing useful, but low-entropy values would be oracle-checkable. | Acceptable; enforce generated-not-chosen values for repo-owned secrets. |
| Bulk vs per-name push | `wrangler versions secret bulk` minimizes version churn but couples to Wrangler version behavior; per-name `secret put` is simpler but creates one version per secret. | Decide in SS2 against the pinned Wrangler version. |
| dev environment | `dev` has no Supabase project and verify-only lanes; does it get an escrow doc? | No — fixture-only in dev, consistent with wiring fixtures. |

## Standing risks

- **Terraform state plaintext** — values Terraform writes/reads (Supabase
  creds, future Secrets Store entries) land in S3 state. Mitigated by
  encrypted, IAM-scoped buckets; adopt write-only arguments (TF ≥ 1.11)
  per-resource as provider support allows.
- **`SECRET_ENCRYPTION_KEY` regeneration** — it encrypts data at rest;
  seeding must escrow the *existing* values. A regenerated key without a
  re-encrypt migration bricks stored webhook endpoints and integration
  tokens.
- **Cloudflare secrets are write-only** — nothing in the sync path may ever
  depend on reading a value back from Cloudflare; comparisons are
  name-presence + fingerprint only.
