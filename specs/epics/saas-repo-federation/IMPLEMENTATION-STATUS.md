# Implementation Status — saas-repo-federation

As-built record for the RF cluster. Design intent is in
`implementation-plan.md`; trust code over this doc — re-derive from `git`/PRs on
boot.

## Summary

| ID | Status | Evidence / notes |
|----|--------|------------------|
| RF0 | 🗓️ Planned | Enabler exists: `stack-tectonic/component.yaml` is a `publish-stack` → `ghcr.io/sourceplane/stack-tectonic`. Not yet published; `intent.yaml` still consumes the stack via `kind: dir, path: stack-tectonic`. Gated on BF10 OCI-consumption on the pinned runtime. |
| RF1 | 🗓️ Planned | No kernel publish pipeline yet; all 54 consumer `package.json` files use `@saas/* : workspace:*`. Fork tool already treats `packages/*` as one foundation batch. |
| RF2 | 🗓️ Planned | `tooling/fork/components.mjs` already builds the full prerequisite graph (dependsOn · wrangler service bindings · `wiringComponents` · workspace deps · tests-follow-subject) and SCC-batches binding cycles — the basis for the topology validator + scaffolder. No wiring-contract guard test yet. |
| RF3 | 🗓️ Planned | Frontend already public-API-only by rule (`core/repo.md`), so no binding edges to sever — the intended first extraction. Not started. |
| RF4 | 🗓️ Planned | Infra ordering + BF6 no-committed-IDs wiring already in place; not yet its own repo. |
| RF5 | 🗓️ Planned | Human-gated on a named owning team for the commerce group. Not started. |
| RF6 | 🗓️ Planned | `ci.yml` is a clean 2-job plan/run workflow, ready to become a reusable workflow; state already `<org>/<repo>`-scoped. Ties into BF11–BF14 upstream-sync. |

## Decisions taken

- (none yet — epic is Draft)

## Provenance

- Epic authored from the monorepo-split analysis session (2026-07-23). Grounded
  in the live repo: 20 `apps/`, 10 `packages/`, per-component `tests/`, the
  `stack-tectonic` publish-stack, `intent.yaml` composition sources, the BF5/BF6
  wiring templates, and `tooling/fork/components.mjs`. No code changed; this is
  a design/spec-only epic (specs/ is not an Orun discovery root, so it plans no
  component jobs).
