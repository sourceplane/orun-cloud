# cloudflare-workers-assets-turbo

`cloudflare-workers-assets-turbo` is an Orun composition in the Stack Tectonic catalog.

## Purpose

Build a Worker-entrypoint app with Turbo and deploy it to Cloudflare's
**Workers + Static Assets** runtime (a single `wrangler deploy` that uploads
both the worker bundle and the `ASSETS`-bound directory).

This is the right composition for apps whose framework emits a Worker bundle
plus a static-assets directory, e.g. Next.js apps adapted with
`@opennextjs/cloudflare`. For pure-static SPAs (Vite, plain React) use
`cloudflare-pages-turbo` instead.

## Contract

- **Type:** `cloudflare-workers-assets-turbo`
- **Path:** `compositions/cloudflare-workers-assets-turbo`
- **Required parameters:** `nodeVersion`, `pnpmVersion`, `workspaceDir`,
  `appDir`, `turboFilter`, `wranglerConfig`, `workerName`,
  `workerEntrypoint`, `assetsDir`.
- **Per-env naming:** set `environmentAwareWorkerName: true` to append the
  Orun environment name as a suffix to `workerName` (mirrors
  `cloudflare-pages-turbo`'s `environmentAwareProjectName`).
- **Smoke helper env:** the deploy step exports `EFFECTIVE_WORKER_NAME` (and
  `DEPLOYED_URL` when `workersDevSubdomain` is set) so the smoke command in
  `component.yaml` can curl the deployed hostname without hard-coding it.

## Profiles

| Profile        | Steps |
| -------------- | ----- |
| `pull-request` | setup → install → verify-structure → build → verify-output |
| `verify`       | pull-request + `deploy-dry-run` |
| `deploy`       | full pipeline through `deploy` + `smoke` |

## Why not `cloudflare-worker-turbo`?

`cloudflare-worker-turbo` is tuned for pure Worker packages (Hono APIs,
service workers): its profiles include `typecheck`, `pre-deploy`, and
`migrate` steps tailored to that lifecycle, and it deploys with
`--env <name>` against a single Worker definition. It does **not** verify
that an assets directory exists, and it does not support per-environment
worker-name suffixing the way `cloudflare-pages-turbo` does for Pages
projects. This composition adds those concerns without polluting the
Worker-API path.
