# CLI And SDK

Status: Shipped — live on main (trust code over this doc). Owning work epic: see specs/epics/ + specs/roadmap.md.

Primary monorepo targets:

- `packages/sdk`
- `packages/cli`

Primary dependencies:

- `specs/core/contracts/api-guidelines.md`
- `specs/core/product-overview.md`
- optional `specs/core/contracts/resource-contract.schema.yaml`
- optional `specs/core/contracts/component-manifest.schema.yaml`
- `specs/components/01-edge-api.md`

Cloudflare primitives:

- none directly for the SDK and CLI, beyond talking to the public API

## Intent

Make the SaaS starter scriptable and automation-friendly through a stable TypeScript SDK and a first-class CLI.

## Scope

- authenticated API client
- typed resource and component helpers
- CLI auth flow
- organization selection and context persistence
- organization, member, invite, project, environment, settings, API-key, webhook, usage, billing, and audit commands
- optional resource and deployment commands
- machine-readable output modes

## Out Of Scope

- direct service-binding calls
- direct database access
- a separate private API surface

## Hard Contracts To Honor

- Public API rules in `specs/core/contracts/api-guidelines.md`
- Shared resource and component schemas

## Required Capabilities

### SDK

- typed client for the public API
- auth helpers
- pagination helpers
- error normalization

### CLI

- `login`
- `whoami`
- `org list`
- `org use`
- `org invite`
- `org members`
- `project create`
- `project list`
- `env create`
- `api-key create`
- `webhook create`
- `usage summary`
- `billing summary`
- `audit list`
- optional `component list`
- optional `resource create`
- optional `resource get`
- optional `deployment get`

### Output Rules

- Support human-readable default output.
- Support JSON output for automation.
- Surface request IDs and actionable error codes on failure.

## Agent Freedom

- V1 CLI may be implemented in TypeScript for speed even if a later Go CLI is desired.
- The SDK may be hand-written or partially generated from shared contracts.
- Command grammar may evolve as long as core capabilities and machine-readable output remain available.

## Acceptance Criteria

- Every major public SaaS starter flow available in the web console is also available through the CLI or SDK.
- SDK consumers do not need to know internal Worker topology.
- CLI output is stable enough for CI usage.

## Extraction Seam

The SDK and CLI bind to the public API only. That allows backend components to move independently later.
