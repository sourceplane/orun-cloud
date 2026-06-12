# saas-integrations — Risks & Open Questions

Status: Draft. D1–D4 are human-gated product/credential decisions (the epic's
equivalent of the Polar-credentials gate); R1–R7 are engineering risks owned by
the milestones.

## Human-gated decisions

### D1 — GitHub App registration per environment (blocks IG1+ live paths)

One GitHub App per environment (dev/stage/prod), owned by the operating GitHub
org. Needed from the operator: App name/slug per env, generated private key,
webhook secret, client id/secret, callback + setup + webhook URLs pointed at
that env's edge. Until provided: IG0 fully, and IG2's worker logic against
recorded fixtures, proceed; live connect/inbound parks. **Default
recommendation:** register `sourceplane-dev|stage|prod` Apps under the
`sourceplane` GitHub org; store secrets via `wrangler secret put` now, BF
instance parameters at IG7.

### D2 — The App's permission set (blocks IG1 registration form)

The permission grant is visible to every installing customer and hard to widen
later (re-approval friction on every installation). **Default recommendation
(medium-coverage, read-mostly):**

| Permission | Level | Why |
|------------|-------|-----|
| metadata | read | baseline (forced) |
| contents | read | repo browse, file reads for products |
| pull_requests | read | PR events + facts |
| checks | **write** | products posting check runs is the #1 act-on-GitHub case |
| statuses | **write** | commit statuses (legacy CI surface) |
| deployments | **write** | deploy status round-trip (Vercel parity) |
| webhooks events | push, pull_request, check_run, release, create, delete, installation* | the `scm.*` taxonomy |

Anything wider (issues, discussions, actions) waits for a product pull.

### D3 — Token broker exposure (IG4 posture)

Is the broker available to **user-session actors** or only **service
principals**? Brokered tokens are powerful (real GitHub writes). **Default
recommendation:** service principals + owner/admin users, behind its own policy
action (`organization.integration.token.issue`), so a product can lock token
issuance to its backend identity only.

### D4 — Plan placement (blocks IG1 gate wiring)

Which tiers include `feature.integrations.github`, and what is
`limit.repo_links` per tier? **Default recommendation:** available on Free with
`limit.repo_links = 1` (activation-friendly, Vercel-style), Pro 10,
Business/Enterprise unlimited — final numbers belong to the same catalog
decision lane as the multi-org-billing tiers.

## Engineering risks

### R1 — Tenancy mis-binding (severity: critical; owner IG1)

If `installation_id ↔ org_id` can be forged or raced, one tenant sees another's
repo events. Mitigations are structural (design §4): signed single-use state
with persisted nonce, short TTL, fail-closed orphan handling, no auto-claim.
Test plan must include: replayed state, expired state, state minted for org A
redeemed while signed into org B, unsolicited install.

### R2 — The unauthenticated edge ingress (severity: high; owner IG2)

A new public, bearer-less surface is a new attack surface. Mitigations: HMAC
verify before parse on raw bytes, constant-time compare, body cap, per-source
rate limit, allowlist routing (two paths only), no tenant lookup before
signature pass, 401 without detail. The ingress rules land as a normative
addition to `components/01-edge-api.md`, not folklore.

### R3 — Duplicate or lost inbound deliveries (severity: high; owner IG2)

GitHub redelivers; crons crash. The inbox row keyed by `X-GitHub-Delivery` is
the idempotency ledger; emission is transactional with the `emitted` mark
(exactly-once into event_log by construction); cron retry is bounded with
terminal `failed` + replay. Residual risk: GitHub-side delivery gaps — IG6's
reconcile narrows the blast radius for *lifecycle* events (state converges from
GitHub truth), and `scm.*` gaps are visible in the delivery log.

### R4 — Private-key custody (severity: high; owner IG1)

The App private key signs for **every tenant**. It lives only as a worker
secret (never DB, never repo, never logs); brokered/cached tokens are the only
derived artifacts and are encrypted (cache) or unlogged + short-TTL (brokered).
Rotation runbook (GitHub supports two active keys) documented in IG6.
`run_secret_scanning` on every PR in this epic.

### R5 — Inbound burst overruns the minute-cron (severity: medium; owner IG6)

A monorepo push storm or 3k-repo installation can outpace the drain. The
accepted posture (matches platform-wide no-Queues stance): inbox absorbs the
burst durably; drain batches are tunable; if latency becomes buyer-visible, the
additive hardening is a queue **wake-up signal** with the inbox row still
authoritative and cron as backstop — never a bare producer→queue path (that
reintroduces dual-write loss).

### R6 — GitHub API rate limits (severity: medium; owner IG3/IG6)

Installation-token calls share the installation's rate budget with the tenant's
own brokered usage. Mitigations: cache platform-side reads (repo lists),
conditional requests, per-connection backoff on 403-rate-limit, and surfacing
remaining-quota in connection health. Per-installation coordination (Durable
Object token bucket) is named as the escalation path, not built up front.

### R7 — Normalized-event contract churn (severity: medium; owner IG0/IG2)

Products build on `scm.*` shapes; breaking them breaks tenants. The projections
are versioned in `packages/contracts` from IG0, additive-only by rule, and the
raw payload is retained in the inbox so a richer projection can always be
re-derived (replay) rather than re-fetched.

## Explicitly deferred

- Second live provider (GitLab/Bitbucket) — IG7 proves the seam dormant; a live
  adapter waits for demand.
- Check-run/deployment **proxy** endpoints (IG4 stretch) — broker first.
- Parent→child connection inheritance under multi-org — explicit per-org
  install until a customer asks.
- GitHub Enterprise Server (on-prem) endpoints — the adapter keeps base URLs
  configurable, but GHES is untested until pulled.
