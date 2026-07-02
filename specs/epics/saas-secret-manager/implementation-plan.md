# Implementation plan — saas-secret-manager (SM1 → SM6)

> Platform slices of `orun/specs/orun-secrets/` v3 (SEC0–SEC7). Each slice
> lands behind tests and is independently useful; the leak-prevention ordering
> holds — no decrypt path exists until the lease-verified resolve (SM3) that
> uses it. Schema references: `orun/specs/orun-secrets/data-model.md` §7–8.

## SM1 — Store v3 (pairs SEC1)

- **Migration `4xx_config_secret_manager`** (extends 070/430 pattern):
  - `config.secret_versions` — append-only `(secret_id, version)` ciphertext
    history; `status IN ('active','revoked')`. Backfill: copy each existing
    row's live envelope as its current version.
  - `config.secret_metadata` widening: `personal_owner UUID` (environment
    scope only), `overridable BOOLEAN DEFAULT true` (lockable only at
    account/organization scope — mirror `430`'s CHECK), `last_used_at
    TIMESTAMPTZ`; widen `scope_kind` CHECK to admit `'account'`; extend the
    unique scope-key index with `COALESCE(personal_owner, zero-uuid)`.
- **Repository:** `rotateSecretMetadata` appends to `secret_versions` + bumps
  the head — stop overwriting ciphertext in place
  (`repository.ts:397-421`). New: `listSecretChain`, `getVersionEnvelope`,
  `revokeVersion`.
- **Chain resolution:** extend `config-resolver.ts` to `secret_metadata`
  (metadata plane only — no values), per its own reservation note; add
  `GET …/config/secrets?chain=true`; enforce the locked-key write rejection
  (the `create-setting.ts:189-190` 409 pattern) for account/workspace-locked
  secrets.
- **RBAC activation:** secret handlers switch `*.config.read/write` →
  `secret.read`/`secret.write` (`create-secret.ts:161` et al.); add
  `secret.reveal` to `ALL_KNOWN_ACTIONS` + role matrices (owner/admin only).
  Permission-diff audit in the PR description.
- **Routes:** `POST …/config/secrets/import` (dotenv bulk, write-only),
  `GET …/config/secrets/{id}/versions`; api-edge `config-facade.ts` regex
  widened accordingly.
- Tests: chain precedence (env > project > workspace > account), guardrail
  409s, personal-row uniqueness, version append-on-rotate, RBAC action switch.

## SM2 — Key hierarchy (pairs SEC1; independent of SM1 ordering)

- Envelope `v:2` with `keyId`; `config.secret_deks` table (wrapped DEK per
  `(org_id, generation)`, `state IN ('active','retiring','shredded')`).
- KEK as a config-worker **Cloudflare Secrets Store** binding (entitlement
  confirmed — SS4); wrap/unwrap helpers; DEK generation lifecycle
  (create-on-first-write per workspace).
- Decrypt-capable import (`["decrypt"]`) ships **dormant** — exercised only by
  unit tests until SM3 routes exist. Reads accept `v:1` (implicit `k0` under
  `SECRET_ENCRYPTION_KEY`) and `v:2`; all writes produce `v:2`.
- Metric: % envelopes on workspace DEKs (drives the `k0` retirement date —
  orun-secrets R-13).

## SM3 — The resolve (pairs SEC2 + SEC3; the keystone)

- **`SecretPolicy` storage + evaluation (SEC2 half):**
  `config.secret_policies` (tier-tagged JSONB, idempotent by
  `document_hash`); `PUT …/config/secret-policies`;
  `POST …/config/secret-policies/evaluate` (dry-run, both layers reported).
  Layer-2 evaluator as a pure library (`packages/secret-policy` or in-worker
  lib): locked predicate vocabulary, protected-env activation, deny-wins,
  most-specific-wins (orun-secrets `policy-model.md` §5).
- **Lease verification (state-worker):** export
  `verifyLiveLease(runId, jobId, runnerId, leaseEpoch)` covering the DO fold
  (`phase == "claimed" && holder == runnerId && leaseEpoch match &&
  leaseExpiresAt > now` — `run-coordinator.ts:288,308`) **and** the relational
  `state.run_jobs` row (Q-10: both from day one).
- **Route:** `POST …/state/runs/{runId}/secrets/resolve` in state-worker
  (`router.ts` + coordination gate pattern): bearer authz (workflow binding or
  policy, as `authorizeRun`) + `verifyLiveLease` → translate the run's
  environment slug → `environment_id` (projects-worker,
  `ensureEnvironmentRegistered` pattern) → **service binding** to
  config-worker `POST /v1/internal/config/secrets/resolve` carrying the
  verified actor + run/trigger facts.
- **config-worker internal resolve:** Layer-1 `secret.value.use` via
  policy-worker → Layer-2 conditions → chain walk per ref (personal rung only
  when the server-derived platform fact is `local-cli` and
  `personal_owner == subject`) → DEK unwrap → decrypt → `last_used_at` stamp →
  `secret.accessed` per key (new event-type constant) via
  `appendEventWithAudit` → `{secrets, resolved[], ttlSeconds: 300}`.
  Denials: typed reason codes + `secret.denied` audit.
- **Contract:** §4 v3 (already revised) — `leaseEpoch` in the body,
  `resolved[]` provenance in the response; orun re-vendors + CHECKSUM.
- Tests: lease races (stale epoch ⇒ 409), platform-fact gating of personal
  rows, protected-env deny-by-default, decision provenance (`via` +
  `ruleId`), no-value-in-audit assertions, both coordination backends.

## SM4 — Catalog joins (pairs SEC4)

- Chain metadata (`servesFrom`, guardrail flags, rotation age) exposed on
  `GET …/config/secrets` for the orun catalog resolver's live plane; no new
  routes beyond `?chain=true` (SM1).

## SM5 — Syncs provenance (pairs SEC6)

- `config.secret_syncs` (`{secret_id, version, target, entity_ref, run_id,
  status}`); `POST/GET …/config/secrets/syncs`; `superseded`/`orphaned`
  lifecycle transitions; `secret.sync.recorded` events.
- Prior art: `tooling/secrets-sync` fingerprint records — same
  "what was pushed where, at which version" bookkeeping, productized.

## SM6 — Console, break-glass, rotation cron (pairs SEC7)

- `POST …/config/secrets/{id}/reveal`: elevated `secret.reveal`, mandatory
  reason, `secret.revealed` alert event.
- web-console-next surfaces: secrets chain view (scopes, locks, shadowing,
  last-used), policy tiers + test matrix, per-entity facet, audit stream,
  access explainer (Layer-1 roles × Layer-2 rules).
- Rotation cron: a state-worker scheduled pass (the write-back cron plane)
  over `rotation_policy`/`expires_at` → expiry events → console +
  notifications-worker.
- Scorecard live-plane booleans (`rotationWithin90d`, `guardrailViolations`)
  computed at facet-join time.

## Invariant tests carried at every slice

- No plaintext or envelope in any API response except the resolve/reveal
  bodies; `SECRET_METADATA_SAFE_COLUMNS` discipline everywhere.
- No decrypt import outside the resolve/reveal handlers (lint rule).
- Audit rows are key-name-only; event payload schema forbids `value`.
- Chain and guardrail semantics identical to the settings resolver's
  (shared test fixtures where practical).
