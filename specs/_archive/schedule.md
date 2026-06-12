# Development Schedule (ARCHIVED — bootstrap complete)

> **ARCHIVED / NON-AUTHORITATIVE.** This is the original 8-week bootstrap plan.
> The bootstrap is complete (~130 tasks merged). The evergreen delivery rules
> (Delegation Checklist, Merge Policy, First Extraction Candidates) now live in
> `specs/core/operating-model.md` — read that, not this. Kept for provenance only.

Status: Planning baseline (historical)

Assumption: 4-6 autopilot coding agents plus 1 human reviewer or lead architect.

## Scheduling Principles

- Front-load contracts and seams, not feature polish.
- Land the Orun and Stack Tectonic repo skeleton first, then parallelize bounded contexts.
- Run all CI, tests, deploys, and smoke checks through Orun components.
- Treat each implementation task as one PR-sized block.
- Treat org -> project SaaS starter flows as the baseline product before optional resource/runtime work.
- Hold metering and billing until tenant, project, policy, and audit contracts are stable.
- Do not start extraction work until the monorepo contracts have seen real usage.

## Recommended 8-Week Plan

### Week 0: Orun repo bootstrap and architecture lock

- Create the repo skeleton from `specs/core/repo.md`.
- Add `intent.yaml`, `kiox.yaml`, `kiox.lock`, `stack-tectonic/`, and `.github/workflows/ci.yml`.
- Align `intent.yaml`, `kiox.yaml`, and the Terraform composition with the current `aws-admin` Orun golden path.
- Add starter `component.yaml` files for apps, packages, infra, and test components.
- Add at least one test component dependency so test execution is part of the Orun DAG.
- Delete deprecated `tf-state-r2` and `infra-terraform-core` component source,
  add the repo-scoped AWS-admin IAM role, establish S3 backend usage with the
  shared `sourceplane-<env>` buckets, and then add fresh Supabase Terraform
  provisioning for `stage` and `prod` with AWS Secrets Manager writes. `dev`
  Supabase provisioning is intentionally deferred.
- Verify local Orun validation, plan, and dry-run execution.
- Verify GitHub Actions plans once and runs the Orun job matrix.
- Review and freeze the constitution.
- Review and freeze `specs/core/product-overview.md` and `specs/core/domain-model.md`.
- Review and freeze shared contract docs.
- Confirm Supabase Postgres ownership model, schema namespace rules, and migration strategy.
- Confirm Cloudflare account layout, Supabase organization, environment naming, and deployment permissions.
- Confirm environment lane policies (`dev` / `stage` / `prod`) and approval gates.

Exit criteria:

- Orun repo skeleton is merged before domain code.
- `intent.yaml` discovers `apps/`, `packages/`, `tests/`, and `infra/`.
- `.github/workflows/ci.yml` runs only Orun plan/run jobs.
- A test-only change produces an Orun test component job.
- Infra changes produce Orun Terraform jobs.
- `aws-admin` has created the repo-scoped multi-tenant SaaS roles with S3 state and Secrets Manager access.
- Terraform state uses the shared S3 buckets `sourceplane-<env>`.
- No active Terraform component still uses Cloudflare R2 for state.
- Shared contract docs approved.
- Delegation order confirmed.
- Database and migration ownership model approved.
- Local Orun commands pass:

```bash
/Users/irinelinson/.local/bin/kiox -- orun compositions lock --intent intent.yaml
/Users/irinelinson/.local/bin/kiox -- orun validate --intent intent.yaml
/Users/irinelinson/.local/bin/kiox -- orun plan --changed --intent intent.yaml --output plan.json
/Users/irinelinson/.local/bin/kiox -- orun run --plan plan.json --dry-run --runner github-actions
```

### Week 1: Foundation

- Implement the workspace, tooling, root scripts, and Worker scaffolds.
- Materialize `packages/contracts` from the spec docs.
- Stand up the public edge Worker skeleton.
- Establish Supabase Postgres migration conventions and Hyperdrive adapter seams.
- Adopt or provision Supabase and Hyperdrive through Terraform-aware Orun workflows.
- Each new app, package, infra unit, and test suite must include a `component.yaml` so Orun discovers it automatically.
- App and package components must depend on their test components before release lanes are enabled.

Delegation lanes:

- Agent A: foundation and tooling
- Agent B: contract package and validators
- Agent C: edge API scaffold
- Agent D: database migration and repository-adapter conventions

Exit criteria:

- Monorepo builds locally.
- At least one Worker deploys.
- Contract tests exist.
- Repository adapters hide Supabase/Hyperdrive details from domain logic.
- `orun plan --changed --intent intent.yaml` produces the expected job matrix for every changed component.
- Supabase database provisioning and any Hyperdrive wiring are verified, with Terraform ownership or an explicit adoption path.

