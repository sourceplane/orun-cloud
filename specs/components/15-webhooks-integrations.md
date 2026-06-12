# Webhooks And Integrations

Status: Shipped — live on main (trust code over this doc). Owning work epic: see specs/epics/ + specs/roadmap.md.

Primary monorepo targets:

- `apps/webhooks-worker`

Primary dependencies:

- `specs/core/product-overview.md`
- `specs/core/contracts/event-envelope.schema.yaml`
- `specs/components/04-organizations-membership.md`
- `specs/components/05-projects-environments.md`
- `specs/components/09-events-audit-observability.md`

Platform dependencies:

- Workers
- Queues for async deliveries
- Hyperdrive binding to primary Supabase Postgres
- Supabase Postgres for endpoints, subscriptions, delivery attempts, and signing metadata
- Secrets Store for signing keys

## Intent

Own outgoing webhooks and the starter integration surface so customers can subscribe external systems to organization and project events.

## Scope

- webhook endpoint CRUD
- event subscription configuration
- signing secret creation and rotation
- async delivery, retry, and disabling rules
- delivery status queries
- starter integration metadata

## Out Of Scope

- inbound third-party OAuth flows
- marketplace billing
- replacing the canonical event log
- arbitrary user-authored workflow execution

## Hard Contracts To Honor

- Event envelope in `specs/core/contracts/event-envelope.schema.yaml`
- Tenant and project isolation rules in `specs/core/domain-model.md`
- Audit coverage in `specs/components/09-events-audit-observability.md`

## Required Capabilities

### Public/Internal Methods

- `createWebhookEndpoint`
- `updateWebhookEndpoint`
- `deleteWebhookEndpoint`
- `listWebhookEndpoints`
- `rotateWebhookSecret`
- `enqueueWebhookDelivery`
- `getWebhookDelivery`
- `listWebhookDeliveries`

### Events

- `webhook.created`
- `webhook.updated`
- `webhook.deleted`
- `webhook.secret_rotated`
- `webhook.delivery_succeeded`
- `webhook.delivery_failed`
- `webhook.disabled`

### Webhook Rules

- Webhooks are organization-owned and may optionally narrow to project scope.
- Project-scoped webhook subscriptions must carry `orgId + projectId`.
- Webhook payloads must use published event contracts or documented event projections.
- Deliveries must be signed.
- Delivery retries must be bounded, observable, and idempotent.
- Repeated failure may disable an endpoint and must emit an auditable event.

## Data Ownership

This component owns:

- webhook endpoints
- webhook subscriptions
- signing secret metadata
- delivery attempts
- integration metadata for starter-supported integrations

## Agent Freedom

- V1 may support only outgoing webhooks and static integration metadata.
- The delivery worker may use a single queue before richer per-tenant fanout exists.
- Payload projection may start minimal as long as the contract is explicit and additive.

## Acceptance Criteria

- An organization admin can create, update, rotate, and delete a webhook endpoint.
- A project-scoped subscription cannot receive another project's events.
- Delivery attempts are queryable and include safe failure reasons.
- Endpoint mutations and auto-disabling are auditable.

## Extraction Seam

Producers publish events; the webhooks component owns endpoint selection and delivery. Domain components must not call customer webhook URLs directly.
