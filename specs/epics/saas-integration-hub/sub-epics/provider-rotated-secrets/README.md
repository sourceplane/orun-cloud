# Sub-epic: provider-rotated-secrets

**Status:** Draft — proposed. Extends the Cloudflare adapter (IH5) and the
brokered-credentials model (IH7) with a **proven, stored-and-rotated**
alternative to dynamic mint-at-resolve.
**Parent:** `saas-integration-hub` (IH4 broker core, IH5 Cloudflare adapter, IH7 brokered credentials)
**Owner(s):** config-worker (secrets, rotation cron), integrations-worker (mint, revoke), console, `orun` CLI (`orun secrets`)
**Milestone prefix:** **RS** (RS0–RS4)

## Problem

IH7 delivers Cloudflare credentials as **brokered** secrets: no stored value,
the token is minted just-in-time inside the SM3 lease-bound resolve
(`source: 'brokered'`, migration `820_config_brokered_secrets`;
`apps/config-worker/src/handlers/internal-resolve-secrets.ts`). That is the
Vault dynamic-secrets model, and it is the strongest posture for a short-lived,
per-run credential.

Two things make it a poor **default** for Cloudflare specifically:

1. **The pattern is little-proven for Cloudflare.** Dynamic minting of scoped
   Cloudflare API tokens exists in the wild only as an abandoned community Vault
   plugin (`bloominlabs/vault-plugin-secrets-cloudflare`, 6★, last release 2022).
   The generic Vault model is battle-tested; the Cloudflare instantiation is not.
   Stored-secret **+ scheduled rotation**, by contrast, is the mainstream,
   battle-tested shape (AWS Secrets Manager rotation, Doppler, GCP, Azure).
2. **Brokered is resolve-only, so it cannot serve a long-lived consumer.** A
   deployed Worker (or any running app) that must hold a Cloudflare token at
   runtime has no lease to mint under — mint-at-resolve structurally cannot feed
   it (the SigV4/latency anti-goal in `saas-secrets-sync` forbids fetch-at-edge).
   Brokered credentials are explicitly resolve-only in v1 (integration-hub
   README, "brokered = resolve-only").

There is also an availability cost (risk **R3**): mint-at-resolve puts a
third-party API call on the run critical path, fail-closed. A Cloudflare
outage or rate-limit fails the deploy.

## Design principle

**A rotated provider secret is an ordinary versioned secret whose _value
producer_ is the credential broker and whose _rotation_ is scheduled — not
lease-bound.** It reuses the shipped resolve, versioning, and rotation-cron
machinery unchanged; the only new capability is a rotation policy that mints its
next version from a connected parent credential and retires the old one safely.

Concretely, this introduces a **third flavour of the existing `source`
discriminator**, sitting beside `static` (stored, human-supplied) and `brokered`
(dynamic, mint-at-resolve):

| `source` | Value at rest | Produced by | Lifetime governed by | Serves long-lived consumers? |
|----------|---------------|-------------|----------------------|------------------------------|
| `static` | ciphertext | human | manual rotation | yes |
| **`static` + `rotation.provider`** (**this sub-epic**) | ciphertext | **broker mint** | **rotation schedule** | **yes** |
| `brokered` (IH7) | none (pointer) | broker mint | job lease (short TTL) | no |

**This is additive and non-exclusive.** IH7 brokered credentials remain the
opt-in tier for the highest-sensitivity, per-run secrets; this sub-epic makes
the proven stored-and-rotated model the **recommended default** for Cloudflare.
The same `mintCloudflareToken` code
(`apps/integrations-worker/src/providers/cloudflare.ts`) serves both — as a
**rotation producer** here, as a **resolve producer** in IH7.

## The rotation state machine (RS2 — the crux)

Rotation, not minting, is where stored-credential systems fail. The cron
executes a strict ordering with a grace overlap so no consumer is ever left
holding a revoked token:

