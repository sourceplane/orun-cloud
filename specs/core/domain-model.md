# SaaS Starter Domain Model

Status: Normative

## Core Entities

- `User`: interactive human account owned by identity.
- `Organization`: tenant, billing, membership, and audit boundary.
- `OrganizationMember`: membership fact connecting a user to an organization and role set.
- `OrganizationInvitation`: invitation lifecycle record.
- `Project`: operational workspace inside exactly one organization.
- `Environment`: optional project sub-scope for config, deployment, or lifecycle separation.
- `RoleAssignment`: authorization fact consumed by policy.
- `ApiKey`: credential owned by identity and backed by a service principal.
- `BillingCustomer`: organization-owned billing identity.
- `Subscription`: active, trialing, canceled, or past-due plan state.
- `Invoice`: mirrored provider invoice/payment state.
- `UsageEvent`: normalized metering event.
- `UsageRollup`: queryable usage summary by time bucket and scope.
- `IdentitySecurityEvent`: user-scoped identity security history owned by
  identity; may exist before organization context.
- `AuditEvent`: immutable security, membership, billing, and project mutation record.
- `WebhookEndpoint`: tenant-owned outgoing webhook destination.
- `NotificationPreference`: user or organization delivery preference.
- `SupportAction`: admin/support operation with required audit trail.

## Tenancy Rules

- A user may belong to many organizations.
- An organization may contain many projects.
- A project belongs to exactly one organization.
- An environment belongs to exactly one project and inherits its organization.
- API keys and service principals must be bound to an organization.
- Billing customer state belongs to an organization, not to a project in V1.
- Organization audit events must always include an organization. Project and
  environment IDs are included when applicable.
- Pre-organization identity security events are identity-owned user-scoped
  records, not org-less audit records. When organization context exists,
  identity emits a normal org-scoped audit/event copy using the shared event
  envelope.

## Project Isolation Invariant

Never query or authorize project data by `projectId` alone.

Every project-scoped query, mutation, route, cache key, event, and audit record MUST carry `orgId + projectId`. Environment-scoped records MUST carry `orgId + projectId + environmentId`.

This invariant applies even when project IDs are globally unique because it prevents accidental cross-tenant access and keeps API, CLI, UI, and audit behavior predictable.

## Minimum Tables Or Equivalent Stores

The V1 relational model must have owned storage for:

- users
- auth identities
- sessions or session indexes
- identity security events
- service principals
- api keys
- organizations
- organization members
- organization invitations
- role assignments
- projects
- environments
- audit events
- billing customers
- billing subscriptions
- billing invoices
- usage events or usage pointers
- usage rollups
- webhook endpoints
- webhook deliveries
- notifications
- notification preferences
- feature flags
- config versions
- secret metadata

Domain tables may live in a single Supabase project/database during V1, but each bounded context owns its schema or table namespace and migration history.

## Mutation Rules

Every meaningful mutation SHOULD emit:

- one domain event
- one audit event when user, security, membership, billing, project, API key, webhook, config, or support state changes
- one usage event when the mutation consumes billable or quota-tracked capacity

For identity activity before organization context exists, the identity component
records user-scoped security history first. It emits shared org-scoped audit
events only when the operation has organization context.

Domain events and source-of-truth state changes should commit atomically where possible. If they cannot, the component must document its outbox or recovery behavior.

## Starter Module Boundaries

- Identity owns users, sessions, API keys, and service principals.
- Membership owns organizations, members, invitations, and role assignments.
- Policy owns authorization decisions.
- Projects owns project and environment lifecycle.
- Config owns config, secret metadata, feature flags, and settings primitives.
- Events owns event fanout, audit query, and delivery bookkeeping.
- Metering owns usage ingestion, rollups, quota state, and usage summaries.
- Billing owns plans, subscriptions, invoices, entitlements, and provider adapters.
- Notifications owns delivery preferences and message dispatch.
- Webhooks owns outgoing webhook endpoints and delivery attempts.
- Admin/support owns audited support workflows.
- Resources/runtime are optional product extension modules, not prerequisites for the starter bootstrap.
