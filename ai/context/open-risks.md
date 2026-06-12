# Open Risks

Last updated: 2026-05-26

## Active Risks

- Supabase provisioning must not log generated database passwords, API keys,
  service keys, or connection strings. Reports may include project refs, secret
  names, and non-secret ARNs only.
- `dev` Supabase remains intentionally unprovisioned. Tasks must not add a dev
  database/project unless a later prompt explicitly changes scope.
- `infra/terraform/cloudflare-hyperdrive/component.yaml` does not currently
  declare an explicit `dependsOn` edge to `supabase`; Task 0009 verification
  treated this as non-blocking because current Orun behavior and live state are
  stable. Revisit if future dependency ordering issues appear.
- The `_migrations.applied` table is bootstrapped in both `stage` and `prod`.
  Future domain migrations must be idempotent because the `SupabaseApiAdapter`
  sends statements in autocommit mode without true per-migration rollback.
  Advisory locks are a no-op in the adapter; concurrent runs are safe via
  `ON CONFLICT DO NOTHING` only.
- Orun does not currently express environment-scoped `dependsOn` edges. The
  `db` component cannot safely depend on `db-tests` while `db` subscribes to
  `dev`/`stage`/`prod` and `db-tests` subscribes only to `dev`; proposal
  `ai/proposals/task-0007.1-spec-update.md` is deferred.
- Ignored generated outputs from the draft exist locally (`dist`,
  `node_modules`, TypeScript build info, `.orun`, Terraform working dirs, and
  `plan.json`). They must not be staged or committed.
- Local AWS CLI credentials are unavailable in this checkout. Tasks that need
  AWS provider inspection must use CI logs, `gh`, or an authenticated role path
  and record any local access blocker clearly.
- GitHub Actions logs from run `26209010693` warn that Node.js 20 actions are
  deprecated and will move toward Node.js 24 defaults. This is not currently
  blocking, but it is a near-term CI maintenance item.
- The deploy trust subject from Task 0004 is
  `repo:sourceplane/multi-tenant-saas:environment:production`. This repo still
  has no GitHub environments configured, so the deploy-role trust path remains
  unexercised end-to-end.
- The orphaned R2 bucket `sourceplane-tf-state` and historical Hyperdrive
  adoption scaffold from Task 0002 remain live historical resources and are not
  owned by current repo source.
- Dead `dryRunCommand` and `deployCommand` parameters in
  `apps/api-edge/component.yaml` and `apps/identity-worker/component.yaml` point
  to `--env prod` but are overridden by the composition template. Non-blocking;
  recommend cleanup.
- Root `README.md` is stale: it still says Cloudflare Workers, Hyperdrive, and
  live migration apply are not implemented. Trust compact context/code reality
  until a bounded docs cleanup task updates it.
- Tests in `tests/identity-worker` re-implement auth service logic rather than
  importing from Worker source. Low risk since live deployment proves behavior,
  but a future maintenance task should improve import structure.
- Membership child tables do not have foreign keys to `membership.organizations`.
  Referential integrity is enforced at the application layer (CTE dependency chain
  in bootstrap, repository adapter write ordering). Acceptable for autocommit-safe
  bounded-context persistence. Revisit if integrity gaps appear.
- Base `SqlExecutor` remains execute-only for repository compatibility, while
  Task 0024 added `TransactionalSqlExecutor` for runtime paths that need
  multi-statement atomicity. Future event-emitting mutations should use the
  transaction-capable executor pattern.
- Task 0016 first-deployment ordering: `api-edge-prod` deploy failed initially
  because `membership-worker-prod` did not exist yet. Resolved on retry.
  One-time issue; future deploys are safe because the named Worker now exists.
  For future new service binding targets, consider an Orun `dependsOn` edge or
  accept the one-time retry pattern.
- policy-worker intentionally has no public route, so post-deploy verification
  is limited to Cloudflare deployment metadata and workers.dev-disabled checks
  until a same-environment service-binding caller exists.
- A future filtered "my projects" or project-assignment list needs a separate
  contract; project-scoped roles alone do not authorize the current org-wide
  project list.
- The repo now has a durable events/audit persistence seam (Task 0023).
  Invitation lifecycle, organization bootstrap, and current project/environment
  create/archive event wiring are complete. Identity security events and future
  destructive mutations still need event/audit coverage as they are exposed.
- Identity security-event implementation remains a near-term roadmap gap after
  the web-console work. The scope decision is settled: pre-organization identity
  activity uses identity-owned user-scoped security-event records; organization
  audit history remains org-scoped with required `org_id`; identity emits normal
  org-scoped audit/event copies only when organization context exists.
