# Task 0142 — IG4 token broker — Implementer Report

## Summary

- Broker endpoint `POST /v1/organizations/{orgId}/integrations/github/token`:
  policy `organization.integration.token.issue` (owner/admin; service
  principals via role assignment — D3 default), entitlement
  `feature.integrations.github`, body caps (≤20 repos, ≤10 permissions).
  Every requested repo must match an ACTIVE repo link in the org and all on
  one connection; requested permissions are checked ⊆ the App grant snapshot
  (deny-by-default, write needs granted write). Mint: App JWT →
  `POST /app/installations/{id}/access_tokens` with `repository_ids` +
  `permissions` — GitHub scopes the token down; TTL ≤ 1h; returned exactly
  once, never cached (test proves no installation_tokens write), never
  logged.
- `integration.token.issued` event+audit carrying actor, repos, permissions —
  test proves the token string is absent from every persisted parameter.
- SDK `integrations.issueGithubToken`; CLI `sourceplane integrations github
  token --repos=… --permissions=key:level,…`.
- `apps/integrations-worker/README.md`: the "act on GitHub from your
  product" octokit recipe + the react-to-`scm.*` recipe, in the
  webhook-verifier README style.
- Test hardening: 30s timeouts on the RSA-keygen beforeAll hooks (they can
  exceed jest's 5s default under full-workspace parallelism).

## Checks Run

`TZ=UTC pnpm exec turbo run typecheck lint test`: 110/110. Broker suite
covers grant-subset matrix, unlinked-repo denial, policy denial, body
validation, scoped mint body, token-free audit. Known pre-existing flake
(audit-timeline.test.ts is timezone-dependent, from #319) flagged as a
separate task — passes under UTC/CI.

## Remaining Gaps

- Live mint requires D1. The optional check-run/deployment proxy (IG4
  stretch) deliberately not built — the broker is the contract.

## PR Number

#TBD
