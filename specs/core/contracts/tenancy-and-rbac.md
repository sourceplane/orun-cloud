# Tenancy And RBAC Contract

Status: Normative

## Core Principle

Every meaningful entity belongs to an organization. Authorization starts with tenant scope, then applies role, policy, billing entitlement, and domain-invariant checks.

Organization is the tenant and billing boundary. Project is the operational boundary. Project-scoped authorization must always include both `orgId` and `projectId`.

## Canonical Actors

- `user`: an interactive human account
- `service_principal`: a non-human actor used by automation, CLI tokens, or integrations
- `workflow`: a runtime-owned actor executing orchestrated steps
- `system`: reserved for platform-internal maintenance actions

## Canonical Scope Objects

- `organization`
- `project`
- `environment`
- `resource`

Project, environment, and resource scope always nest under an organization.

## Minimum Roles

### Organization roles

- `owner`
- `admin`
- `builder` (product label: Developer)
- `viewer`
- `billing_admin`

### Project roles

- `project_admin`
- `project_builder`
- `project_viewer`

Environment- and resource-specific rules may narrow access further, but may not widen access beyond the enclosing organization role.

## Role Semantics

- `owner`: full control, including billing, destructive actions, and role management
- `admin`: manage org settings, members, invitations, projects, environments, webhooks, integrations, and operational resources
- `builder`: create and mutate projects, environments, configs, API keys, webhooks, and operational resources. Product UI may label this role Developer.
- `viewer`: read-only access to allowed scopes
- `billing_admin`: billing and plan management without general operational admin rights

## Authorization Contract

The policy service evaluates a request shaped like this:

```json
{
  "subject": {
    "type": "user",
    "id": "usr_123"
  },
  "action": "resource.create",
  "resource": {
    "kind": "project",
    "id": "prj_123",
    "orgId": "org_123",
    "environmentId": null
  },
  "context": {
    "memberships": [
      {
        "kind": "role_assignment",
        "role": "admin",
        "scope": {
          "kind": "organization",
          "orgId": "org_123"
        }
      }
    ],
    "attributes": {}
  }
}
```

And returns:

```json
{
  "allow": true,
  "reason": "org_admin",
  "policyVersion": 1,
  "derivedScope": {
    "orgId": "org_123",
    "projectId": "prj_123"
  }
}
```

### Membership Facts Consumed By Policy

`context.memberships` remains additive and may contain future fact shapes, but V1 policy must understand this shared role-assignment fact:

```json
{
  "kind": "role_assignment",
  "role": "project_builder",
  "scope": {
    "kind": "project",
    "orgId": "org_123",
    "projectId": "prj_123"
  }
}
```

Rules:

- the fact is already scoped to the request subject; policy does not need a separate subject ID inside the fact
- organization roles may be asserted at organization or narrower nested scopes, but never across organizations
- project roles may be asserted only for project, environment, or resource scopes within the same project
- unknown future fact objects may be present and must not widen access unless policy explicitly understands them

## Required Rules

- Authorization is deny-by-default.
- Every mutating route requires an explicit acting subject.
- API keys and service principals must be bound to an organization and a role set.
- Project-scoped API keys and service principals must also carry project scope and may not operate outside that organization/project pair.
- Billing-sensitive and quota-sensitive operations must allow policy to consume entitlement or quota facts.
- Cross-organization access is forbidden unless a future super-admin model is explicitly introduced.
- Destructive actions require elevated roles and full audit logging.
- Support/admin actions require an explicit support actor, reason, target organization, and audit event.

## Responsibility Split

- Identity owns user, session, and API-key facts.
- Membership owns organizations, invites, and role assignments.
- Policy owns authorization decisions and policy evaluation.
- Domain services may perform local invariant checks, but they must not invent parallel authorization systems.

## Audit Requirements

Every authorization-protected mutation must capture:

- subject ID and type,
- resolved organization,
- resolved role or policy reason,
- request ID,
- resource target.

At minimum, audit events are required for login, organization creation and deletion, member invitation, member removal, role change, project creation, project archival, API-key creation and revocation, webhook creation and deletion, billing updates, security-setting changes, and support/admin actions.

## V1 Policy Scope

V1 may implement policy as code-backed RBAC plus a small attribute layer. It does not need a user-facing policy language yet. The contract above is the stable seam; the implementation behind it may evolve later.