```
mint-new  → verify → [re-deliver to long-lived consumers] → grace → revoke-old
   │           │                    │                          │         │
   │           │                    │                          │         └─ broker DELETE on the PRIOR version's providerRef;
   │           │                    │                          │            mark that version `retired`
   │           │                    │                          └─ overlap window (both tokens valid) so in-flight
   │           │                    │                             work and not-yet-redeployed consumers keep working
   │           │                    └─ Feature-2 materialize/onRotate for consumers that HOLD the value
   │           │                       (see "Consumer-shape rule" below) — skipped for resolve-per-run consumers
   │           │                    └─ append the minted token as a new `secret_versions` row (becomes current)
   │           └─ probe the new token against a cheap read scoped to its template before it becomes current;
   │              a token that does not verify is discarded and the rotation fails WITHOUT retiring the old one
   └─ broker mint from the parent credential (same path as IH7), named
      `orun/{org}/{template}/{mintId}` for the IH9 orphan sweep
```

**Failure is non-destructive:** any step failing before `revoke-old` leaves the
prior version current and valid; the rotation is retried next tick and surfaced
on connection/secret health. `revoke-old` is best-effort with the token's own
`expires_on` (if templated) as backstop, and reconciled by the IH9 orphan sweep
(`sub-epics/brokered-orphan-safety` is prior art for the health projection).

## Consumer-shape rule (and the honest Feature-2 boundary)

Whether rotation stays inside the secret manager or must **push** the new value
depends entirely on the consumer:

- **Per-run jobs** (a deploy step that resolves a Cloudflare token for the
  duration of the run): each run reads the current version. Rotation is fully
  contained — **never touches the write-to-Worker path.**
- **Long-lived deployed apps** (a Worker holding a Cloudflare token at runtime):
  the running app holds the *old* value, so rotation **must re-deliver the new
  version before revoking the old** — and that re-delivery is materialization
  (orun-secrets SD-13 / `secret_syncs`, the "Feature 2" write-to-Worker path).
  There is no way around it: a stored secret inside a running app must be pushed
  on rotation.

RS declares this explicitly rather than hiding it: a rotated secret carries an
optional `deliver_on_rotate` binding (a materialize target). When set, RS2's
`re-deliver` step runs the existing materialize adapter inside the grace window;
when unset (pure per-run consumer), the step is skipped. **RS does not build new
delivery** — it reuses `internal/materialize` from the runner where a target is
declared, and stays delivery-free otherwise.

## Milestones (RS0–RS4)