- The current Task 0040 console is one Pages project with a stage/prod target
  selector. Human direction now requires two separate console deployments with
  different URLs, one stage-bound and one prod-bound. Task 0041 is scoped to
  split the Pages deployments and make CORS environment-aware.
- Durable idempotency for invitation creation is not implemented. As of Task 0094
  the api-edge layer validates a present `Idempotency-Key` header (Stripe-style:
  ASCII printable, ≤255 chars, non-empty after trim) and rejects malformed
  values with HTTP 400 `validation_failed` before forwarding to a worker — but
  there is still no replay store, so a duplicate POST with a *valid* key still
  produces multiple pending invitations. Durable replay (likely Cloudflare KV
  keyed on `(orgId, idempotencyKey, route)`) is scoped as Task 0095 and will
  import `parseIdempotencyKey` from `@saas/contracts/idempotency`. Required-key
  enforcement on specific routes is deferred to the B4 SDK rollout.
- Duplicate pending invitations to the same email are allowed by the current
  schema (no uniqueness constraint on email_lower + org_id + status). Consider
  adding uniqueness enforcement in a future task if this causes user confusion.
- Cursor pagination uses standard base64 (`btoa`). The JSON payload structure
  does not produce `+` or `/` for valid timestamps and UUIDs, but a future task
  could switch to base64url for extra URL-safety robustness.
- No composite index on `(created_at, id)` for membership tables. Acceptable at
  current data volumes; add before high-cardinality organizations.
- Per-member role lookup in member-list is still N+1 within a page (max 100).
  Acceptable at current scale; batch/join optimization deferred.

## Resolved Risks

- Task 0008 is complete. The migration runner is operational. The
  `_migrations.applied` table is bootstrapped in `stage` and `prod` via
  post-merge CI run `26229865114`.
- Task 0009 is complete. Hyperdrive infrastructure is applied and stable in
  `stage` and `prod`.
- Orun `v2.3.0` spec drift is resolved. Active specs now reference `v2.3.0` as
  the verified runtime baseline via Task 0009.1.
- Task 0013 UUID/public-ID mismatch is resolved. The Worker generates proper
  UUIDs for database storage and maps to/from prefixed public IDs at the API
  boundary. Live stage auth flow confirmed correct UUID persistence.
- Task 0013 prod debug-delivery boundary is verified. Prod `DEBUG_DELIVERY=false`
  is enforced; live prod `/v1/auth/login/start` returns no raw code.
- Task 0014 api-edge auth facade is deployed. `api-edge` now routes `/v1/auth/*`
  to identity-worker via service bindings. Live stage/prod auth flow through
  api-edge proven; prod returns no debug code through the facade.
- Task 0015 `bootstrapOrganization` atomicity resolved via CTE-based single
  statement. `acceptInvitation` expiry race resolved via pre-validation + CTE
  with expires_at guard.
- Task 0017 policy scope escalation risk resolved before merge: project and
  environment actions now require explicit `resource.projectId`, and malformed
  or unknown membership facts are ignored safely.
- Task 0017 policy-worker public exposure risk resolved before merge and
  verified after deployment: stage/prod use `workers_dev: false`, have no public
  deploy target, and direct workers.dev access returns Cloudflare error 1042.
- Task 0017/0018 policy-caller gap resolved for current read paths:
  organization read and member list now authorize through policy-worker via
  same-environment service bindings.
- Task 0022 resolved the invitation acceptance role-assignment gap. Acceptance
  now marks the invitation accepted, creates the member, and creates the
  organization-scoped role assignment atomically before exposing the accept route
  through api-edge.
- Task 0023 resolved the missing events/audit persistence gap. The
  `appendEventWithAudit` UNION ALL column mismatch was fixed by the verifier
  before merge (replaced with `row_to_json` approach). Migration
  `030_events_audit_core` applied to stage and prod via CI run `26379294370`.
- Task 0025 resolved the local db-tests module-resolution gap. PR #66 added
  `@saas/db/membership` and `@saas/db/events` path aliases to
  `tests/db/tsconfig.json`; post-merge CI run `26382162480` passed.
- Task 0026 resolved invitation lifecycle event/audit coverage. PR #67 wired
  `invite.created` and `invite.accepted` atomically with create/accept, joining
  Task 0024's `invite.revoked` coverage. Post-merge CI run `26383797222`
  passed.
