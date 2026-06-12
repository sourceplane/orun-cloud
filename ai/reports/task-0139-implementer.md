# Task 0139 — IG1 connect flow end-to-end — Implementer Report

## Summary

- integrations-worker grew the full connect machinery: signed single-use
  connect state (HMAC-SHA256, nonce hash persisted on the pending row, 10-min
  TTL, consume-on-use), provider registry + GitHub adapter (install URL, RS256
  App JWT, installation fetch/verify, best-effort uninstall, raw-body inbound
  HMAC verifier ready for IG2), connect/list/get/revoke handlers
  (policy + entitlement gated), and the `/ingress/github/setup` callback that
  binds `installation_id ↔ org_id` only via our state — unsolicited or
  unverifiable installs are recorded as orphaned (`connection_id NULL`),
  never auto-bound.
- api-edge: `integrations-facade` (authenticated org routes, new
  `integrations` rate-limit family, idempotency-replay aware) + the public
  allowlisted GET `/ingress/github/setup` forward (no resolveActor, IP-keyed
  rate limit); `INTEGRATIONS_WORKER` service binding on stage/prod;
  component dependency added.
- Governance: policy-engine learned `organization.integration.read|connect|
  manage` (owner/admin write, viewer+ read); billing-worker allowlists
  `integrations-worker` on the entitlement seam and carries the D4
  default-recommendation entitlements (`feature.integrations.github`,
  `limit.repo_links = 1`) until the catalog overrides them.
- SDK `client.integrations` (list/get/connectGithub/revoke); console
  Settings → Integrations page (GitHub card, popup connect with poll-until-
  active, status rows, revoke ConfirmDialog, designed empty state, 412 →
  PreconditionInsight upgrade UX) + nav entry.
- Live path parks cleanly on D1: with App secrets unset the connect endpoint
  returns 412 `{reason: not_configured, gate: github_app_registration}` and
  the console renders the designed insight.

## Files Changed

apps/integrations-worker (state, github-app, providers/*, clients, handlers,
router), apps/api-edge (facade, env, rate-limit, index, wrangler,
component.yaml), packages/policy-engine, apps/billing-worker (router,
check-entitlement), packages/sdk, apps/web-console-next (nav, sidebar icon,
query-keys, integrations page + view-model), packages/contracts (doc-only),
tests/{integrations-worker,api-edge,web-console-next,policy-engine}, ai/.

## Checks Run

- `pnpm exec turbo run typecheck lint test` (full workspace): 110/110 tasks.
  integrations-worker-tests 35 passed (R1 plan: replay, expiry, tamper,
  cross-org redemption, unsolicited install, bound-installation no-flip),
  api-edge-tests + policy-engine-tests + web-console-next-tests green.

## Assumptions

- GitHub App private key is provided as PKCS#8 PEM (GitHub downloads PKCS#1;
  conversion documented in the D1 runbook note in github-app.ts).
- D4 defaults (Free includes GitHub integration, 1 repo link) follow the
  epic's recommendation; catalog rows override without code changes.

## Spec Proposals

`components/01-edge-api.md` ingress rules to be added when IG2 lands the
webhook path (setup ingress documented in 17-integrations.md already).

## Remaining Gaps

- Live stage walkthrough blocked on D1 (App registration per environment).
- GitHub-side uninstall → platform revoke convergence arrives with IG2.

## PR Number

#314