| ID | Milestone | Depends on | Human help? |
|----|-----------|------------|-------------|
| **RS0** | **Model:** extend the `source`/binding facts (820) with a `rotation` policy JSON (`{provider, connectionId, template, params, interval, grace, deliverOnRotate?}`); resolve path unchanged (a rotated secret reads exactly like `static`); consistency + validation tests | 820, IH5 mint | No |
| **RS1** | **Create-from-parent:** `orun secrets set --from-broker cloudflare/<template>` and the console equivalent — one deliberate mint from the connected parent, stored as version 1; the mint uses IH5's adapter; the parent connection must be `usable` | RS0, IH5 | No |
| **RS2** | **Rotation engine:** the `mint→verify→[re-deliver]→grace→revoke` cron over `rotation_policy`/`expires_at` (SM6 groundwork); non-destructive failure; append-only versions; health surfacing (reuse orphan-safety projection) | RS0, RS1, SM6 | No |
| **RS3** | **Parent rotation + break-glass:** rotate the *parent* credential too (prior art: the bloominlabs plugin's `config/rotate-root`); near-expiry detection → re-connect prompt; a rotation that fails N times raises a health alert, never a silent stall | RS2, R1 custody | No |
| **RS4** | **Console + CLI surfaces:** rotation status/next-run, version history, "rotate now", and the `deliver_on_rotate` target picker in the secrets UI; `orun secrets rotate <key> [--now]` | RS2 | No |

## Data model (additive; no new value store)

- **Reuse** `config.secret_versions` (append-only) for every rotation — a
  rotation is a new version, exactly like a manual `rotate-secret`. No secret
  value lands anywhere new.
- **Extend** the `820` binding facts (already `source`/`binding_*`) with a
  display-only `rotation_*` projection so list/chain reads render
  "rotated · cloudflare · workers-deploy · every 30d" without decrypting.
- **Reuse** the mint ledger (`integrations.minted_credentials`) — each rotation
  mint is ledgered identically to an IH7 mint; `purpose` distinguishes
  `rotation` from `secret_resolve`.
- **No schema change to the resolve path.** A rotated secret's current version is
  a normal ciphertext; `internal-resolve-secrets` decrypts it with zero
  awareness of rotation.

## What this reuses (build on, don't rebuild)

| Shipped / in-epic | Where | Used for |
|---|---|---|
| Cloudflare scoped-token mint | `providers/cloudflare.ts` (`mintCloudflareToken`) | the rotation **producer** |
| Append-only versions + rotate handler | `config.secret_versions`, `rotate-secret.ts` | every rotation is a new version |
| Rotation cron over `rotation_policy`/`expires_at` | saas-secret-manager SM6 | RS2 scheduler |
| Envelope encrypt/decrypt + DEK/KEK | `encryption.ts` (+ SM2 when it lands) | value at rest |
| Materialize adapter + `secret_syncs` | `internal/materialize`, migration 510 | `deliver_on_rotate` (long-lived consumers only) |
| Orphaned-credential health projection | `sub-epics/brokered-orphan-safety` | rotation/connection health |
| Mint ledger + revocation + orphan sweep | IH4 / IH9 | ledger parity, safe revoke, reconciliation |

## Trade-offs (honest)

**Gained:** a proven pattern; off the run critical path (kills R3 for these
secrets); no lease-TTL mid-use revocation trap; bounded, deterministic
provider-side token count (one live + one grace, vs one-per-resolve — shrinks
R4); serves long-lived consumers that brokered structurally cannot; a familiar
"it's a secret, it rotates" UX.

**Given up / to watch:** a **longer breach window** — a stored token lives for
the rotation interval (days) rather than ≤1h, so the value is exposed longer
than a brokered mint (accept per-secret; keep brokered as the opt-in tier for
crown-jewel secrets). **Rotation is now the hard part**, and the
propagation-to-consumers step re-couples long-lived consumers to the write-to-
Worker path (see Consumer-shape rule). Parent custody (**R1**) is unchanged — a
mint-capable parent token is still the highest-value per-tenant secret.

## Decisions & open questions (RS-D#)

| # | Decision / question | Default recommendation |
|---|---|---|
| **RS-D1** | Is stored-and-rotated the **default**, with brokered opt-in? | **Yes.** Default `static`+rotation for Cloudflare; `brokered` an explicit opt-in tier for per-run, high-sensitivity secrets. |
| **RS-D2** | Default rotation interval and grace window? | 30-day interval, 24h grace overlap; both per-secret overridable; ceiling honored against the template's own `expires_on` if set. |
| **RS-D3** | Does a rotation with a `deliver_on_rotate` target **block** on delivery success before revoking the old value? | **Yes — fail-closed:** never revoke the old token until the new one is delivered *and* verified; a failed delivery aborts the rotation, keeping the old value current. |
| **RS-D4** | Verify step: what probe proves a minted token is good before it becomes current? | A cheap read scoped to the template (e.g. `GET /accounts/{id}` for `account-settings.read`); a token that fails the probe is discarded and the rotation fails without retiring the old one. |
| **RS-D5** | Parent-token rotation (RS3): automated or operator-driven? | Automated where the connect posture allows (OAuth refresh; token-paste surfaces a re-connect prompt near expiry). Never let a silent parent expiry fail all rotations — raise health first. |
| **RS-D6** | Plan/entitlement placement? | Fold under the existing `feature.integrations.credential_broker` entitlement; add `limit.rotated_secrets`. Confirm in the same catalog lane as IH's D7. |

## Non-goals

- **Not replacing IH7.** Brokered/dynamic stays as the opt-in short-TTL tier.
- **Not building a new delivery mechanism.** Long-lived-consumer propagation
  reuses `internal/materialize`; there is no new write path here.
- **Not changing the resolve wire shape or the `orun` CLI resolve flow.** A
  rotated secret resolves like any `static` secret.
- **Not reducing parent-custody risk (R1).** Out of scope; owned by IH0/IH5 and
  SM2's DEK/KEK adoption.
