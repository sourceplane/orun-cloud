# saas-unified-onboarding — Implementation Status (as-built)

As-built record for cluster **UO**. The design lives in
[`design.md`](./design.md); this file tracks what has actually shipped.

| Milestone | Status | Notes |
|---|---|---|
| **UO1** — link-on-login safe to automate | **Done (verification)** | `tests/state-worker/src/links.test.ts` now pins the two guarantees the CLI auto-link relies on: (1) re-creating a link for an already-linked `(org, remote)` is **idempotent** — the existing active link is returned (201), not a 409; (2) with no `projectSlug`, the project is **named after the repo**, and `https://…/.git`, `git@…:…`, and bare-`https` spellings of one remote all normalize to a single identity (`github.com/owner/repo`). Deny-by-default behavior is unchanged (existing policy/membership negative-path tests still green). No schema or handler change — the behavior already existed; these tests lock it. |
| **UO2** — zero-org materialization | **Done (CLI side)** | A no-org user's first `orun auth login` now materializes a personal org and links the repo under it — implemented in the `orun` CLI (`materializePersonalOrg`), which calls the **existing** `POST /v1/organizations` endpoint (the platform already always allows the first/bootstrap org and assigns the free plan). No backend change was required. Defaults: one personal org named/slugged after the GitHub login (else email local-part, else display name); slug collisions retry once with a short random suffix. The `_default`-sentinel server-side variant (design §3 option b) remains an optional future refinement. |
| **UO3** — console vocabulary Project → Repo (Phase A, labels) | **Done** | All user-facing "Project"/"Projects" strings in `web-console-next` now read "Repo"/"Repos": sidebar/bottom-tabs/breadcrumbs/scope-switcher nav, command palette (+ "repo" search keyword), the repos index page (headings, create dialog, empty state, toast), detail-page field labels (`Repo`/`Repo slug`/`Repo ID`), catalog filters, billing plan limits ("Up to N repos"), org-creation copy, and the web manifest/product tagline. The CLI page now points at `orun auth login`. `prj_` IDs, `projectSlug`/`projectId`, query keys, route segments, and the `/projects/` contract path are unchanged. `breadcrumbs.test.ts` updated; 279 console tests + typecheck + lint green. |
| **UO4–UO5** — spec vocabulary + `/repos/…` route alias | **Not started** | Reframe `components/05` + `13` to lead with "a project is a repo"; add `/repos/[repoSlug]` canonical route with a 308 alias from `/projects/…` and an SDK `repos` accessor. Additive; contract path stays frozen. |

## Paired CLI side (cluster UO, repo `orun`) — shipped

The `orun` CLI half of the unified onboarding is merged on `main`:

- **UO0** — `auth`/`cloud` resolve the backend URL from `intent.yaml execution.state.backendUrl`.
- **UO1** — `orun auth login` authenticates **and** auto-links the repo (project named after the repo).
- **UO3** — `orun run` self-heals: auto-links an unlinked repo instead of dead-ending.
- **UO4** — repo-first CLI vocabulary.

See `orun/specs/orun-cloud/unified-onboarding.md`.