### Weeks 2-3: Tenant core

- Identity
- Organizations and membership
- Invitations
- Projects and environments
- Policy and authorization

Delegation lanes:

- Agent A: identity
- Agent B: organizations, membership, and invitations
- Agent C: projects and environments
- Agent D: policy and RBAC

Exit criteria:

- A user can sign in, create an organization, invite a member, create a project, and create an environment through the public API.
- The invitation accept flow works end to end.
- Project data cannot be queried, cached, authorized, or audited by `projectId` alone.

### Weeks 3-4: Starter operations

- Events, audit, and observability
- Config, secrets, settings, and feature flags
- API keys and service principals
- Notifications
- Webhooks and integrations

Delegation lanes:

- Agent A: event fanout, audit, and security-event queries
- Agent B: config, settings, secrets, and flags
- Agent C: API keys and service-principal hardening
- Agent D: notifications
- Agent E: webhooks and delivery tracking

Exit criteria:

- All starter mutations emit events and create audit entries.
- API keys can be created and revoked under an organization.
- Webhook endpoints can be created and delivery attempts are observable.
- Invitations and security notifications can be queued through the notification contract.

### Weeks 4-5: Usage and billing

- Metering
- Quotas
- Usage summaries
- Billing customers, plans, subscriptions, invoices, and entitlements
- Payment-provider adapter seam

Delegation lanes:

- Agent A: raw usage ingestion and idempotency
- Agent B: rollups and quota checks
- Agent C: plans, subscriptions, and entitlements
- Agent D: provider adapter and webhook handling

Exit criteria:

- Usage can be recorded, summarized, and queried per organization and project.
- Plan and entitlement changes affect behavior through contracts, not hardcoded UI checks.
- Billing provider webhooks update starter-owned billing state.

### Weeks 5-6: Product surfaces

- Web console
- CLI and TypeScript SDK
- Admin/support console baseline

Delegation lanes:

- Agent A: web console
- Agent B: CLI
- Agent C: SDK and generated types
- Agent D: admin/support read-only diagnostics and audit

Exit criteria:

- A user can complete the auth -> org -> invite -> project -> environment -> settings -> API key -> webhook -> audit -> usage -> billing flow from UI and CLI where appropriate.
- Support diagnostics are available only through audited support paths.

### Weeks 6-7: Optional resource extension

- Resources and component registry
- Optional component manifests
- Optional runtime orchestration
- Reconciliation loops
- Deployment status and failure reporting

Delegation lanes:

- Agent A: resources and registry
- Agent B: component manifest validation and generated forms
- Agent C: workflow engine and status model
- Agent D: runtime adapters and locking

Exit criteria:

- A resource-backed component can move through a full requested-to-ready lifecycle if the product extension is enabled.
- Baseline SaaS starter flows continue to work when resource/runtime modules are disabled.

### Weeks 7-8: Hardening and launch readiness

- Stability and security hardening
- Cross-component smoke tests
- Load and abuse-path testing
- Support runbooks
- Production launch approvals

Delegation lanes:

- Agent A: auth, policy, and tenant-isolation hardening
- Agent B: billing, metering, and webhook hardening
- Agent C: UI/CLI/SDK end-to-end verification
- Agent D: operational docs and runbooks

Exit criteria:

- Production launch blockers are tracked and either resolved or explicitly accepted.
- Human reviewer has approved architecture, database schema, auth/RBAC, billing flow, and production deployment.

## Delegation Checklist Per Component

Before assigning a component to an autopilot agent:

- confirm its upstream dependencies are merged,
- point the agent to the exact component spec,
- point the agent to the shared contracts it must honor,
- define the PR boundary and write scope,
- confirm the task has one primary outcome,
- split the task if it spans unrelated components, contracts, infra, or product scope,
- confirm whether the component may add new contracts or must use existing ones only.

## Merge Policy

- Merge Orun repo bootstrap before foundation or domain component work.
- Merge one accepted task per PR.
- Merge foundation before any domain component.
- Merge contract changes before dependent implementations.
- Merge tenant core before starter operations.
- Merge audit/event contracts before webhooks, notifications, billing, and support depend on them.
- Merge metering before billing.
- Merge optional runtime after resources and events are stable enough to avoid duplicate contract churn.

## First Extraction Candidates

These are the most likely components to move out of the monorepo first after traction:

1. `billing-worker`
2. `metering-worker`
3. `webhooks-worker`
4. `notifications-worker`
5. `identity-worker`
6. `runtime-worker` if optional resource orchestration becomes product-critical
