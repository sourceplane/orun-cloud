---
title: Security model
description: How Orun Cloud isolates tenants, authenticates and authorizes every request, audits every mutation, and handles secrets — by construction, not convention.
---

Orun Cloud is secure by default: tenancy is structural, authorization is deny-by-default, every mutation is attributable and audited, and secrets are encrypted at rest and revealed at most once. This page describes the model end to end and where each guarantee is enforced.

## Tenancy isolation

The **workspace** (canonically an *organization*, `org_…`) is the tenant boundary, and it lives **in the URL path** — `/v1/organizations/{orgId}/…` — never in a header the client could quietly vary:

- Every persistent domain record is traceable to a workspace. Project-scoped data is never queried, authorized, cached, audited, or metered by `projectId` alone — it always carries `orgId + projectId`, down to composite foreign keys in the schema.
- Rate limiting, idempotency replay, and event fanout are all keyed on the path-derived workspace, so cross-tenant interference is impossible at those layers too.
- Authorization failures return `404 not_found`, not `403` — resources you cannot access are indistinguishable from resources that do not exist (resource hiding), so probing for other tenants' ids yields nothing.

Accounts (parent organizations) extend the same spine upward: account roles cascade to child workspaces through the same policy evaluation, never through a side channel.

## Authentication surfaces

Every request authenticates with `Authorization: Bearer <token>`. Four credential types, one resolution seam at the edge:

| Surface | Credential | Notes |
| --- | --- | --- |
| Console / browser | Session token (`sps_ses_<id>.<secret>`) | See [Authentication](/platform/identity/authentication) |
| Automation | Workspace API key (service principal) | Scoped to one workspace; see [API keys](/platform/identity/api-keys) |
| CLI | Device / browser-loopback flow | ~15 min access JWT + rotating single-use refresh token — **reuse of a refresh token revokes the whole family** |
| CI | GitHub Actions OIDC exchange | Mints a short-lived workflow token bound to one `(workspace, project)`; see [CLI & CI auth](/platform/identity/cli-and-ci-auth) |

Every mutating request is attributable to a user, service principal, or workflow actor — anonymous writes do not exist.

## Authorization

Authorization is a **deny-by-default policy engine** behind a **single enforcement seam**. Domain workers do not hand-roll checks: each handler resolves the actor's memberships and asks the policy service to evaluate an action string (`project.create`, `organization.webhook.write`, `state.run.write`, `organization.integration.token.issue`, …) against the resource's workspace/project scope. No grant, no access — there are no implicit allows and no privileged shortcuts.

Decisions carry **provenance**: an allow records *how* it was granted (`via` — direct role, team grant, account-role cascade), so an access decision is always explainable after the fact. Roles are documented in [RBAC](/platform/access-control/rbac).

## Auditability

- Every meaningful state mutation emits a domain event onto an **immutable, append-only log**; audit history, metering, notifications, and webhooks all derive from that log rather than bespoke side channels.
- Every mutating request carries a request id, and audit entries record actor, tenant, subject, and trace context — queryable via the [audit log](/platform/audit/audit-log) (`audit.read`).
- **Support actions are recorded**, including denials (`support.action_recorded`, `support.access_denied`). Support access itself is deny-by-default: it requires a recognized support-role claim, and anything unrecognized fails closed.
- The **break-glass** path is header-gated, restricted to `system`-type actors, available only on the internal admin surface (never the public API), and separately audited. There is no unaudited way in.

## Edge protections

The single public entry point (`api-edge`, serving `https://api.orun.dev`) applies cross-cutting protections before any domain worker runs:

**Rate limiting.** Token buckets per 60 s window in two scopes per request — the workspace from the path and the caller identity (a fingerprint of the bearer token, or IP for anonymous routes). Auth routes are deliberately tight (10/identity · 60/org per minute) because login flows are the brute-force target; most families allow 60/300, audit reads 120/600. Responses carry `X-RateLimit-{Limit,Remaining,Reset}-{org,identity}`; a `429 rate_limited` includes `Retry-After`. If the limiter's storage backend is unavailable, requests are **admitted without rate-limit headers** — availability is preferred over throttling for this control, and the failure is logged.

**Idempotency replay isolation.** Replay of a caller-supplied `Idempotency-Key` (24 h window) is stored under a key that embeds the path-derived workspace and the canonicalized route — one tenant reusing another tenant's key can never receive their stored response. A malformed key is rejected `400 validation_failed` *before any work executes*; a replay-store outage degrades to "execute once, no replay" rather than failing the request.

**Strict persisted-header allow-list.** Replayed responses reconstruct only headers on a hard allow-list — `content-type`, `content-language`, `cache-control`, `etag`, `x-request-id`, `x-saas-replay-source`. Principal-bearing headers such as `set-cookie` and `authorization` are **never persisted**, so the replay store cannot leak a session even if a downstream worker set one on the original response.

## Webhook signing — both directions

**Outbound**, every delivery Orun Cloud sends you is HMAC-SHA256 signed over `"{timestamp}.{body}"` with a per-endpoint secret, with a bounded timestamp tolerance and a dual-signature grace window during rotation — see [Verify deliveries](/platform/webhooks/verifying-deliveries).

**Inbound**, provider webhooks (GitHub's `x-hub-signature-256`) are verified **in the owning service** — the integrations worker — over the raw bytes with a constant-time compare, before any parsing or tenant attribution. Provider webhook secrets and App credentials live only in that worker's runtime configuration; the edge never holds them, and raw provider payloads never cross the public API.

## Secrets handling

- Tenant secret material (webhook signing secrets, integration state) is **envelope-encrypted at rest** with a runtime encryption key; plaintext is returned at most **once**, at generation or rotation, and never appears in logs, events, audit rows, or any later read.
- Secret APIs are **metadata-first**: list/read surfaces return key, version, scope, and rotation timestamps — never values.
- **Deployment credentials live in cloud secret managers**, not the repo: provider credentials, database passwords, and worker runtime secrets are escrowed in AWS Secrets Manager (namespaced per component and environment) and projected to Cloudflare worker secrets at deploy time as write-only copies — never read back, never the source of truth. Workers do not call the secret manager at request time.
- Nothing sensitive is committed: no secret values, and no environment-identifying resource ids outside Terraform state and non-secret outputs.

## Data plane

- **Supabase Postgres via Hyperdrive** is the source of truth for domain state. Workers reach it through Cloudflare Hyperdrive (pooled Postgres) behind repository adapters; `stage` and `prod` are **separate Supabase projects** with separate databases and credentials — no shared instances or branch tricks across environments.
- **Cloudflare R2** holds the state plane's content-addressed blobs (plans, catalog snapshots, artifacts), addressed and verified by `sha256:` digest; Postgres keeps only the index and coordination rows.
- All infrastructure is provisioned through Terraform under CI — driven by `orun plan` / `orun run`, never ad-hoc consoles — so the deployed surface matches the declared intent on every commit.

## Related

- [Authentication](/platform/identity/authentication)
- [RBAC](/platform/access-control/rbac)
- [Audit log](/platform/audit/audit-log)
- [Self-hosting architecture](/self-hosting/architecture)
