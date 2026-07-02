# Epic: saas-secret-manager (OV8 — the platform slice of orun-secrets v3)

**The Orun Cloud implementation slice of the canonical `orun-secrets` v3
design (`orun/specs/orun-secrets/`). This epic turns the shipped write-only
secret storage in `config-worker` into a Doppler-grade secret manager: chain
inheritance over the platform scopes, append-only value versions, a
per-workspace DEK/KEK hierarchy, activated `secret.*` RBAC, the `SecretPolicy`
conditions layer, and — the keystone — the lease-bound run-scoped resolve that
finally lets a value flow to a runner, decrypted for the first time anywhere in
this codebase.**

## Status

| Field | Value |
|-------|-------|
| Status | **Draft — for review; design frozen in orun/specs/orun-secrets v3** |
| Canonical design | `orun/specs/orun-secrets/` (SEC0–SEC7); this epic owns the **[cloud]** halves of SEC1–SEC3 + the cloud parts of SEC4/SEC6/SEC7 |
| Contract | `../saas-orun-platform/state-api-contract.md` §4 (v3, revised by this work) |
| Supersedes | the dormant OP8 milestone; OV8's "deferred" placeholder in `../saas-orun-platform/` |
| Milestone prefix | **SM** (platform-side slices, mapped to SEC milestones below) |

## What already exists (build on, don't rebuild)

| Shipped capability | Where | Used for |
|---|---|---|
| Secret CRUD, write-only AES-256-GCM encryption, metadata-safe reads | `apps/config-worker` (`encryption.ts`, handlers, `070_config_settings_flags`) | the storage baseline |
| Scope-resolution chain + `overridable` guardrails (settings; "designed so secret_metadata can adopt the same shape later") | `config-resolver.ts`, `430_config_account_scope` | secret inheritance (SM1) |
| Role×scope policy engine; **dormant** `secret.read/write/value.use`; account cascade (WID6); per-action provenance (TM6b1) | `packages/policy-engine`, `apps/policy-worker`, membership `authz-facts.ts` | Layer-1 authorization (SM1/SM3) |
| Run coordination + live leases (`holder`/`leaseEpoch`/`leaseExpiresAt`), DO + relational backends | `apps/state-worker` (`run-coordinator.ts`, `coordination-native.ts`, `state.run_jobs`) | lease-bound resolve (SM3) |
| Credential-agnostic actors: sessions, `sk_` keys, CI OIDC exchange → workflow tokens | `apps/identity-worker` (`resolve-bearer.ts`, `oidc-exchange.ts`) | subjects + the server-derived platform fact |
| Atomic event + audit append | `packages/db` `appendEventWithAudit` | `secret.accessed` / `secret.denied` audit |
| Cloudflare Secrets Store entitlement (confirmed 2026-06-12) | account (saas-secrets-sync SS4) | KEK custody (SM2) |

## Known gaps this epic closes (verified against code)

1. **No decrypt path exists anywhere** — the encryption adapter is
   encrypt-only (`encryption.ts:27-29,70`). SM3 introduces the first, scoped
   to the resolve + reveal handlers.
2. **No resolve endpoint** — contract §4's resolve was never routed.
3. **Rotate destroys history** — in-place ciphertext overwrite
   (`packages/db/src/config/repository.ts:397-421`). SM1 adds
   `config.secret_versions` (append-only).
4. **No inheritance for secrets** — exact-scope only (`scope-match.ts`); the
   WID7 chain is settings-only. SM1 extends it.
5. **`secret.*` actions have no caller** — handlers use `*.config.read/write`
   (`create-secret.ts:161`). SM1 activates them.
6. **Single static encryption key** (`SECRET_ENCRYPTION_KEY`) — no DEK/KEK,
   no `keyId`, no cryptoshred unit. SM2 adds the workspace-DEK hierarchy.
7. **No `last_used_at` column** despite the contract promising it. SM1.
8. **No personal overlays, no policy conditions, no syncs provenance.**
   SM1/SM3/SM6.
9. **Env-scope mismatch** — runs carry an environment *slug*; secrets are
   scoped by `environment_id` UUID. SM3 translates at the resolve boundary.
10. **Workflow tokens can't prove lease-holding** — they bind `(org, project)`
    only. SM3 verifies the live lease independently (`leaseEpoch` added to
    contract §4).

## Milestones (platform slices; [orun]-side halves live in the SEC plan)

| ID | Slice | SEC pairing |
|----|-------|-------------|
| SM1 | Store v3: `secret_versions`, chain scopes for secrets (+ guardrails, personal rows, `last_used_at`), `secret.*` RBAC activation, import/versions routes | SEC1 |
| SM2 | Key hierarchy: `keyId` envelopes (`v:2`), per-workspace DEKs, KEK in Secrets Store, `k0` lazy migration | SEC1 |
| SM3 | The resolve: exported `verifyLiveLease` (both backends), state-worker route, service binding to config-worker internal resolve, Layer-2 `SecretPolicy` evaluation, first decrypt path, `secret.accessed` | SEC2 + SEC3 |
| SM4 | Catalog joins: chain/`servesFrom` metadata for the facet resolver | SEC4 |
| SM5 | Syncs provenance: `config.secret_syncs` + routes; provisioned-entity stamps | SEC6 |
| SM6 | Console + break-glass + rotation cron (over `rotation_policy`/`expires_at`) + scorecard live-plane booleans | SEC7 |

Details in `implementation-plan.md`.

## Boundary notes

- **This epic is the customer-facing secret manager.** The platform's *own*
  worker deploy secrets stay on `saas-secrets-sync` (AWS SM escrow → deploy
  copies); that epic's assemble/sync/fingerprint tooling is prior art for SM5's
  materialization provenance, not a dependency.
- **config-worker owns ciphertext and policy; state-worker owns the lease.**
  The internal resolve seam is a service binding, unreachable through api-edge;
  config-worker re-checks policy itself (the lease check is additive — defense
  in depth, not delegation).
- **No new identity, no new tokens.** Doppler-style service tokens are `sk_`
  service principals + a pinning `SecretPolicy` (orun-secrets SD-19).
