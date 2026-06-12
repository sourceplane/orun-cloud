# SaaS Starter Product Overview

Status: Normative

## Goal

Build Sourceplane as a reusable multi-tenant SaaS starter bootstrap. The starter must let a team launch a product surface with organizations, projects, membership, billing, auditability, usage, API access, notifications, webhooks, and an admin/support back office without redesigning the platform foundation.

## Product Shape

The canonical hierarchy is:

```text
User
  -> Organization
       -> Project
            -> Environment
                 -> Project-scoped resources, settings, keys, webhooks, and usage
```

- Organization is the tenant, ownership, membership, audit, and billing boundary.
- Project is the operational boundary where product work happens.
- Environment is an optional deployment/configuration boundary inside a project.
- Project-scoped resources are starter extension points. They must not be required for the basic SaaS bootstrap flows to work.

## Required Starter Capabilities

MUST ship as first-class starter modules:

- authentication and account settings
- organization creation and settings
- membership and invitations
- roles and permissions
- project creation and project settings
- environment management where the product needs environment separation
- billing customers, plans, subscriptions, invoices, and entitlements
- usage metering, quota checks, and usage summaries
- audit log and security-event history
- API keys and service principals
- outgoing webhooks
- notifications and delivery preferences
- admin/support console with audited support actions
- config, secrets, feature flags, and security settings

SHOULD support after the core bootstrap is stable:

- SSO/SAML
- SCIM
- project templates
- team-level or group permissions
- customer support impersonation with explicit audit trail
- quota enforcement before expensive actions
- integration marketplace primitives

MAY support later:

- per-project billing
- enterprise contracts
- usage-based overage billing
- product-specific runtime orchestration
- managed project resources driven by component manifests

## Non-Goals

V1 is not:

- a generic Kubernetes or infrastructure orchestration platform
- a replacement for GitHub Actions or other workflow engines
- a user-authored policy DSL
- a marketplace platform
- a full customer data warehouse
- a Supabase Auth wrapper unless a future spec explicitly changes identity ownership

## Platform Baseline

- Cloudflare is the V1 compute, ingress, async, cache, and hosting platform.
- Supabase Postgres is the primary relational database for product-owned state.
- Workers reach Supabase Postgres through Hyperdrive at repository-adapter boundaries.
- D1 may be used for tests, edge-local caches, or customer-managed resources, but not as the source of truth for starter domain state.
- Queues, Workflows, Durable Objects, R2, KV, Secrets Store, and Analytics Engine are implementation adapters behind domain contracts.

## UX Baseline

The web console must open directly into the usable SaaS application. A user should be able to:

- sign in (passwordless email magic link, or OAuth provider)
- land in a working scope on first login (a personal organization is auto-created; the user does not see a chooser screen as their first authenticated view)
- create an additional organization
- invite a member
- accept an invitation
- switch organizations
- create a project
- manage project settings and environments
- create or revoke API keys
- inspect audit history
- review usage and billing
- configure webhooks and notification preferences

The console is the buyer-facing artifact. It must look credible against the
Vercel / Linear / Stripe Dashboard bar. Design invariants are specified in
`specs/components/12-web-console.md` § Design Direction (URL-driven scope,
Cmd-K, designed empty/skeleton/upgrade states, dark-mode-by-default,
token-driven theming).

The CLI and SDK must expose the same public contracts for automation.

## Forward Direction

`specs/roadmap.md` captures the active architect-style roadmap in three
clusters: Baseline SaaS (B), UI / Design (U), and Product Areas (P). The
per-component specs under `specs/components/*.md` remain the contract; the
roadmap document is the sequencing and intent layer the Orchestrator reads
when choosing the next task.

## Agent Execution Model

Specs are written for human review and agent execution. Work is split into PR-sized task loops:

- orchestrator creates or updates the task and verification plan
- task agent implements only the scoped change in one PR
- verifier runs the stated checks
- failed verification produces a fix task, not new feature scope
- decisions and spec changes are recorded before downstream implementation depends on them

Every task should define intent, PR boundary, non-goals, affected areas, acceptance criteria, verification, and expected repo state.

A PR-sized task has one primary outcome and one owning component, seam, contract, or infra slice. Larger work must be split before assignment.

Spec text should state durable behavior, contracts, constraints, and acceptance criteria. Do not prescribe internal implementation details unless they are required for security, portability, compatibility, or platform operation.
