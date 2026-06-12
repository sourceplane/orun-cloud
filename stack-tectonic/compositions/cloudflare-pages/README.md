# cloudflare-pages

`cloudflare-pages` is an exported Orun composition in the Stack Tectonic catalog.

## Purpose

Build static site assets and direct-upload them to Cloudflare Pages with Wrangler

## Contract

- **Type:** `cloudflare-pages`
- **Path:** `compositions/cloudflare-pages`
- **Definition:** `compositions.yaml`

## Example fixtures

These sample assets are excerpted or adapted from `example-platform-repo` so the contract is documented with realistic consumer-repo shapes.

- `examples/docs-site`

## Test fixtures

- `tests/smoke`

## Verification

`./scripts/verify-composition.sh cloudflare-pages` checks that this composition keeps its contract, fixture, and generated-doc scaffolding intact.
