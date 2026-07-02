---
title: Operations
description: Day-2 operations for an Orun Cloud instance — environments and promotion, database migrations, the secrets model, the admin/support plane, and observability.
---

Day-2 operations for an Orun Cloud instance follow from the deployment model:
every change converges through `orun run` on merge, secrets live in one system
of record, and the support plane is internal-only and audited. This page covers
what an operator touches after [the first deploy](/self-hosting/deploy-your-own).

## Environments and promotion

Three environments are declared in `intent.yaml`:

| Environment | Behavior |
| --- | --- |
| `dev` | **Verify-only by design** — builds, tests, and Terraform plans run, but nothing deploys and no Supabase project is provisioned for it. `requireApproval: "false"`. |
| `stage` | Verifies on PRs; deploys on merge to `main` behind `requireApproval: "true"`. Console at `stage.<domain>`. |
| `prod` | Same triggers as stage, plus a **promotion dependency on `stage`** — prod converges only after stage. `requireApproval: "true"`. Console at the production domain. |

Approval gates mean a human approves the stage/prod deploy lanes on every
merge. When re-running CI, re-run the **full workflow** — orun's remote state
keys on run + attempt, and a partial "re-run failed jobs" deadlocks.

## Database migrations

Migrations run through the **`db-migrate` component** (`infra/db-migrate`), a
first-class unit of intent like everything else:

- Migration sources live in `packages/db/src/migrations`; the component targets
  the `stage` and `prod` Supabase databases.
- **Plan on PRs, apply on merge to `main`** — the same profile rule as every
  other production component.
- The database connection is read from the secret the `supabase` Terraform
  component writes to AWS Secrets Manager; nothing is hand-configured.
- `infra/db-migrate/migrations.lock` mirrors the migration set so that adding a
  migration changes a file inside the component directory — which is what
  orun's `--changed` planner keys on. Regenerate it whenever you add a
  migration (`pnpm --filter @saas/db gen:migrations-lock`; a test enforces it).
  Without the lock, new migrations would silently never be scheduled.

## Secrets model

AWS Secrets Manager is the **system of record**; Terraform generates
credentials and writes them there — no human pastes connection strings:

```text
<org>/orun-cloud/<component>/<env>          # e.g. sourceplane/orun-cloud/supabase/stage
<org>/orun-cloud/integrations/<name>/<env>  # per-provider config + secret(s)
<org>/orun-cloud/platform-secrets/<env>     # SECRET_ENCRYPTION_KEY, OAUTH_STATE_SECRET, …
```

Operational consequences:

- **No committed resource IDs.** Worker bindings (Hyperdrive, KV, service
  bindings) are resolved from the wiring manifest at deploy time, so a fresh
  account needs no hand-pasted IDs and nothing drifts in git.
- **Cloudflare worker secrets are deploy-time copies only** — write-only
  projections pushed by the secrets-sync tooling
  (`tooling/secrets-sync/`), never read back, never the source of truth.
  Workers do not call Secrets Manager at request time.
- CI reaches AWS via **GitHub-OIDC-assumed roles** per environment; no
  long-lived AWS credentials exist in Actions.
- Config keys are non-secret and may appear in plan output; secret values must
  never be committed, echoed in logs, or copied into reports.

## The admin/support plane

`admin-worker` owns audited support workflows. It is **internal-only**: it has
no `api-edge` facade and is never publicly routable — callers reach it over
service bindings only.

- Routes live under `/v1/internal/support/…`: record a support action, list a
  workspace's support actions, read-only diagnostic lookups for a workspace or
  user, and aggregated **entitlement-decision observability** per workspace
  (why an entitlement check allowed or denied, in aggregate).
- Authorization is **deny-by-default**: a request is permitted only with a
  recognized support-role claim (`x-support-role: support_agent |
  support_admin`) or an explicit **break-glass** override
  (`x-system-override: true`, honored only for a `system`-type actor and
  separately audited). Anything else — no role, an unrecognized role — is
  denied. There is no implicit grant.
- Every support action is recorded with actor, target workspace, and request
  id, so customer-affecting interventions are reconstructable from the audit
  trail.

:::warning
Never expose `admin-worker` through a public route or the edge. Its
authorization model assumes the caller is a trusted internal service that has
already authenticated the human.
:::

## Observability

- **Health** — every worker serves an unauthenticated `GET /health`. The edge's
  returns `{ status, service, environment, checks }`, probing the database
  through Hyperdrive and the presence of its identity/membership bindings; a
  configured-but-unreachable database reports `degraded` with HTTP 503. Point
  your uptime checks at it.
- **`Server-Timing`** — the edge appends its own phases (idempotency lookup,
  rate-limit check) to the downstream worker's `Server-Timing` header, so
  per-request latency can be attributed edge-vs-worker straight from response
  headers.
- **Request ids** — every response carries a `req_…` request id (in
  `meta.requestId` / the error envelope) that is propagated to every internal
  hop as `x-request-id`; the CLI and SDK surface it on errors for support
  correlation.
- **Rate-limit headers** — `X-RateLimit-{Limit,Remaining,Reset}-{org,identity}`
  on API responses give tenants (and you) live throttle visibility; see
  [Rate limits](/api/rate-limits).
- **Entitlement decisions** — the admin plane's per-workspace decision
  aggregation (above) is the tool for "why is this tenant blocked" questions.
- The [audit log](/platform/audit/audit-log) is the tenant-visible record of
  every meaningful mutation.

## State and backups

- **Terraform state** lives in the shared S3 buckets (`sourceplane-<env>` in
  the baseline) under `env/<environment>/<repo>/<component>/terraform.tfstate`,
  with encryption and state locking enabled. The buckets and IAM are owned by
  the org's infrastructure repo, not this one.
- **Postgres** — `stage` and `prod` are separate Supabase projects (separate
  databases, never branches of one project), so an incident in stage cannot
  touch production data. Database backup schedules are managed on the Supabase
  side and are not configured from this repo.
- **State-plane objects** in R2 are content-addressed, which makes writes
  idempotent and re-uploads safe; see
  [State plane](/platform/state-plane/overview).

## Related

- [Run your own](/self-hosting/deploy-your-own)
- [Architecture](/self-hosting/architecture)
- [Security model](/security/security-model)
- [Audit log](/platform/audit/audit-log)
