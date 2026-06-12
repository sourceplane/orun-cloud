# Resources And Component Registry

Status: Optional starter extension — design stage, not yet built. Owning work epic: specs/epics/saas-resources-runtime/.

Primary monorepo targets:

- `apps/resources-worker`

Primary dependencies:

- `specs/core/contracts/resource-contract.schema.yaml`
- `specs/core/contracts/component-manifest.schema.yaml`
- `specs/core/contracts/event-envelope.schema.yaml`
- `specs/components/05-projects-environments.md`

Platform dependencies:

- Workers
- Hyperdrive binding to primary Supabase Postgres
- Supabase Postgres for resource registry metadata and relationship state
- R2 for stored manifests or packaged artifacts
- KV for registry cache if needed

## Intent

Provide an optional project-resource extension: resources backed by versioned component definitions. This is useful for SaaS products that need manifest-driven provisioning, but it is not required for the core starter bootstrap of auth, orgs, projects, membership, billing, audit, usage, webhooks, notifications, and admin/support.

## Scope

- component definition registration
- component version publication
- manifest validation
- resource CRUD
- resource relationship graph
- resource desired state updates
- starter extension registry entries

## Out Of Scope

- executing deployment steps
- long-running orchestration
- billing calculations
- blocking the baseline SaaS starter flows on resource support

## Hard Contracts To Honor

- `specs/core/contracts/resource-contract.schema.yaml`
- `specs/core/contracts/component-manifest.schema.yaml`
- `specs/core/contracts/event-envelope.schema.yaml`

## Required Capabilities

### Public/Internal Methods

- `registerComponentDefinition`
- `publishComponentVersion`
- `getComponentDefinition`
- `listComponentDefinitions`
- `createResource`
- `getResource`
- `listResources`
- `updateResourceSpec`
- `deleteResource`
- `getResourceGraph`

### Events

- `component.registered`
- `component.version_published`
- `resource.created`
- `resource.updated`
- `resource.deleted`

### Validation

- Resource specs must validate against the owning component definition.
- Component manifests must validate against the shared manifest schema before publication.
- Resource type, component version, and scope must be internally consistent.

## Data Ownership

This component owns:

- component definitions
- component versions
- resource records
- resource dependencies and relationships

## Agent Freedom

- The agent may choose whether manifests are stored directly in Supabase Postgres, in R2 with Supabase Postgres metadata, or both.
- The agent may choose how resource graph queries are represented internally.
- Resource patch semantics may use full replace or structured partial update if the public contract is explicit.

## Acceptance Criteria

- A component definition can be published and later resolved by version.
- A resource can be created under a project and environment using a valid component definition.
- Every resource operation carries `orgId + projectId` and, where applicable, `environmentId`.
- Runtime orchestration can consume resource and manifest data without private table access.

## Extraction Seam

The registry decides what should exist. Runtime decides how it becomes real. That separation must remain clean.
