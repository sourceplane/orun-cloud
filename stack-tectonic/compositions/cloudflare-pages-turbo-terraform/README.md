# cloudflare-pages-turbo-terraform

`cloudflare-pages-turbo-terraform` is an exported Orun composition in the Stack Tectonic catalog.

## Purpose

Verify a static app with Turbo locally and reconcile a Git-backed Cloudflare Pages project with Terraform

## Contract

- **Type:** `cloudflare-pages-turbo-terraform`
- **Path:** `compositions/cloudflare-pages-turbo-terraform`
- **Definition:** `compositions.yaml`

## Example fixtures

These sample assets are excerpted or adapted from `example-platform-repo` so the contract is documented with realistic consumer-repo shapes.

- `examples/admin-console-git`

## Test fixtures

- `tests/smoke`

## Verification

`./scripts/verify-composition.sh cloudflare-pages-turbo-terraform` checks that this composition keeps its contract, fixture, and generated-doc scaffolding intact.
