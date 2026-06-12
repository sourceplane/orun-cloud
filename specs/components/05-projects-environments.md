# Projects And Environments

Status: Shipped — live on main (trust code over this doc). Owning work epic: see specs/epics/ + specs/roadmap.md.

Primary monorepo targets:

- `apps/projects-worker`

Primary dependencies:

- `specs/core/contracts/api-guidelines.md`
- `specs/core/contracts/event-envelope.schema.yaml`
- `specs/components/03-policy-authorization.md`
- `specs/components/04-organizations-membership.md`

Platform dependencies:

- Workers
- Hyperdrive binding to primary Supabase Postgres
- Supabase Postgres for project and environment state

## Intent

Provide Supabase-console-like project separation under an organization. Projects are the primary operational workspaces in the starter; environments are optional sub-scopes for configuration, deployment, or lifecycle separation.

## Scope

- project CRUD and archival
- environment CRUD and archival
- project metadata
- project settings
- environment metadata and lifecycle state
- default environment bootstrapping rules

## Out Of Scope

- resource provisioning
- config storage
- billing ownership

## Hard Contracts To Honor

- Multitenant scope rules from `specs/core/contracts/tenancy-and-rbac.md`
- Project isolation invariant from `specs/core/domain-model.md`
- Event envelope from `specs/core/contracts/event-envelope.schema.yaml`

## Required Capabilities

### Public/Internal Methods

- `createProject`
- `getProject`
- `listProjects`
- `archiveProject`
- `createEnvironment`
- `getEnvironment`
- `listEnvironments`
- `archiveEnvironment`

### Events

- `project.created`
- `project.updated`
- `project.archived`
- `environment.created`
- `environment.updated`
- `environment.archived`

### Project Isolation Rules

- Project APIs, repository methods, cache keys, events, and audit entries must carry both `orgId` and `projectId`.
- An environment lookup must carry `orgId + projectId + environmentId`.
- Project slugs must be unique inside an organization, not globally.
- Project deletion or archival must not orphan project-scoped API keys, webhooks, config, usage, audit history, or optional resources.

## Data Ownership

This component owns:

- projects
- environments
- project-level metadata and lifecycle markers

## Agent Freedom

- The agent may implement fixed default environments or customizable defaults as long as the contract stays stable.
- Project slugs, display names, and metadata shape may evolve if they remain additive.

## Acceptance Criteria

- A valid organization member with the correct role can create a project.
- A project can own multiple environments.
- A project cannot be read, updated, archived, or listed by `projectId` alone.
- Other components can reference project and environment IDs without direct DB coupling.

## Extraction Seam

Projects and environments are pure scope boundaries. They should remain simple and independently extractable even as resources and runtime become more complex.
