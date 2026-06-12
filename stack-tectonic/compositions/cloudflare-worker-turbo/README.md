# cloudflare-worker-turbo

`cloudflare-worker-turbo` is an exported Orun composition in the Stack Tectonic catalog.

## Purpose

Verify a Cloudflare Worker app and deploy it from the production branch

## Contract

- **Type:** `cloudflare-worker-turbo`
- **Path:** `compositions/cloudflare-worker-turbo`
- **Definition:** `compositions.yaml`

## Example fixtures

These sample assets are excerpted or adapted from `example-platform-repo` so the contract is documented with realistic consumer-repo shapes.

- `examples/api-edge`

## Test fixtures

- `tests/smoke`

## Verification

`./scripts/verify-composition.sh cloudflare-worker-turbo` checks that this composition keeps its contract, fixture, and generated-doc scaffolding intact.
