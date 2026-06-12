# turbo-package

`turbo-package` is an exported Orun composition in the Stack Tectonic catalog.

## Purpose

Verify a shared package in a pnpm and Turbo monorepo

## Contract

- **Type:** `turbo-package`
- **Path:** `compositions/turbo-package`
- **Definition:** `compositions.yaml`

## Example fixtures

These sample assets are excerpted or adapted from `example-platform-repo` so the contract is documented with realistic consumer-repo shapes.

- `examples/platform-sdk`

## Test fixtures

- `tests/smoke`

## Verification

`./scripts/verify-composition.sh turbo-package` checks that this composition keeps its contract, fixture, and generated-doc scaffolding intact.
