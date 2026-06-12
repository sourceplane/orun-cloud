# saas-bootstrap-factory — risks and open questions

Status: Draft. Decision points below are resolved by recording the choice in
`ai/context/decisions.md` and updating this file; human-blocked items follow
the deferred-decision protocol in `agents/orchestrator.md`.

## Decision points (agent-resolvable unless noted)

| # | Decision | Options | Leaning | Owner |
|---|----------|---------|---------|-------|
| D1 | Generic Hyperdrive binding name (BF4) | `PLATFORM_DB` / `DB` / `APP_DB` | **Resolved: `PLATFORM_DB`** (shipped in BF4) | resolved |
| D2 | Wiring manifest store (BF5) | Secrets Manager / SSM Parameter Store | **Resolved: Secrets Manager** (shipped in BF5) | resolved |
| D3 | Wiring write granularity (BF5) | one doc per env vs `wiring/<env>/<component>` | **Resolved: per-component, at each component's conventional `<org>/<repo>/<component>/<env>` path** — matches the documented secret convention and IAM scope; assembled at read time | resolved |
| D4 | Package scope on instantiation (BF12) | keep `@saas/` / rename to `@<scope>/` | **keep `@saas/` as default** — it is already product-neutral; rename stays available as a deterministic map for users who insist | recorded default |
| D5 | `wrangler.jsonc` rendered file handling (BF6) | gitignore rendered file / commit fixture-rendered copy | **Resolved: gitignored rendered output + committed template/fixture** (api-edge pilot) | resolved |
| D6 | Golden repo composition source (BF10) | stay `kind: dir` / switch to OCI | stay `dir` (dogfooding decision already recorded); instances pin OCI | confirmed |
| D7 | `aws-admin` ownership for this instance (BF8) | foundation absorbs / aws-admin remains owner | aws-admin remains owner here; foundation is for fresh accounts | **human confirms** |
| D8 | Catalog packages as published deps (post-BF11) | publish `@saas/*` to a registry / keep monorepo-copy for v1 | keep copy for v1 instances, publish in a follow-up epic — do not block BF13 on a registry | architect |

## Risks

- **Orun cross-environment `dependsOn` limitation (BF1).** The recorded
  `db → db-tests` limitation (components subscribed to different environments)
  may also affect infra edges (e.g. supabase subscribes stage/prod only).
  Mitigation: keep edges within matching environment subscriptions; if the
  runtime rejects an edge, document the constraint and enforce ordering via
  environment promotion instead. Surface to the Orun provider team if it
  blocks.
- **Wire step availability vs PR lanes (BF6).** PR `verify` must never need
  cloud credentials. The fixture-render path (D5) is the guard; a regression
  here would break every fork's PRs. Add an explicit CI assertion that the
  verify profile excludes the live `wire` capability.
- **Fleet rollout blast radius (BF4/BF6).** Renames and wiring touch all 13
  workers. Mitigation: pilot on `api-edge`, then one mechanical PR with
  per-worker smoke verification on stage before prod approval.
- **Binding rename is config-only but deploy-ordered (BF4).** ~~A worker
  deployed with the new binding name before its code reads it (or vice versa)
  500s.~~ Resolved without an alias period: a Worker's binding config and code
  bundle ship in one atomic `wrangler deploy`, so config/code skew within a
  worker cannot occur (BF4 as-built; see `ai/context/decisions.md`).
- **Foundation chicken-and-egg (BF8).** First apply needs credentials and
  local state. The state-migration step is the riskiest manual moment of the
  whole epic; it must be a written, rehearsed procedure (scratch account in
  BF13 is the rehearsal).
- **Idempotence test brittleness (BF12).** The "blueprint reproduces this
  repo" test will fail on every legitimate refactor of a templated file.
  That is the point, but the blueprint-managed file list must be small (BF3's
  config-indirection is what keeps it small) or the test becomes a tax.
- **Drift between golden repo and instances (BF14).** 3-way merge only works
  if file ownership is respected. The conformance pack must include the
  ownership-manifest check itself, or instances will edit blueprint-owned
  files and every upgrade becomes a conflict storm.

## Consolidated human-help register

Items agents must not invent (per `specs/core/access-and-infra.md`); park and
continue per the deferred-decision protocol.

| When | Item | Needed for | One-time or per-instance |
|------|------|-----------|--------------------------|
| BF4/BF6/BF7 | Stage/prod apply approvals | `requireApproval: true` lanes | per change |
| BF7 | Registrar/DNS access | only if NS records move during v5 re-import | conditional |
| BF8 | AWS administrator credentials | first foundation apply on a fresh account | one-time per account |
| BF8 (D7) | aws-admin ownership confirmation | boundary between repos | one-time |
| BF10 | GHCR package permissions | stack release publish (likely already granted) | one-time |
| BF13 | New AWS account, Cloudflare account + zone, Supabase org + token, GitHub repo + 4 Actions secrets, domain + NS delegation | the acme rehearsal | per instance |
| BF13 | OAuth app credentials (GitHub/Google), billing products (Polar/Stripe) | enabled product surfaces on the instance | per instance |
| Pre-existing (not BF-owned) | Real auth creds (B1), email provider choice + sender domain (B2), Stripe key (B6) | golden repo's own production completeness | one-time |

The pre-existing row matters for the epic's promise: the *clone* inherits
whatever the golden repo has. Resolving B1/B2 here upgrades every future
instance for free.
