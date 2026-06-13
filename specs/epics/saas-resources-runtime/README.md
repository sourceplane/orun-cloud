# Epic: saas-resources-runtime

**The differentiator / moat (roadmap P2).** Manifest-driven project resources plus
runtime orchestration. This is the largest single program and the bet that
justifies the bounded-context discipline everywhere else — but a customer cannot
reach it until the baseline (`saas-baseline` B1–B4) is credible.

## Status

| Field | Value |
|-------|-------|
| Status | **In progress** — model core (`@saas/db/resources`: resource kind/spec/status + the deployment reconciliation machine) and the **runtime→work Released bridge** (`@saas/db/bridge`) landed; SQL repository + api-edge `/v1` facade + workers pending |
| Cluster | **P2** |
| Owner(s) | new `apps/resources-worker` + `apps/runtime-worker` (do not yet exist) |
| Target branch | `main` (multi-task program) |
| Builds on / consumes | `components/06-resources-and-component-registry.md`, `components/08-runtime-orchestration.md` (both "Optional starter extension"), `core/contracts/component-manifest.schema.yaml`, `core/contracts/resource-contract.schema.yaml` |
| Decisions locked | resource model is `kind`/`spec`/`status`; manifests drive validation + API + CLI + UI-form generation; runtime consumes published contracts, never per-component hardcoding |
| Gate | **Do not start before B4 (SDK)** — the resources contract should ship as a typed client surface from day one. |

## Thesis

Component manifests describe project-scoped resources; the runtime orchestrator
drives create/update/status through provider adapters; status surfaces in the
console. Baseline SaaS flows must continue to work when the resource/runtime
modules are disabled (the constitution forbids forcing every consumer into a
runtime-orchestration product model).

## Landed so far (program now in progress)

The pure cores + persistence foundation are on `main`:

- **`@saas/db/resources`** — the `Resource` shape (kind/spec/status with the
  contract phase set), the `Deployment` reconciliation machine
  (`queued→running→succeeded/failed`, terminal-idempotent), `reconcile` (runtime
  truth → resource status), and migration `210_resources_runtime_foundation`.
- **`@saas/db/bridge`** — the **runtime → work seam**: a deployment reconciling
  to live (`liveObservation`) drives orun-work's W3 Released automation
  (`decideReleased`), so *deploy goes live → the tasks that shipped in that
  revision auto-Release*. Released stays derived from the Deployment overlay,
  never a deploy attempt (work invariant 5).

**Still pending:** the resources/deployments SQL repository, the api-edge
`/v1/{components,resources,deployments}` facade + `@saas/contracts` (the epic's
stated first slice), the `resources-worker`/`runtime-worker`, and console
surfaces. The note below predates this work.

## Why this is still Draft

- The workers don't exist yet (`apps/resources-worker`, `apps/runtime-worker` are
  in the canonical repo shape but unbuilt).
- The CLI's optional spec-13 commands (`component list`, `resource create/get`,
  `deployment get`) are **deferred** precisely because api-edge exposes no
  `/v1/components`, `/v1/resources`, or `/v1/deployments` facade yet (see
  `ai/deferred.md`). Those routes are this epic's first slice.

## When promoted, author the full doc set

This epic is a **holding spec**. When work starts, promote it to the full Orun doc
set: `design.md` (architecture), `data-model.md` (resource/deployment schemas
beyond the contract), `cli-surface.md`, `implementation-plan.md` (milestones),
`test-plan.md`, `risks-and-open-questions.md`, `compatibility-and-migration.md`.
Until then, see `design.md` (framing) and `risks-and-open-questions.md`.

## Read order

1. `README.md` (this file).
2. `components/06-resources-and-component-registry.md` + `08-runtime-orchestration.md` — the durable contracts.
3. `core/contracts/{component-manifest,resource-contract}.schema.yaml` — the frozen schemas.
4. `design.md` — the program framing + first slice.
5. `risks-and-open-questions.md` — what must be resolved before promotion.
