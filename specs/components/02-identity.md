# Identity

Status: Shipped — live on main (trust code over this doc). Owning work epic: see specs/epics/ + specs/roadmap.md.

Primary monorepo targets:

- `apps/identity-worker`
- optional domain package if the team prefers `packages/domain-identity`

Primary dependencies:

- `specs/core/contracts/api-guidelines.md`
- `specs/core/contracts/event-envelope.schema.yaml`
- `specs/core/contracts/tenancy-and-rbac.md`
- `specs/components/00-foundation-and-tooling.md`

Platform dependencies:

- Workers
- Hyperdrive binding to primary Supabase Postgres
- Supabase Postgres for identity-owned relational state
- KV for derived session cache if needed
- Secrets Store for signing and encryption keys

## Intent

Own all facts about who a user is and how an actor proves identity to the platform.

## Scope

- user records
- auth identities
- sign-in and sign-out flows
- session issuance and validation
- API keys and service-principal credentials
- account bootstrap and profile basics
- account security settings
- security events owned by identity, with org-scoped audit copies emitted
  through the events component only when organization context exists

## Out Of Scope

- organizations and memberships
- authorization decisions
- billing customer state

## Hard Contracts To Honor

- Actor shapes from `specs/core/contracts/tenancy-and-rbac.md`
- Public API envelope and auth transport rules from `specs/core/contracts/api-guidelines.md`

## Required Capabilities

### Public/Internal Methods

- `createUser`
- `getUser`
- `updateUserProfile`
- `startLogin`
- `completeLogin`
- `logout`
- `resolveSession`
- `listApiKeys`
- `createApiKey`
- `revokeApiKey`
- `listSecurityEvents`

### Minimum V1 Authentication Requirement

V1 must ship with at least one first-party sign-in path that is Sourceplane-owned and served through the Worker runtime, such as email magic link or one-time code. Additional OAuth providers may be added through adapters, but hosted auth SaaS, including Supabase Auth, is not the starter source of truth unless a future spec explicitly changes that boundary.

### Recommended Public Route Surface

#### Authentication routes (pre-organization, identity-owned)

- `POST /v1/auth/login/start`
- `POST /v1/auth/login/complete`
- `GET /v1/auth/session`
- `POST /v1/auth/logout`

`login/start` and `login/complete` are the only auth mutations that may pass through the public edge without a pre-resolved actor. They still use the standard success and error envelopes.

#### Self-scoped profile routes (identity-owned, user-session only)

- `GET /v1/auth/profile` — read the authenticated user's own profile
- `PATCH /v1/auth/profile` — update the authenticated user's own profile

These routes are self-scoped: the authenticated session determines the user.
Clients must not provide a `userId` path or body field. Only user-session
bearer tokens are accepted; API-key/service-principal actors are rejected.

**Profile read** returns the user's `id`, `email`, and `displayName`.

**Profile update** accepts a JSON body with `displayName` (string or null).
Empty strings are normalized to null. Maximum length: 120 characters.
Unsupported fields (e.g. `email`, `id`, `status`) are rejected with
`validation_failed`. Successful updates record a `user.profile.updated`
identity security event with safe metadata (changed field names only, no
old/new values).

Email address changes and account security settings mutations are deferred
to a future task.

#### API-key administration routes (tenant-scoped)

- `POST /v1/organizations/{orgId}/api-keys` — create
- `GET /v1/organizations/{orgId}/api-keys` — list
- `DELETE /v1/organizations/{orgId}/api-keys/{apiKeyId}` — revoke

These routes are tenant-scoped. The organization is always explicit in the path.
`/v1/auth/api-keys` is not a public admin surface and must not be used for
API-key management.

Project scope is an attribute of the backing service principal and its role
binding, not a required path segment for V1. A future V2 may introduce
`/v1/organizations/{orgId}/projects/{projectId}/api-keys` for project-scoped
key administration, but V1 uses org-level routes with optional project
narrowing through the request body.

### V1 API-Key Administration Contract

#### Bounded-Context Ownership

API-key administration spans three bounded contexts:

- **Identity** owns API keys, service principals, and identity security events.
  Identity persists the key hash, metadata, and the backing service principal.
- **Membership** owns service-principal role bindings (role assignments).
  When a key is created with a role and optional project scope, membership
  records the role assignment for the backing service principal.
- **Policy** owns authorization decisions. Create, list, and revoke require
  deny-by-default authorization. Only actors with `owner` or `admin`
  organization roles (or `project_admin` for project-scoped keys within their
  project) may perform API-key administration.

The runtime implementation orchestrates across these seams. Identity does not
own role assignments; membership does not own credentials.

#### Create (`POST /v1/organizations/{orgId}/api-keys`)

Creates a new API key and its backing service principal if one does not already
exist for the requested scope. Accepts `Idempotency-Key` per the shared
idempotency contract.

Request body (minimum):

- `label` (string, required): human-readable label
- `role` (string, required): organization or project role for the backing SP
- `projectId` (string, optional): narrows the key to a specific project within
  the organization; when provided, the role must be a valid project role
