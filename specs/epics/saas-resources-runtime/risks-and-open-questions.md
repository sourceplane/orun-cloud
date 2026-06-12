# saas-resources-runtime — Risks & Open Questions

Must be resolved before this holding epic is promoted to a ready spec.

## Gating prerequisites

- **B4 (SDK) must land first** — the resources contract should ship as a typed
  client surface from day one. Do not start the workers before then.
- **Baseline credibility (B1–B4)** — a customer cannot reach P2 before baseline
  auth/SDK are credible; prefer B/U over P until then.

## Open design questions

- **Provider adapter model** — what is the first provider (e.g. a Cloudflare-native
  resource vs an external cloud resource)? What is the adapter contract boundary so
  the runtime stays provider-agnostic?
- **Reconciliation semantics** — desired-state loop cadence, drift detection, and
  how failure reasons surface in the console in a user-readable form (constitution
  §9).
- **Manifest → form generation** — how much of the UI form is generated vs
  hand-authored; where the generator lives (`packages/ui`).
- **Disable path** — exact seam that lets a deployment run with resources/runtime
  fully disabled without dead routes or broken console tabs.
- **api-edge facade shape** — the `/v1/components|resources|deployments` routes
  (the deferred CLI's prerequisite) — auth model + org/project scoping consistent
  with the existing facades.

## Notes

- The workers (`apps/resources-worker`, `apps/runtime-worker`) are in the canonical
  repo shape (`core/repo.md`) but **not yet built**.
- The optional spec-13 CLI commands stay deferred until the edge facade exists
  (`ai/deferred.md`).
