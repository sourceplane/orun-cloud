# saas-integrations — Implementation Plan (IG0–IG7)

Status: Draft. Milestones are PR-sized coherent units; the Orchestrator
sequences them. IG0 and the worker-side bulk of IG2 are human-independent;
everything touching live GitHub needs the per-environment App registration
(`risks-and-open-questions.md` D1).

## IG0 — Foundation (dormant) — 🗓️ Planned

The contract-and-schema slice with zero live behavior, safe to land any time.

- `specs/components/17-integrations.md` — the durable bounded-context contract
  (intent, scope, capabilities, events, data ownership, extraction seam),
  distilled from `design.md`.
- `packages/contracts/src/integrations.ts` — `PublicConnection`,
  `PublicRepoLink`, `PublicInboundDelivery` (safe projection), connect/link/
  token request+response shapes, the versioned `scm.*` event payload
  projections; export wired in `package.json` + `index.ts`.
- `packages/db`: migration `180_integrations_foundation` (schema + five tables
  per design §3, manifest entry, checksum), `src/integrations/{types,repository,
  index}.ts` repo layer (branded `Uuid` inputs, `Result<T>` unions, org-scoped
  queries), `BOUNDED_CONTEXTS` + jest mapper + fixtures in `packages/testing`.
- `apps/integrations-worker` skeleton: router, health, env, ids (`int_`,
  `repl_`, `igd_` prefixes), component.yaml, wrangler.jsonc (cron + bindings,
  dev/stage/prod), wired into Orun discovery.

**Done when:** typecheck/lint/test green across the workspace; migration
applies + rolls back on stage; `/health` responds on a deployed dormant worker;
no public route reachable.

## IG1 — Connect flow end-to-end — 🗓️ Planned (gated on D1)

- Provider registry + GitHub adapter: install-URL builder, signed single-use
  `state` (HMAC + persisted nonce, TTL ≤ 10 min), App JWT mint (RS256),
  installation fetch/activation.
- `POST .../integrations/github/connect` (policy `organization.integration
  .connect`, entitlement `feature.integrations.github`), `GET .../integrations`
  list, `DELETE .../integrations/{id}` revoke.
- api-edge: authenticated `integrations-facade` + the new public
  `/ingress/github/setup` route (design §5 rules; allowlist, no resolveActor).
- Orphaned-installation handling (record, admin-visible, never auto-bound).
- Console (minimal): Settings → Integrations page with GitHub card, connect
  popup flow, connection row with status + revoke. Designed empty state.
- Events: `integration.connected` / `integration.revoked` into event_log.

**Done when:** on stage, an org admin connects a real GitHub org from the
console and the connection shows `active` with account facts; a second org
cannot see or claim it; revoke works both ways (console revoke; GitHub-side
uninstall arrives via IG2 or a poll fallback until IG2 lands); every mutation
is in the audit log; all gates fail closed.

## IG2 — Inbound events — 🗓️ Planned

- api-edge `/ingress/github/webhook`: raw-body capture, size cap, fast-ack.
- integrations-worker ingest: HMAC-SHA256 verify (constant-time, raw bytes),
  `inbound_deliveries` upsert keyed by `X-GitHub-Delivery`, 200 within budget.
- Cron drain: attribute (installation → connection → org), process lifecycle
  events (install/uninstall/suspend/repo-selection), normalize + emit `scm.*`
  into event_log transactionally with the `emitted` mark; bounded retries +
  terminal `failed` with safe reason.
- Delivery log API (`GET .../integrations/{id}/deliveries`, cursor-paginated,
  safe projection) + replay (`POST .../deliveries/{id}/replay`, re-runs
  normalize/emit — never re-trusts the wire).
- Worker-side unit tests run against recorded GitHub fixture payloads
  (human-independent); the live path needs D1.

**Done when:** a push to a connected repo on stage appears as `scm.push` in the
org's audit log and is delivered to a customer webhook endpoint via the
existing spec-15 pipeline; redelivered GitHub events do not double-emit;
uninstalling the App on GitHub flips the connection to `revoked` within one
cron cycle; replay works from the console-facing API.

## IG3 — Repo links + branch→environment mapping — 🗓️ Planned

- Repo browsing via cached installation token (`GET .../integrations/{id}/
  repositories`, search + pagination).
- `repo_links` CRUD under `/v1/organizations/{orgId}/projects/{projectId}/
  repo-links` (policy `project.repo_link.write`, entitlement
  `limit.repo_links`), branch→environment map validated against live
  environments.
- Event enrichment: `scm.*` deliveries matching a linked repo emit per-project
  with `projectId` + resolved environment (per branch map).
- Console: project Git tab — repo picker, link/unlink, branch mapping editor.
- `scm.repo.linked` / `scm.repo.unlinked` events.

**Done when:** linking a repo from the project Git tab takes < 30s end-to-end
on stage; a push to a mapped branch emits a project-scoped `scm.push` carrying
the environment; unlink stops project-scoped emission; limits gate with 412 +
upgrade UX.

## IG4 — Token broker — 🗓️ Planned

