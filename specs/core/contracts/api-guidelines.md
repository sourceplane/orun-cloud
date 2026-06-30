# API Guidelines

Status: Normative

## Scope

This document defines the public HTTP contract style and the internal service-boundary rules that every component must follow.

## Public API Shape

### Versioning

- Public routes are prefixed with `/v1`.
- Breaking changes require a new version prefix or a documented compatibility shim.

### Path conventions

- Use nouns for resources and sub-resources.
- Tenant-scoped APIs MUST include the organization in the path unless the route is explicitly pre-organization bootstrap such as login.
- Project-scoped APIs MUST include both `orgId` and `projectId`.
- Prefer nested scope for starter modules:
  - `/v1/organizations/{orgId}/projects`
  - `/v1/organizations/{orgId}/projects/{projectId}`
  - `/v1/organizations/{orgId}/projects/{projectId}/environments`
  - `/v1/organizations/{orgId}/api-keys`
  - `/v1/organizations/{orgId}/projects/{projectId}/webhooks`
  - `/v1/organizations/{orgId}/billing`
  - `/v1/organizations/{orgId}/audit`
- Optional resource-extension routes follow the same tenant and project scope:
  - `/v1/organizations/{orgId}/projects/{projectId}/environments/{environmentId}/resources/{resourceId}`
- Avoid verb-heavy routes unless the action is truly non-CRUD:
  - acceptable: `/v1/organizations/{orgId}/projects/{projectId}/deployments/{deploymentId}/cancel`

### Public vocabulary: Account / Workspace (aliases)

The public surface speaks **Account** (the tenant/parent) and **Workspace** (any
organization in the account). These are a *vocabulary layer* over the unchanged
`organizations` model — see [`../vocabulary.md`](../vocabulary.md). Concretely:

- **Route alias.** `/v1/workspaces/{workspaceId}/…` is a 1:1 alias of
  `/v1/organizations/{orgId}/…`, served by the same handlers with identical
  results. `{workspaceId}` is the **same opaque `org_*` id** as `{orgId}`.
- **Field alias.** Responses on the `/v1/workspaces/*` surface include
  `workspaceId` alongside `orgId` (same value). Request bodies accept either
  spelling; the server normalizes to `orgId`, preferring `workspaceId` when both
  are present.
- **`orgId` is the durable id.** It is never removed; `workspaceId` is the
  additive alias. New clients SHOULD prefer the Workspace spelling.
- **Internal stays `org`.** Service-to-service routes, DB columns, policy scope
  (`scope.orgId`), and the audit/event taxonomy keep `org`/`org_id`. The alias is
  a public-surface projection only.

### Durable Workspace ID & role discovery (saas-workspace-id WID)

WID adds a durable public Workspace ID **additively** (decision W2 = Option B): it
does **not** change the value of `workspaceId`/`id`. Both coexist with the D2/D4
statements above.