- Task 0027 resolved member-admin mutation coverage. PR #68 added policy-gated
  role update and member removal with last-owner protection, stale role cleanup,
  and atomic `membership.updated` / `membership.removed` event/audit writes.
  Verifier fixes prevented ignored role-cleanup failures from committing partial
  mutations. Post-merge CI run `26385774244` passed.
- Task 0028 resolved the projects/environments persistence foundation. PR #69
  added contracts, migration `040_projects_core`, and `@saas/db/projects` with
  tenant-scoped project/environment repository methods. The verifier added a
  composite FK `(org_id, project_id) REFERENCES projects.projects (org_id, id)`
  to prevent cross-org environment rows.
- Task 0029 resolved the db-migrate changed-plan gap. PR #70 replaced
  `spec.paths` with `spec.path` for the `db-migrate` component, preserved the
  stage/prod `Migration Apply` merge path, and post-merge main CI run
  `26389807233` confirmed `040_projects_core` applied on both live Supabase
  projects.
- Task 0030 resolved the non-membership policy-context gap. PR #71 added
  `POST /v1/internal/membership/authorization-context` and a shared
  `mapRoleAssignmentsToFacts` helper. The verifier fixed a malformed
  project-scope mapping bug so missing `scopeRef` cannot widen into
  organization-scoped facts. Post-merge CI run `26392905135` passed.
- Task 0031 resolved the first projects runtime gap. PR #72 added private
  `apps/projects-worker`, public project create/get through api-edge,
  membership authorization-context plus policy-worker authorization, and atomic
  `project.created` event/audit writes. Verifier commit `1944979` added missing
  api-edge facade tests and the implementer report before merge. Post-merge CI
  run `26409923288` passed.
- Task 0032 resolved the public project-list gap. PR #73 added org-scoped
  `project.list`, `GET /v1/organizations/{orgId}/projects`, cursor pagination,
  api-edge forwarding, and focused policy/projects/api-edge tests. Verifier
  commit `4eff29a` added the missing implementer report before merge.
  Post-merge CI run `26411761006` passed.
- Task 0033 resolved the public project-archive gap. PR #74 added
  `DELETE /v1/organizations/{orgId}/projects/{projectId}`, used existing
  `project.delete` authorization, soft-archived via `archiveProject`, and wrote
  `project.archived` event/audit atomically. Verifier commit `fe4b427` added
  the missing implementer report before merge. Post-merge CI run `26413213117`
  passed.
- Task 0034 resolved the public environment create/list/get gap. PR #75 added
  `POST /v1/organizations/{orgId}/projects/{projectId}/environments`,
  `GET /v1/organizations/{orgId}/projects/{projectId}/environments`, and
  `GET /v1/organizations/{orgId}/projects/{projectId}/environments/{environmentId}`;
  used project-scoped `environment.create` and `environment.read`; enforced
  active parent project checks; and wrote `environment.created` event/audit
  atomically. Verifier commit `83831f3` added the missing implementer report
  before merge. Post-merge CI runs `26432854069` and `26432938193` passed.
- Task 0035 resolved the public environment-archive gap. PR #76 added
  `DELETE /v1/organizations/{orgId}/projects/{projectId}/environments/{environmentId}`
  under explicit `orgId + projectId + environmentId`, with
  `environment.archived` event/audit wiring for the archive mutation.
- Task 0036 resolved the first public audit-list gap. PR #77 added private
  events-worker, `GET /v1/organizations/{orgId}/audit`, `audit.read` policy,
  category filtering, cursor pagination, public ID mapping, and payload
  redaction.
- Task 0037 resolved the membership audit raw/public ID mismatch. PR #78
  normalized invitation/member audit canonical IDs to raw UUIDs and kept legacy
  public `org_` rows queryable without a backfill.
- Task 0038 resolved organization-bootstrap audit coverage. PR #79 wired
  `organization.created` and initial `membership.added` event/audit rows
  atomically with membership-worker organization bootstrap.
- Task 0039 resolved stale organization-service cleanup. PR #80 removed dead
  `createOrganization` and `listOrganizations` methods from the service after
  Task 0038 moved these into handler-level implementations. Tests retargeted
  to use `repo.bootstrapOrganization` directly for getOrganization coverage.

## Watch Items

- Keep `.github/workflows/ci.yml` Orun-only.
- Verify that local `kiox -- orun ...` behavior and GitHub Actions behavior use
  the same rendered plan.
- Keep reusable SaaS starter work separate from product-specific `specs-v2`
  work.
- Any live AWS, Cloudflare, Supabase, S3, Secrets Manager, or Hyperdrive
  mutation must be independently verified by the verifier before merge.