- `POST .../integrations/github/token` per design §7: requested repos must be
  linked + actor-accessible, permissions ⊆ App grant, TTL ≤ 1h, never cached,
  never logged; `integration.token.issued` audit event.
- Policy `organization.integration.token.issue`; entitlement reuse; SDK
  (`integrations.github.issueToken`) + CLI (`sp integrations github token`).
- Docs: the "act on GitHub from your product" recipe (API key → broker →
  octokit), mirroring the webhook-verifier recipe style.

**Done when:** a service-principal API key can mint a token scoped to one
linked repo and use it against the GitHub API; a request for an unlinked repo
or un-granted permission is denied with a safe error; issuance shows in audit
with actor + scope; SDK/CLI round-trip is tested.

## IG5 — Console to Vercel standard — 🗓️ Planned

- Integrations marketplace page (provider cards, planned-provider ghosts),
  connection detail (status, account, repo selection, recent `scm.*` activity,
  danger zone), polish on the project Git tab.
- Cmd-K: "Connect GitHub", "Open integrations", "Link repository".
- Optimistic mutations where safe (link/unlink), skeletons, error states with
  requestId disclosure; mobile-credible per the shipped responsive shell.

**Done when:** the surface passes the same buyer-credibility bar the PX audits
apply to the rest of the console (no stubs, no native confirm(), designed
empty/loading/error everywhere); a verified-live walkthrough is recorded in
`IMPLEMENTATION-STATUS.md`.

## IG6 — Lifecycle hardening — 🗓️ Planned

- Reconcile job (cron): compare GitHub installation truth vs local state,
  self-heal drift (mirror of the billing provider-reconcile pattern, #289).
- Suspension semantics: suspended connections pause token issuance + repo
  browsing but keep history visible; `integration.suspended`/`.reactivated`.
- Failure budgets: ingest/normalize error-rate alert through
  notifications-worker (B2) when live; admin-worker: orphaned installations,
  delivery inspection, connection search.

**Done when:** deleting the App install on GitHub while the worker is down
converges to `revoked` after recovery; an induced normalize failure alerts and
is replayable; admin can locate any installation by GitHub account or org.

## IG7 — Pluggability proof + instance alignment — 🗓️ Planned (optional tail)

- Dormant `gitlab` adapter compiling against `IntegrationProvider` (no live
  path) — the Stripe-after-Polar discipline applied to SCM.
- Credential surface lifted to BF instance parameters (App ID/slug/secrets per
  environment in the instance contract); registration runbook (or GitHub App
  manifest-flow automation) documented for instance operators.

**Done when:** a second provider adapter typechecks with zero handler/console
changes; a fresh instance can wire its own GitHub App from `instance.yaml` +
runbook without code edits.

## IG8 — Inbound projection fields for the state bridge — 🗓️ Planned

The additive contract slice that lets state-worker materialize the object graph
from `scm.*` (see `bridge-to-state.md`; pairs with `saas-orun-platform` OV4).

- Extend the versioned `scm.push` / `scm.pull_request.*` projections with
  `repository_id`, `repository_owner_id`, `commit_sha` / `head_sha`, `ref`,
  and (PR) `base_sha` — additive-only per R7.
- No new live path: the consumer lives in state-worker; this milestone is the
  contract + fixtures the consumer verifies against.

**Done when:** the enriched projections are versioned in `packages/contracts`,
fixture-tested, and a recorded `scm.push` carries the identity/commit fields
the bridge consumer needs; no breaking change to existing `scm.*` consumers.

## IG9 — Write-back proxy — 🗓️ Planned (promotes the IG4 stretch)

The "act on GitHub from the platform" convenience proxy, owned by
integrations-worker (it holds the App key), driven by state-worker result
events (pairs with `saas-orun-platform` OV5).

- Endpoints, each minting a scoped installation token internally: create/update
  **Check Run** (name, conclusion, summary, annotations, `details_url` →
  cockpit run), create **commit status**, create/update **Deployment** +
  deployment status (env via `repo_links.branch_env_map`).
- Perms already granted (D2: `checks`/`statuses`/`deployments:write`); audited
  (`integration.checkrun.posted`, `integration.deployment.posted`), never
  logging tokens; policy/entitlement reuse from IG4.

**Done when:** a state-worker result event posts a Check Run with affected
components + a cockpit link on a stage PR; a run targeting an environment
updates a GitHub Deployment; unlinked repos / un-granted perms fail closed.

## Sequencing note

IG0 → IG1 → IG2 is the spine and strictly ordered. IG3/IG4 both ride on IG1+IG2
and can land in either order (IG3 first gives the console story sooner; IG4
first gives products the act-on-GitHub story sooner — default IG3). IG5 polish
trails the surface it polishes; IG6 hardening trails live traffic; IG7 is
detachable. **IG8/IG9 are the state-bridge pair** (`bridge-to-state.md`): IG8 is
an additive contract slice that can land any time; IG9 rides on IG4 (the broker)
and pairs with `saas-orun-platform` OV4/OV5. Worker-side IG2 fixtures and all of
IG0/IG8 can proceed while D1 (App registration) is pending — the same
park-and-continue discipline used for Polar/Stripe credentials.