- **`workspaceRef` is the durable, led-with public Workspace ID** — `ws_…`
  (Crockford base32, e.g. `ws_3KF9TQ2P`; WID2's `public_ref`). It is **immutable**
  (minted once at creation, never reissued), so it is the id to quote to support,
  paste in the CLI, and commit in `intent.yaml` — unlike the **mutable** `slug`.
  New clients SHOULD lead with `workspaceRef`.
- **`workspaceId` / `org_<hex>` are the retained legacy ids.** They keep the
  **same value** as before (W2 Option B is purely additive; nothing is repointed)
  and are returned/accepted **forever** (extends D4). `id` on the org/workspace
  resource stays `org_<hex>`.
- **`accountId`** — the owning Account's `ws_…` id, the AWS-account-id analog every
  Workspace carries (= `effectiveBillingOrgId` = `parentOrgId ?? id`, surfaced as a
  field). For a child it is the parent (account) org's `workspaceRef`; for an
  Account root it equals the org's own `workspaceRef`.
- **`kind`** (`"account"` | `"workspace"`) and **`isAccountRoot`** — derived
  role-discovery fields. `isAccountRoot` is true when `parentOrgId` is null;
  `kind` is `account` for a parent/standalone org, else `workspace`. (A parent is
  *both* per the model; the DTO reports the root as `account`.)
- **Account-root invariant.** `accountId === workspaceRef` ⟺ the org is an Account
  root. This answers "is this an account?" everywhere **without parsing any id**.
- **Never branch on a parsed id prefix.** Role/authority comes from the resolved
  record (`kind`/`accountId`), never from the id string (WID4, W1d).

### Deprecation & coexistence policy (saas-workspaces WS5)

- **`/v1/organizations/*` and the `orgId` field coexist indefinitely** with the
  Workspace surface (decision D4). There is **no removal date**; removing the
  legacy surface would be a breaking change and requires a separate, announced
  migration with customer notice.
- **The audit/analytics event taxonomy stays `org.*`** internally and on the wire
  (decision D3). Event names are a stable contract and are **not** forked to
  `workspace.*`; the Account/Workspace mapping is documented, not duplicated in
  the taxonomy.

### Request and response encoding

- JSON is the default wire format.
- Success envelope:

```json
{
  "data": {},
  "meta": {
    "requestId": "req_123",
    "cursor": null
  }
}
```

- Error envelope:

```json
{
  "error": {
    "code": "forbidden",
    "message": "You do not have access to this resource.",
    "details": {},
    "requestId": "req_123"
  }
}
```

### Pagination

- Use cursor pagination for list endpoints.
- Cursor names should be opaque to clients.

#### V1 List Pagination Parameters

- Query params: `limit` (integer) and `cursor` (string).
- Default limit: `50`.
- Maximum limit: `100`.
- Cursors are opaque and endpoint-owned; clients must not parse or construct them.
- Invalid `limit` (non-integer, less than 1, greater than 100) or malformed `cursor` returns error code `validation_failed`.
- The next cursor is returned in the response at `meta.cursor`; it is `null` when no further pages exist.
- No total count is required or guaranteed.

### Idempotency

- `POST` endpoints that create or trigger side effects must accept `Idempotency-Key`.
- The server must scope idempotency records by actor, route, organization, and project when a project is present.

### Traceability

- Every request gets a request ID.
- Forward `traceparent` when present.
- Async operations must preserve causation and correlation IDs in emitted events.

## Authentication And Context

- Public auth uses bearer tokens and/or secure session cookies.
- The public edge resolves the acting user or service principal before dispatching to internal services.
- Organization selection must be explicit in path, token claims, or request context. Silent tenant guessing is prohibited.
- Project selection must never be inferred from `projectId` alone; it must be resolved under the explicit organization scope.

## Internal Service Boundaries

### Service bindings

- Internal synchronous calls should use Cloudflare service bindings.
- Prefer RPC style for domain commands and queries.
- Do not expose raw persistence operations over service bindings.

### Internal command shape

Internal RPC methods should resemble domain operations:

- `createProject(input)`
- `listResources(scope)`
- `resolveSession(token)`
- `authorize(input)`

They should not resemble transport or database primitives:

- not `postProjects`
- not `insertProjectRow`
- not `runQuery`

## Error Code Set

All components must use the shared semantic error set:

- `bad_request`
- `unauthenticated`
- `forbidden`
- `not_found`
- `conflict`
- `rate_limited`
- `validation_failed`
- `precondition_failed`
- `unsupported`
- `internal_error`

## Route Ownership

The public edge owns:

- auth context resolution
- request normalization
- rate limiting
- request IDs
- response envelopes
- mapping domain errors to HTTP status codes

Domain Workers own:

- validation against domain contracts
- business rules
- persistence
- domain events

## Minimum Public Surface For V1

The public API must support:

- auth and session management
- organizations and memberships
- projects and environments
- account and security settings
- API keys and service principals
- config and secret management metadata
- notifications and delivery preferences
- outgoing webhooks and delivery status
- audit queries and security events
- usage summaries and quotas
- billing summaries, subscriptions, invoices, and entitlements
- admin/support workflows where enabled
- optional resources and component registry
- optional deployments and status
