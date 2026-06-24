# Epic: saas-unified-onboarding

**One step to connect a repo to Orun Cloud.** Today a developer authenticates
(`orun auth login`), then separately links the repo to an org/project
(`orun cloud link`), then runs. This epic makes the platform support a CLI that
collapses those into a single login that authenticates *and* links — where the
**repo is the project**, named after the git repo, with the backend endpoint
read from the repo's own `intent.yaml`. It also finishes the **"project → repo"
vocabulary** rename across the console and docs that the v2 bijection
(`project == repo`) already made true in the data model.

Paired epic on the CLI side: `orun/specs/orun-cloud/unified-onboarding.md`
(cluster **UO**). The platform work here is mostly **confirm + polish + rename**:
the link API already creates a project on demand and derives its slug from the
repo name. Neither repo may break the shared wire contract
(`saas-orun-platform/state-api-contract.md`).

## Status

| Field | Value |
|-------|-------|
| Status | **Proposed** — design drafted; not started. Builds directly on shipped v2 tenancy (project == repo) and the existing CLI-link endpoints. |
| Cluster | **UO** (UO0–UO6) |
| Owner(s) | `state-worker` (links), `identity-worker` (CLI auth + org materialization), `projects-worker` (on-demand project), `web-console-next` (vocabulary), `packages/contracts` + `docs` |
| Target branch | `main` (milestone-sized PRs) |
| Builds on | `saas-orun-platform` (OV1 tenancy = project == repo; OV2 org materialization; CLI link + resolve endpoints), `components/05-projects-environments.md`, `components/13-cli-and-sdk.md`, `components/04-organizations-membership.md` |
| Pairs with | `orun/specs/orun-cloud/unified-onboarding.md` — CLI-side epic (cluster **UO**) |
| Decisions locked | a project **is** a git repo (1:1, already enforced by the active-link uniqueness invariants); the repo name is the project name/slug; org is the only thing a human ever picks, and at most once; backend endpoint is a repo property (`intent.yaml`), not a per-command flag; user-facing noun becomes **"repo"** while internal IDs/paths stay `project*` for contract stability |

## Thesis

The data model already says *a project is a repo*: `state.workspace_links`
binds a normalized git remote to exactly one `(org_id, project_id)`, the v2
bijection adds the reverse uniqueness, and `POST …/cli/links` with no
`projectSlug` **creates the project from the repo name**
(`deriveSlugFromRemote`). What the product still exposes is the *old* mental
model — "log in, then link a project" — and the *old* vocabulary ("Projects" in
the console nav).

This epic closes that gap from the platform side so the CLI can offer one-step
onboarding:

1. **Backend endpoint is discoverable, not demanded.** Nothing server-side
   changes here — the CLI reads `backendUrl` from `intent.yaml` — but the
   console's "connect the CLI" guidance and the device/loopback approval copy
   are updated to match the one-command flow.
2. **Link-on-login is a first-class flow.** Confirm the resolve→create path is
   safe to run automatically right after authentication (idempotent, project
   auto-named, org auto-picked when unambiguous), and that the **zero-org actor**
   materializes a per-owner default org (OV2) so a brand-new user's first
   `orun login` lands a working `org/repo` with no console visit.
3. **Vocabulary becomes "repo".** Rename every user-facing "Project" to "Repo"
   in `web-console-next`, the CLI-facing copy, and the component specs — phased,
   keeping `prj_…` IDs and `/projects/` routes for contract stability, with a
   `/repos/` route alias layered on top.

## Cross-repo dependency map

| CLI (orun, cluster UO) | Platform (orun-cloud, cluster UO) |
|---|---|
| `orun login` calls `GET /v1/cli/links/resolve` then `POST …/cli/links` (projectSlug empty) | resolve + create endpoints confirmed idempotent + repo-named (UO1) |
| `run` auto-links on first remote run | zero-org → default-org materialization (UO2) |
| CLI prints `org/repo` vocabulary | console + contracts print "Repo" (UO3–UO4) |

## Milestones

See [`design.md`](./design.md) §6.
