# cloudflare-worker

`cloudflare-worker` is an exported Orun composition in the Stack Tectonic catalog.

## Purpose

Verify a Cloudflare Worker app and deploy it from the production branch

## Contract

- **Type:** `cloudflare-worker`
- **Path:** `compositions/cloudflare-worker`
- **Definition:** `compositions.yaml`

## Example fixtures

These sample assets are excerpted or adapted from `example-platform-repo` so the contract is documented with realistic consumer-repo shapes.

- `examples/identity-worker`

## Test fixtures

- `tests/smoke`

## Verification

`./scripts/verify-composition.sh cloudflare-worker` checks that this composition keeps its contract, fixture, and generated-doc scaffolding intact.
