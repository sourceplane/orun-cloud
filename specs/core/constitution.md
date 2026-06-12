# Sourceplane Constitution

Status: Normative

Applies to: every package, app, migration, API, event, UI surface, CLI command, and coding agent working in this monorepo.

## Purpose

Sourceplane is a reusable multi-tenant SaaS starter bootstrap. It must provide the durable foundation for products with organization-scoped tenancy, project separation, membership, billing, audit, metering, API access, notifications, webhooks, and support workflows. Product-specific resource orchestration may be layered on top, but it must not obscure the starter baseline or force every SaaS consumer into a runtime-orchestration product model.

## Constitutional Rules

### 1. Cloudflare-first runtime, extraction-safe data plane

- V1 must run compute, routing, async work, caches, and public ingress on Cloudflare-managed primitives wherever practical.
- Supabase Postgres is the primary relational data plane for product-owned state and must be reached from Workers through Hyperdrive.
- Cloudflare, Supabase, AWS secret, and Terraform backend resources must be provisioned through Orun-controlled CI, with Terraform ownership where specified.
- Internal boundaries must still assume that any component may later move behind an external service or its own repo.
- No domain may depend on a hosting-specific detail outside its adapter layer.

### 2. Contract-first development

- Shared contracts are defined before or alongside implementation.
- Public APIs, internal RPC surfaces, event envelopes, resource documents, and component manifests are versioned contracts.
- A component may change its internals freely, but it may not silently change a shared contract.
- Specs define durable behavior, constraints, and acceptance criteria. They must not prescribe internal implementation details unless required for security, portability, compatibility, or platform operation.

### 3. Organization-scoped multitenancy from day one

- The organization is the primary tenant boundary.
- Every persistent domain record must be traceable to an organization, directly or indirectly.
- User-only ownership models are prohibited except for pre-organization bootstrap records such as pending sign-up sessions.

### 4. Organization -> project separation is the product spine

- Organization is the billing, ownership, membership, and audit boundary.
- Project is the operational boundary.
- Environment is an optional project sub-scope for configuration, deployment, or lifecycle separation.
- Project data must never be queried, authorized, cached, audited, or metered by `projectId` alone; it must carry `orgId + projectId`.
- Resource-oriented models with `kind`, `spec`, and `status` are allowed for product extension modules, but they are not required for every starter domain.

### 5. API, CLI, and UI parity

- The public API is the primary interface.
- The CLI and web console must use the same public contracts.
- No feature may exist only in the UI if it can affect system state.

### 6. Events are first-class system behavior

- Every meaningful state mutation emits a domain event.
- Audit history, metering, notifications, and runtime automation must derive from events rather than bespoke side channels.
- Cloudflare-native event fanout may be implemented differently from Kafka-like systems, but the event contract must remain stable.

### 7. Business logic stays pure

- Domain logic belongs in domain modules, not transport handlers and not platform adapters.
- Workers, service bindings, Hyperdrive, Supabase Postgres, D1, KV, Queues, R2, AWS Secrets Manager, Workers Secrets Store, Workflows, and Durable Objects are implementation adapters, not business policy.
- Business rules must be testable without deploying to Cloudflare.

### 8. Secure by default

- Secrets are encrypted at rest and redacted in logs, audit messages, and error payloads.
- Authorization is deny-by-default.
- Every mutating request must be attributable to an actor, service principal, or workflow instance.

### 9. Observe and explain the system

- Every mutating request gets a request ID and trace context.
- Every mutation is auditable.
- Every asynchronous workflow exposes state transitions and failure reasons in a user-readable form.

### 10. Backward compatibility is deliberate

- `v1` contracts must remain backward compatible unless a documented breaking-change process is followed.
- Deprecations need an explicit migration note.
- Extraction of a component from the monorepo must not require client-visible contract changes.

### 11. Bounded contexts are real

- Identity, policy, membership, projects, resources, config, runtime, events, metering, and billing are separate concerns even if some are deployed together in early iterations.
- Cross-domain data access is forbidden outside published contracts.
- Shared code may exist only for contracts, testing utilities, and generic infrastructure helpers.

### 12. Starter modules are product primitives

- Identity, organizations, membership, projects, policy, audit, metering, billing, API keys, webhooks, notifications, settings, and support workflows are first-class starter modules.
- Optional component definitions for project resources must be portable and versioned when used.
- If a module exposes manifest-driven resources, its manifests must be sufficient to drive validation, API handling, CLI flows, and UI form generation.
- Runtime orchestration is an optional product extension and must consume published contracts rather than hardcoding per-component behavior.

## Definition Of Done

Work is not complete unless all of the following are true:

- It respects this constitution.
- It references or updates the relevant shared contract.
- It includes tests at the correct layer.
- It emits the required domain events and audit records for mutations.
- It preserves extraction seams.
- It documents any new operational dependency.
- It does not require manual Cloudflare, Supabase, AWS IAM, S3 backend, or secret-manager setup outside the accepted Orun/Terraform path.
- It lands as one reviewable PR for one accepted task.

## Change Control

If a coding agent or human implementer needs to violate the constitution, they must first update this document and the affected contract docs, then sequence downstream changes explicitly. Silent drift is not allowed.
