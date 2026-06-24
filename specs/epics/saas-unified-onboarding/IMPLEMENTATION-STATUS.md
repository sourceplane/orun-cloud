# saas-unified-onboarding — Implementation Status (as-built)

As-built record for cluster **UO**. The design lives in
[`design.md`](./design.md); this file tracks what has actually shipped.

| Milestone | Status | Notes |
|---|---|---|
| **UO1** — link-on-login safe to automate | **Done (verification)** | `tests/state-worker/src/links.test.ts` now pins the two guarantees the CLI auto-link relies on: (1) re-creating a link for an already-linked `(org, remote)` is **idempotent** — the existing active link is returned (201), not a 409; (2) with no `projectSlug`, the project is **named after the repo**, and `https://…/.git`, `git@…:…`, and bare-`https` spellings of one remote all normalize to a single identity (`github.com/owner/repo`). Deny-by-default behavior is unchanged (existing policy/membership negative-path tests still green). No schema or handler change — the behavior already existed; these tests lock it. |
| **UO2** — zero-org materialization | **Not started** | A no-org user's first `orun auth login` still cannot land a project (nothing to auto-pick / create under). Needs the `_default`-org materialize-on-first-link path (design §3). Product decisions open: personal-org naming + one-per-user quota. |
| **UO3–UO5** — vocabulary Project → Repo (console/specs/routes) | **Not started** | Console nav/pages/palette + component specs + `/repos/…` route alias. Large mechanical change; `prj_` IDs and `/projects/` contract path stay frozen. |

## Paired CLI side (cluster UO, repo `orun`) — shipped

The `orun` CLI half of the unified onboarding is merged on `main`:

- **UO0** — `auth`/`cloud` resolve the backend URL from `intent.yaml execution.state.backendUrl`.
- **UO1** — `orun auth login` authenticates **and** auto-links the repo (project named after the repo).
- **UO3** — `orun run` self-heals: auto-links an unlinked repo instead of dead-ending.
- **UO4** — repo-first CLI vocabulary.

See `orun/specs/orun-cloud/unified-onboarding.md`.
