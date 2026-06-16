# saas-integrations → state: the object-graph bridge (v2 extension)

> Status: Proposed. Extends the `saas-integrations` epic (IG0–IG4 code-complete)
> to wire the GitHub App into the Orun Cloud object model. Paired design:
> `saas-orun-platform/design-v2.md` §5. This document is the integrations-side
> contract for that bridge; ownership stays split across the two bounded
> contexts, connected only by the event_log (inbound) and the token broker /
> write-back proxy (outbound).

## Why this extends the epic's scope

The integrations epic deliberately scoped out "CI/CD, build, or deploy
execution on SCM events (a product concern)" and shipped the write-back as a
*token broker primitive*, leaving check-run/deployment posting as an optional
IG4 stretch (`components/17-integrations.md`; `risks-and-open-questions.md` D2).
v2 makes Orun Cloud itself the primary consumer of `scm.*` (ingest into the
object graph) and promotes the write-back proxy to first-class. The integrations
context keeps its boundary: **it owns provider credentials, the webhook inbox,
normalization, and the token broker — it never reads or writes the object
graph; state-worker never holds GitHub credentials.**

## What already exists (build on, do not rebuild)

- `integrations.connections` — `installation_id ↔ org_id` via signed, single-use,
  fail-closed state. **This is the org↔GitHub trust binding** Orun Cloud v2 keys
  CI auth on.
- `integrations.github_installations` — `installation_id`, account facts,
  `repository_selection`, `permissions`, `events`.
- `integrations.repo_links` — `org_id, project_id, connection_id,
  repo_external_id, repo_full_name, default_branch, branch_env_map (JSONB)`.
- `integrations.inbound_deliveries` — HMAC-verified, idempotent inbox; cron drain
  → normalize → emit `scm.*` into event_log, exactly-once.
- Token broker — `POST …/integrations/github/token`, scoped (repos ∩ links,
  perms ⊆ App grant), fresh, never cached for tenants, audited.
- Normalized events incl. `scm.push`, `scm.pull_request.*`,
  `scm.check.completed`, `scm.branch.*`, `scm.tag.created`,
  `scm.repo.linked|unlinked`.
- Default App permissions (D2): `checks:write`, `statuses:write`,
  `deployments:write` — the write-back surface is already granted.

## Inbound — `scm.*` → object graph (consumer lives in state-worker)

The bridge consumer is owned by **state-worker** (see `saas-orun-platform`
OV4); it is listed here so the contract is visible from both sides.

- Subscribes to `scm.push` and `scm.pull_request.*` on the event_log.
- For content access it calls the **token broker** for a short-lived
  `contents:read` token scoped to the affected repo (∩ its active repo_link) —
  state-worker holds no durable GitHub credential.
- Writes Source + Catalog objects keyed by commit, moves
  `refs/sources|catalogs/*`; records a `TriggerOccurrence` (actor `github`);
  optional auto-run per project.
- Idempotent by `(repository_id, commit_sha)` + the delivery id already de-duped
  by the inbox — redeliveries never double-write.

Integrations-side obligations: `scm.push`/`scm.pull_request` projections must
carry `repository_id`, `repository_owner_id`, `commit_sha`/`head_sha`, `ref`,
and (PR) `base_sha` — additive to the existing versioned projection.

## Outbound — object-graph results → GitHub (proxy lives in integrations-worker)

The write-back proxy is owned by **integrations-worker** (it holds the App
private key); state-worker drives it via an internal result event, never by
calling GitHub.

- New convenience endpoints (the deferred IG4 stretch), each minting a scoped
  installation token internally:
  - create/update **Check Run** (name, conclusion, summary, annotations,
    details_url → cockpit run);
  - create **commit status**;
  - create/update **Deployment** + deployment status (env from
    `repo_links.branch_env_map` → orun environment).
- Driven by state-worker result events (plan complete, run terminal, catalog
  diff ready). Affected-components and drift come from the Merkle catalog diff
  computed in OV4; the proxy only renders + posts.
- Audited like the broker (`integration.checkrun.posted`,
  `integration.deployment.posted`), never logging tokens.

## Repo-link reconciliation (with `state.workspace_links`)

`integrations.repo_links` (App-backed) and `state.workspace_links` (App-less,
any git host) stay distinct tables but converge on the **project (= repo)**
node, keyed on `repo_external_id`/`provider_repo_id`. The App link *enriches* a
project (webhooks, token, branch→env, write-back); the workspace link is the
fallback. The console cross-links them (already implemented). A project may
materialize from installation repo-selection, `orun cloud link`, or first
OIDC/key push — all keyed to the same repo identity.

## Boundary invariants (must hold)

- state-worker never receives the App private key and never calls GitHub
  directly; all GitHub reads use a broker-minted scoped token, all writes go
  through the integrations write-back proxy.
- The event_log is the only inbound coupling; the token broker + write-back
  proxy are the only outbound coupling. No shared tables across the two schemas.
- Every bridge action is audited; all gates fail closed; entitlement
  (`feature.integrations.github`) and policy
  (`organization.integration.token.issue`) are enforced unchanged.

## New milestones (IG-side, pair with OV4/OV5)

- **IG8 — inbound projection fields**: extend `scm.push`/`scm.pull_request`
  projections with the identity/commit fields above (additive, versioned).
- **IG9 — write-back proxy**: check-run / commit-status / deployment endpoints +
  audit events; consumed by state-worker result events.

Both are human-independent on the worker side; live paths share the IG **D1**
gate (per-environment GitHub App registration).
