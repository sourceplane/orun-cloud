# Policy And Authorization

Status: Shipped — live on main (trust code over this doc). Owning work epic: see specs/epics/ + specs/roadmap.md.

Primary monorepo targets:

- `apps/policy-worker`
- optional `packages/policy-engine`

Primary dependencies:

- `specs/core/contracts/tenancy-and-rbac.md`
- `specs/core/contracts/event-envelope.schema.yaml`
- `specs/components/00-foundation-and-tooling.md`

Platform dependencies:

- Workers
- Hyperdrive binding to primary Supabase Postgres
- Supabase Postgres for policy overrides and versioned role maps if persistence is needed
- optional KV for compiled policy cache

## Intent

Provide a single authorization decision point that every protected starter domain operation can rely on.

## Scope

- authorization decision API
- role-to-action mapping
- optional scoped policy overrides
- effective-permission queries for UI and CLI usage
- entitlement and quota facts consumed as authorization inputs

## Out Of Scope

- user identity proof
- organization lifecycle
- resource persistence
- billing state ownership
- metering state ownership

## Hard Contracts To Honor

- The request and response shape in `specs/core/contracts/tenancy-and-rbac.md`
- Deny-by-default behavior required by the constitution

## Required Capabilities

### Internal RPC

- `authorize`
- `listEffectivePermissions`
- `validateRoleAssignment`

### Events

This component emits only configuration-change events, not per-request decision events:

- `policy.updated`
- `role_definition.updated`

### Decision Rules

- Role assignments come from membership data.
- Entitlement facts come from billing.
- Quota facts come from metering.
- Project and environment scope may narrow permissions.
- A domain service may add invariant checks, but may not bypass policy decisions.

## Data Ownership

This component may own:

- policy override definitions
- versioned role maps
- cached compiled policy artifacts

Role assignments themselves remain owned by membership.

## Agent Freedom

- V1 may be implemented as policy-as-code with a Worker wrapper.
- A small rule engine is acceptable; a full user-authored policy DSL is not required.
- The agent may co-locate the policy engine in a package and expose it through the Worker as long as the Worker contract exists.

## Acceptance Criteria

- Authorization decisions are deterministic and testable through a matrix of subject, action, scope, and role.
- All deny paths are explainable through a stable reason code or message.
- No domain service needs to know how role mappings are computed internally.

## Extraction Seam

The stable seam is the `authorize` contract. Policy internals may move to a separate service or a stronger engine later without changing callers.
