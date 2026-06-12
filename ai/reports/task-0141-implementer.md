# Task 0141 — IG3 repo links — Implementer Report

## Summary

- Platform installation-token path: App JWT → `POST /app/installations/{id}/
  access_tokens`, cached as an AES-256-GCM envelope with a 5-minute expiry
  margin (serves only the platform's own calls; brokered tenant tokens stay
  IG4). Repo browsing endpoint with substring search over up to 300 repos +
  truncation flag.
- `repo_links` CRUD: policy `project.repo_link.write` (org owner/admin +
  the project's own project_admin; project-scoped action), entitlement
  `limit.repo_links` as a quantity gate (412 `limit_reached` carrying
  currentUsage/limitValue), branch→environment maps validated against live
  environments through a new internal projects-worker seam
  (`GET /v1/internal/projects/environments` — service-binding-only).
- Drain enrichment: deliveries whose repo matches active links emit one
  event per linked project with `projectId` + the environment resolved from
  the branch map (push → branch, PR → target branch), all in the same
  transaction as the `emitted` mark; unlinked repos stay org-scoped.
- `scm.repo.linked` / `scm.repo.unlinked` emitted with project-scoped audit.
- Console project **Git** tab: searchable repo picker over the connection's
  installation, link with a suggested branch map (default branch → the
  production-looking environment), mapping badges, unlink ConfirmDialog,
  designed empty states (no connection → pointer to Settings → Integrations),
  412 → PreconditionInsight.
- SDK: listRepositories / listRepoLinks / createRepoLink / updateRepoLink /
  unlinkRepoLink. api-edge forwards the project-scoped repo-link paths to
  integrations-worker (PATCH added to the facade).

## Checks Run

`pnpm exec turbo run typecheck lint test`: 110/110. integrations-worker-tests
65 passed (repo-link validation/limit/tenancy/conflict, drain per-project
enrichment, token-cache path); policy/api-edge/console suites green.
(One pre-existing flake noted: `rate-limit-do.test.ts` org-bucket test can
exceed its 5s jest timeout under full-workspace `--force` CPU contention —
unrelated to this change, passes on normal runs.)

## Assumptions

- Repo browsing caps at 300 repositories (3 pages × 100) with a truncation
  flag; finer-grained server-side search waits for a product pull.
- Branch maps cap at 32 entries; environment validation is write-time only
  (an archived environment later leaves stale map entries resolving to it —
  IG6 reconcile territory).

## Remaining Gaps

- Live repo browsing + linking needs D1 (App secrets) and
  SECRET_ENCRYPTION_KEY on integrations-worker (same provisioning lane as
  config-worker's key).
- Branch-map EDITING UI (add/remove rows on an existing link) is minimal —
  the API supports PATCH; richer editor is IG5 polish.

## PR Number

#327