- `expiresAt` (ISO 8601 string, optional): key expiration; null means no expiry

The response returns the raw API key secret **exactly once**. The platform
persists only the key hash. Neither list nor any other endpoint returns the raw
secret after creation.

Response body (minimum):

- `id`: key ID (e.g. `key_...`)
- `secret`: the raw API key (returned only on create)
- `prefix`: non-secret prefix for identification (e.g. `spk_...`)
- `label`, `role`, `projectId`, `expiresAt`, `createdAt`
- `servicePrincipal`: `{ id, displayName }`

The create operation may provision the backing service principal and initial
membership binding as part of the workflow. This is an implementation detail;
callers interact only with the API-key surface.

#### List (`GET /v1/organizations/{orgId}/api-keys`)

Returns all API keys visible to the acting subject within the organization.
Uses cursor pagination per `specs/core/contracts/api-guidelines.md`.

**List never returns raw key material.** Each entry includes at minimum:

- `id`, `label`, `prefix`, `createdAt`, `expiresAt`, `lastUsedAt`, `revokedAt`
- `servicePrincipal`: `{ id, displayName, role, projectId }`

#### Revoke (`DELETE /v1/organizations/{orgId}/api-keys/{apiKeyId}`)

Marks the key as revoked. Revoked keys immediately stop authenticating.
Revocation is irreversible.

#### Security and Audit Expectations

- API-key create and revoke require an explicit acting subject and
  deny-by-default authorization.
- API-key create and revoke must emit identity-owned security events
  (`api_key.created`, `api_key.revoked`).
- When organization context exists (always true for these routes), create and
  revoke must also emit normal org-scoped audit/event copies using the shared
  event envelope from `specs/core/contracts/event-envelope.schema.yaml`.
- `POST` create must honor the idempotency guidance from
  `specs/core/contracts/api-guidelines.md`.

Example request body for `POST /v1/auth/login/start`:

```json
{
  "email": "user@example.com"
}
```

Example success envelope for `POST /v1/auth/login/start`:

```json
{
  "data": {
    "challengeId": "chl_123",
    "delivery": {
      "mode": "local_debug",
      "emailHint": "u***@example.com",
      "code": "123456"
    },
    "expiresAt": "2026-04-23T12:05:00.000Z"
  },
  "meta": {
    "cursor": null,
    "requestId": "req_123"
  }
}
```

Example success envelope for `POST /v1/auth/login/complete`:

```json
{
  "data": {
    "session": {
      "actor": {
        "id": "usr_123",
        "type": "user"
      },
      "expiresAt": "2026-04-30T12:00:00.000Z",
      "id": "ses_123",
      "organizationId": null,
      "token": "sps_ses_123.secret",
      "tokenType": "bearer"
    },
    "user": {
      "createdAt": "2026-04-23T12:00:00.000Z",
      "id": "usr_123",
      "primaryEmail": "user@example.com"
    }
  },
  "meta": {
    "cursor": null,
    "requestId": "req_123"
  }
}
```

Example success envelope for `GET /v1/organizations/{orgId}/api-keys`:

```json
{
  "data": {
    "apiKeys": [
      {
        "createdAt": "2026-04-23T12:00:00.000Z",
        "expiresAt": null,
        "id": "key_123",
        "label": "CI token",
        "lastUsedAt": null,
        "prefix": "spk_key_123",
        "revokedAt": null,
        "servicePrincipal": {
          "id": "spn_123",
          "displayName": "CI token",
          "role": "builder",
          "projectId": null
        }
      }
    ]
  },
  "meta": {
    "cursor": null,
    "requestId": "req_123"
  }
}
```

### Events

Identity owns security-event source facts for users, sessions, API keys, and
service principals. These records may be user-scoped and pre-organization, such
as login challenge creation, session creation, failed login attempts, or logout
before a user has selected or created an organization.

Pre-organization identity security history is not represented by an org-less
shared audit/event envelope. The shared event envelope remains org-scoped. When
organization context is available, identity must emit a normal org-scoped
event/audit copy through the events component using the existing envelope
contract.

This component must emit:

- `user.created`
- `session.created`
- `session.revoked`
- `api_key.created`
- `api_key.revoked`
- `identity.security_event_recorded`

## Data Ownership

This component owns records such as:

- users
- auth identities
- sessions
- verification tokens
- api keys
- service principals
- account security settings
- identity security-event source facts

## Agent Freedom

- The agent may choose opaque sessions, signed sessions, or a hybrid model.
- The agent may choose passwordless email, passkeys, or both for the initial first-party login method.
- The agent must persist identity state in Supabase Postgres through a repository layer. SQL, Hyperdrive connectivity, and transaction details belong inside the persistence adapter.

## Acceptance Criteria

- The edge Worker can resolve a session or API key to an acting subject.
- Sessions and keys can be revoked and stop working predictably.
- Secrets used for token signing or encryption are not stored in source control or plaintext tables.
- Identity behavior is independently testable without membership or billing logic.

## Extraction Seam

All consumers must rely on the identity contract, never on identity tables. This allows the identity system to move to a dedicated repo or external runtime later.
