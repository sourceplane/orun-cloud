# Admin And Support Console

Status: Shipped — live on main (trust code over this doc). Owning work epic: see specs/epics/ + specs/roadmap.md.

Primary monorepo targets:

- `apps/admin-worker`
- support-facing routes in `apps/web-console-next` when enabled

Primary dependencies:

- `specs/core/product-overview.md`
- `specs/core/contracts/tenancy-and-rbac.md`
- `specs/components/02-identity.md`
- `specs/components/04-organizations-membership.md`
- `specs/components/09-events-audit-observability.md`

Platform dependencies:

- Workers
- Hyperdrive binding to primary Supabase Postgres
- Supabase Postgres for support-action records and review state

## Intent

Provide audited internal support and administration workflows without introducing hidden backdoors into tenant data.

## Scope

- support actor identity and authorization checks
- organization and user lookup for support purposes
- support action records
- optional customer-support impersonation with explicit reason and audit trail
- tenant-safe read-only diagnostics
- support notes or review state where needed

## Out Of Scope

- silent production data mutation
- bypassing tenant authorization without audit
- general CRM functionality
- unrestricted SQL/admin database access

## Hard Contracts To Honor

- Deny-by-default policy in `specs/core/contracts/tenancy-and-rbac.md`
- Audit requirements in `specs/components/09-events-audit-observability.md`
- Secure-by-default rule in `specs/core/constitution.md`

## Required Capabilities

### Public/Internal Methods

- `authorizeSupportAction`
- `recordSupportAction`
- `lookupOrganizationForSupport`
- `lookupUserForSupport`
- `startImpersonation`
- `endImpersonation`
- `listSupportActions`

### Events

- `support.action_recorded`
- `support.impersonation_started`
- `support.impersonation_ended`
- `support.access_denied`

### Support Rules

- Every support action requires a support actor, target organization, reason, request ID, and timestamp.
- Impersonation, if enabled, must be visible in audit history and must never mint an ordinary user session.
- Support reads should prefer diagnostic projections over direct domain-table access.
- Mutating support actions require explicit policy overrides and should be rare.

## Data Ownership

This component owns:

- support action records
- support impersonation session metadata
- support review state
- support diagnostics metadata

## Agent Freedom

- V1 may start with read-only support diagnostics and no impersonation.
- Support UI may be hidden behind deployment configuration until operationally needed.
- Diagnostic projections may be narrow and expanded as support workflows become real.

## Acceptance Criteria

- Support access is denied unless the actor has a recognized support role or system override.
- Every support action creates an audit event.
- Impersonation, if present, is time-bounded and clearly attributable.
- Support workflows do not require direct database access by the web console.

## Extraction Seam

Support workflows sit behind their own contract. They may read domain projections or call domain services, but they must not become a privileged shortcut around policy and audit.
