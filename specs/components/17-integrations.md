# Integrations

Status: In progress — IG0 foundation landed dormant (schema, contracts, repo layer, worker skeleton; no live behavior). Owning work epic: specs/epics/saas-integrations/ + specs/roadmap.md.

Primary monorepo targets:
- `apps/integrations-worker`

Primary dependencies:
- `specs/core/domain-model.md`
- `specs/core/contracts/event-envelope.schema.yaml`
- `specs/components/01-edge-api.md` (ingress routes land here at IG1/IG2)
- `specs/components/04-organizations-membership.md`
- `specs/components/05-projects-environments.md`
- `specs/components/09-events-audit-observability.md`
- `specs/components/11-billing.md` (entitlement gating)
- `specs/components/15-webhooks-integrations.md` (outbound twin — consumed as-is)

## Intent

Own the inbound half of third-party integrations: provider connections
(GitHub App installations bound to organizations), the HMAC-verified inbound
webhook inbox, normalization of provider events into versioned `scm.*` events
on the canonical event log, project ↔ repository links with branch →
environment mapping, and the short-lived installation-token broker. The
control plane holds the only durable provider credentials; tenant products
never do.

## Scope

- provider connection lifecycle (connect, activate, suspend, revoke) behind a
  provider registry + adapter seam (GitHub first)
- the signed single-use connect state binding `installation_id ↔ org_id`
  (the tenancy keystone — fail closed, no auto-claim of unsolicited installs)
- inbound delivery ingest: durable inbox keyed by provider delivery id,
  cron drain, bounded retries, terminal failure + replay
- normalization and transactional emission of `scm.*` events into event_log
- repo ↔ project links with branch → environment maps
- scoped short-lived installation-token issuance (the token broker)
- delivery log queries (safe projection — raw payloads stay admin-only)

## Out Of Scope

- sign-in with GitHub (shipped — identity-worker owns user OAuth)
- outbound webhook delivery to customer endpoints (spec 15 owns it; this
  component only emits onto event_log)
- CI/CD, build, or deploy execution on SCM events (a product concern)
- repo content mirroring or search
- marketplace billing / rev-share
- long-lived provider tokens handed to tenants — never

## Hard Contracts To Honor

- `specs/core/contracts/event-envelope.schema.yaml` — every emitted event uses
  the standard envelope; `scm.*` payload projections are versioned and
  additive-only.
- Tenancy + RBAC: every read/write is org-scoped; policy actions are
  deny-by-default (`organization.integration.read|connect|manage`,
  `organization.integration.token.issue`, `project.repo_link.write`).
- Entitlement gating: `feature.integrations.github`, `limit.repo_links`
  via the billing entitlement seam; 412 + upgrade UX on deny.
- Audit coverage: connect, revoke, link, unlink, token issuance, suspension
  all emit through event_log.

## Required Capabilities

### Public/Internal Methods

- `connectIntegration` (returns provider install URL with signed state)
- `listIntegrations` / `getIntegration`
- `revokeIntegration`
- `ingestInboundDelivery` (internal; via edge ingress, HMAC-verified)
- `listInboundDeliveries` / `replayInboundDelivery`
- `createRepoLink` / `updateRepoLink` / `listRepoLinks` / `unlinkRepoLink`
- `issueInstallationToken` (the broker; reveal-once, TTL ≤ 1h)

### Events

- `integration.connected`
- `integration.suspended`
- `integration.reactivated`
- `integration.revoked`
- `integration.repo_selection_changed`
- `integration.token.issued`
- `scm.push`, `scm.pull_request.opened|updated|merged|closed`,
  `scm.check.completed`, `scm.release.published`,
  `scm.branch.created|deleted`, `scm.tag.created`,
  `scm.repo.linked`, `scm.repo.unlinked`

### Integration Rules

- The `installation_id ↔ org_id` binding is carried only by our signed,
  single-use, short-TTL state; unsolicited installations are recorded as
  orphaned and never auto-bound (fail closed).
- Inbound signature verification is HMAC over raw bytes, constant-time,
  before any parse; verification happens in this worker, which owns the
  secret — the edge forwards raw body + headers only.
- The inbox row keyed by the provider delivery id is the idempotency ledger;
  emission into event_log is transactional with the `emitted` mark
  (exactly-once by construction); replay re-runs normalize/emit from the
  persisted row and never re-trusts the wire.
- Platform credentials (App private key, webhook secret, client secrets) are
  per-environment worker secrets — never rows, never logs, never repo.
- Cached installation tokens serve only the platform's own calls and are
  stored as AES-256-GCM envelopes; brokered tenant tokens are always minted
  fresh, scoped down (repos ∩ links, permissions ⊆ App grant), never cached,
  never logged.

## Data Ownership

This component owns (schema `integrations`): provider connections, GitHub
installation facts, repo links (incl. branch → environment maps), the inbound
delivery inbox, and the installation-token cache.

## Agent Freedom

- V1 supports a single provider (GitHub App); the registry/adapter seam must
  exist from day one but a second live adapter waits for demand.
- The cron drain may use fixed batch sizes before adaptive tuning exists.
- The token broker may start without the convenience proxy endpoints
  (check-run/deployment-status posting) as long as the broker contract is
  explicit.
- Payload projections may start minimal as long as they are versioned and
  additive.

## Acceptance Criteria

- An org admin can connect a GitHub org and the connection activates with
  verified account facts; a second org cannot see or claim it.
- A push to a connected repo appears as `scm.push` in the org's audit log and
  fans out to customer webhook endpoints via the shipped spec-15 pipeline;
  provider redeliveries never double-emit.
- Uninstalling the App provider-side converges the connection to `revoked`.
- A service principal can mint a token scoped to a linked repo; requests for
  unlinked repos or un-granted permissions are denied with a safe error.
- Every mutation and token issuance is auditable; all gates fail closed.

## Extraction Seam

Products consume `scm.*` events through the existing outbound webhook surface
and act on the provider exclusively through the token broker — no component
or tenant product calls provider APIs with durable credentials. The provider
adapter interface (`IntegrationProvider`) is the pluggability seam; handlers,
repo layer, console, SDK, and contracts stay provider-generic.
