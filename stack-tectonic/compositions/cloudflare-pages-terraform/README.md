# cloudflare-pages-terraform

`cloudflare-pages-terraform` is an exported Orun composition in the Stack Tectonic catalog.

## Purpose

Verify static site builds locally and reconcile a Git-backed Cloudflare Pages project with Terraform

## Contract

- **Type:** `cloudflare-pages-terraform`
- **Path:** `compositions/cloudflare-pages-terraform`
- **Definition:** `compositions.yaml`

## Example fixtures

These sample assets are excerpted or adapted from `example-platform-repo` so the contract is documented with realistic consumer-repo shapes.

- `examples/docs-site-git`

## Test fixtures

- `tests/smoke`

## Verification

`./scripts/verify-composition.sh cloudflare-pages-terraform` checks that this composition keeps its contract, fixture, and generated-doc scaffolding intact.
