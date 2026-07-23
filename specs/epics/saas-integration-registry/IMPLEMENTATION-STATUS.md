# saas-integration-registry — Implementation Status

As-built record. Epic designed 2026-07-23 (#593) on the shipped IH/SP/IT
rails; implementation started same day.

## Summary

| ID | Status |
|----|--------|
| IR0 | 🔄 In progress — manifest + registry read |
| IR1 | 🗓️ Planned |
| IR2 | 🗓️ Planned |
| IR3 | 🗓️ Planned |
| IR4 | 🗓️ Planned |
| IR5 | 🗓️ Planned (gate: IR-D3 sign-off) |
| IR6 | 🗓️ Planned |
| IR7 | 🗓️ Planned (pairs orun ICL0–ICL3) |
| IR8 | 🗓️ Planned |
| IR9 | 🗓️ Planned |

## Notes

- 2026-07-23: IR0 as built:
  - **Contracts** (`packages/contracts/src/integrations.ts`, additive):
    `IntegrationCategory`, `IntegrationManifestStatus`, `IntegrationSpaceTab`,
    `IntegrationModuleRef`, the CLI-projection types (`IntegrationCliArg` /
    `IntegrationCliInvoke` / `IntegrationCliVerb` / `IntegrationCliNamespace` —
    types only in IR0; verb data lands with IR7), `IntegrationManifest`,
    `IntegrationConnectMethod{,Decl}`, `IntegrationDescriptor`,
    `IntegrationRegistryResponse`.
  - **Manifests** (`apps/integrations-worker/src/providers/manifests/`): one
    module per provider beside its adapter (github, slack, cloudflare,
    supabase live; aws, discord roadmap/dormant), each `{ manifest,
    resolveConnect(env) }`. `shared.ts` carries the module contract + the
    default `liveWhenConfigured` resolver (the `getConfiguredProvider` gate,
    reported); Cloudflare supplies its own two-method resolver (oauth when a
    client is registered, token whenever custody exists).
  - **Registry read**: `GET /v1/organizations/{org}/integrations/registry`
    (`handlers/registry.ts`; route matched before `ORG_INTEGRATION_RE`).
    Descriptor = manifest + per-env `connect[].live` + fail-soft `entitled`
    (per live provider via billing-worker; omitted on service error — never
    fabricated, the SP-A5 rule). ETag = SHA-256 of the payload;
    `If-None-Match` → 304. Zero api-edge changes (rides
    `ORG_INTEGRATIONS_RE`, verified against the facade tests).
  - **Projection**: `secrets-capabilities.ts` now iterates the manifest
    registry instead of `KNOWN_PROVIDER_IDS + DORMANT_PROVIDER_IDS`; wire
    shape unchanged (all shipped SP0c tests pass untouched).
  - **SDK**: `client.integrations.getRegistry(orgId)`.
  - **Tests**: `manifest-conformance.test.ts` (manifest ⊆ adapter —
    capabilities exact-match, connect kinds cover the adapter's resolved
    posture, authoring matches the secrets declaration, tabs are a pure
    function of capabilities, per-env liveness honesty incl. the Cloudflare
    matrix) + `registry-read.test.ts` (route, liveness projection, fail-soft
    entitlement, ETag/304, metadata-purity, 401/404/405).
  - Verified: integrations-worker 457/457, contracts, api-edge 525/525
    (after `wire:fixture`), typecheck + lint clean.
