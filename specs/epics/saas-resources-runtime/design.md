# saas-resources-runtime — Design Framing (Draft)

> **Draft.** This is the program framing, not a locked design. The authoritative
> contracts are `components/06-resources-and-component-registry.md`,
> `components/08-runtime-orchestration.md`, and the `core/contracts/*.schema.yaml`
> schemas. Promote this to a full design doc when the epic is picked up.

## The bet

The platform's moat is **manifested, provider-backed project resources** with a
runtime that reconciles them. A component manifest (validated against
`core/contracts/component-manifest.schema.yaml`) is sufficient to drive: schema
validation, public API handling, CLI flows, and UI form generation — *one* manifest,
four surfaces. Resources follow the `kind` / `spec` / `status` shape
(`core/contracts/resource-contract.schema.yaml`). The runtime orchestrator
(Cloudflare Workflows by default; Durable Objects for locks/strong consistency per
`core/repo.md`) drives create/update/status through provider adapters and surfaces
state + failure reasons in the console.

## Boundaries (from the constitution)

- **Optional, not mandatory.** Baseline SaaS flows must keep working with the
  resource/runtime modules disabled. No starter domain may *require* the resource
  model.
- **Contracts, not hardcoding.** The runtime consumes published contracts; it must
  not hardcode per-component behavior.
- **Bounded context.** `resources-worker` and `runtime-worker` own their own
  persistence; no cross-domain table access; events are first-class.

## First slice (unblocks the deferred CLI)

The smallest credible start is the **read+create API surface on api-edge**:

1. `GET /v1/components` — list manifested component types for a project.
2. `GET /v1/resources` / `POST /v1/resources` / `GET /v1/resources/:id` — the
   resource lifecycle entry.
3. `GET /v1/deployments/:id` — deployment/reconciliation status.

with matching contracts in `@saas/contracts`. Once these exist, the deferred
spec-13 CLI commands (`component list`, `resource create/get`, `deployment get`)
become a pure SDK + CLI fan-out task (see `ai/deferred.md`).

## Larger program (when promoted)

`resources-worker` (registry + resource CRUD + validation) → `runtime-worker`
(workflow engine, status model, provider adapters, reconciliation loops, locking)
→ console resource/status surfaces → generated forms from manifests. Sequenced as a
multi-PR program after B4 (SDK) so the resources contract ships typed from day one.
