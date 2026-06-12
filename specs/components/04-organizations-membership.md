# Organizations And Membership

Status: Shipped — live on main (trust code over this doc). Owning work epic: see specs/epics/ + specs/roadmap.md.

Primary monorepo targets:

- `apps/membership-worker`

Primary dependencies:

- `specs/core/contracts/api-guidelines.md`
- `specs/core/contracts/event-envelope.schema.yaml`
- `specs/core/contracts/tenancy-and-rbac.md`
- `specs/components/02-identity.md`
- `specs/components/03-policy-authorization.md`

Platform dependencies:

- Workers
- Hyperdrive binding to primary Supabase Postgres
- Supabase Postgres for membership-owned relational state
- Queues optional for invite email dispatch

## Intent

Own the SaaS tenant boundary: organizations, memberships, invitations, and role assignments. Organization is also the billing, audit, and ownership boundary consumed by billing, metering, audit, webhooks, notifications, and support workflows.

## Scope

- create and update organizations
- organization settings
- list organizations for an actor
- membership creation, update, and removal
- invitation lifecycle
- organization switching metadata

## Out Of Scope

- sign-in and session management
- project and environment lifecycle
- billing plan logic

## Hard Contracts To Honor

- Organization-scoped tenancy model in `specs/core/contracts/tenancy-and-rbac.md`
- Event envelope in `specs/core/contracts/event-envelope.schema.yaml`

## Required Capabilities

### Public/Internal Methods

- `createOrganization`
- `getOrganization`
- `listOrganizationsForSubject`
- `updateOrganizationSettings`
- `inviteMember`
- `acceptInvite`
- `revokeInvite`
- `listMembers`
- `updateMemberRole`
- `removeMember`

### Events

- `organization.created`
- `organization.updated`
- `membership.added`
- `membership.updated`
- `membership.removed`
- `invite.created`
- `invite.accepted`
- `invite.revoked`

## Data Ownership

This component owns:

- organizations
- memberships
- invitations
- role assignments (including service-principal role bindings used by API-key
  administration; identity owns the service principal and API key credentials,
  but membership owns the role assignment that grants the service principal
  access within an organization or project)
- organization-level settings

## Agent Freedom

- The agent may choose slug-based or ID-based org addressing externally as long as the API contract is consistent.
- Invite delivery may start as an internal queue event with a stub mailer adapter.
- Org settings beyond the basics may be deferred if the core tenant flows work.

## Acceptance Criteria

- A new signed-in user can create an organization.
- The creator becomes an owner and the organization is usable as a billing/customer boundary.
- Additional users can be invited and assigned roles.
- Invitations can be accepted, revoked, and audited.
- Membership changes become visible to policy evaluation through the published contract.
- Organization data can be extracted later without rewriting identity.

## Extraction Seam

Identity may know who the user is, but only membership knows which organizations and roles the actor has. That seam must stay intact.
