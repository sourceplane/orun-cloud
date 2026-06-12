# Notifications

Status: Shipped — live on main (trust code over this doc). Owning work epic: see specs/epics/ + specs/roadmap.md.

Primary monorepo targets:

- `apps/notifications-worker`

Primary dependencies:

- `specs/core/product-overview.md`
- `specs/core/contracts/event-envelope.schema.yaml`
- `specs/components/02-identity.md`
- `specs/components/04-organizations-membership.md`
- `specs/components/09-events-audit-observability.md`

Platform dependencies:

- Workers
- Queues for async delivery
- Hyperdrive binding to primary Supabase Postgres
- Supabase Postgres for notification preferences, templates, and delivery state
- Secrets Store for provider credentials

## Intent

Own notification preferences, notification templates, and delivery orchestration for product, billing, security, invitation, and support messages.

## Scope

- user notification preferences
- organization notification preferences
- notification templates and template version metadata
- email or message-provider adapter
- async delivery and retry tracking
- delivery suppression and unsubscribe state where applicable

## Out Of Scope

- identity proof or login challenge validation
- billing state ownership
- audit-log ownership
- generic marketing campaign tooling

## Hard Contracts To Honor

- Event envelope in `specs/core/contracts/event-envelope.schema.yaml`
- Tenant scope rules in `specs/core/contracts/tenancy-and-rbac.md`
- Audit coverage in `specs/components/09-events-audit-observability.md`

## Required Capabilities

### Public/Internal Methods

- `getNotificationPreferences`
- `updateNotificationPreferences`
- `sendNotification`
- `enqueueNotification`
- `getDeliveryStatus`
- `suppressRecipient`

### Events

- `notification.queued`
- `notification.sent`
- `notification.failed`
- `notification.preference_updated`
- `notification.suppressed`

### Delivery Rules

- Invitation, billing, security, and support notifications must be auditable through emitted events.
- Provider-specific IDs and payloads must stay behind the notification adapter.
- Secret values and one-time tokens must not be logged or exposed in delivery events.
- Retry behavior must be bounded and visible.

## Data Ownership

This component owns:

- notification preferences
- template metadata
- delivery attempts
- suppression state
- provider delivery references

## Agent Freedom

- V1 may start with email-only delivery and a local-debug provider.
- Templates may be static files or database-backed metadata if template versions remain traceable.
- Rich notification routing can be deferred until starter flows need it.

## Acceptance Criteria

- A user or organization can update notification preferences.
- Invitation, billing, and security flows can enqueue notifications without knowing provider internals.
- Failed deliveries are visible and retryable.
- Notification delivery emits audit-safe events.

## Extraction Seam

Other components request delivery through the notification contract. They must not import provider SDKs or write notification tables directly.
