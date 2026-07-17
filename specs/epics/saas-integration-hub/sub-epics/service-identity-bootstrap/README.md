# Service-identity bootstrap: OAuth establishes trust, service identities operate

**Status:** Shipped — SI1–SI6 landed (#490, #492, #493, #494, #495, SI6 PR).
Redirects the broker's custody model; supersedes the "refresh token as
durable custody" posture for Cloudflare and narrows it for Supabase (SI-D2).
Cloudflare mints can no longer be authorized by a user-derived credential,
structurally; new OAuth connects always end in a provisioned service
identity; rotation is a daily cron; the Supabase project plane serves from
org-owned custody via the custody-served `project-service-key` template.

## Problem

The broker's durable custody today is, for every OAuth-connected provider, a
**user-derived credential**: the OAuth refresh token minted from one human
admin's browser consent (`supabase_refresh_token`, `cloudflare_refresh_token`).
The connection row is org-owned, the ledger is org-owned, the policy gates are
org-owned — but the root of trust is a person:

1. **Person-tied lifetime.** If the authorizing admin leaves the provider org,
   loses access, revokes the grant, or their provider account is deactivated,
   every brokered secret bound to that connection goes `binding_unavailable`
   at resolve time. Ownership reads `Organization` in our schema but is
   effectively `Owner = the admin who clicked Connect`.
2. **Rotation-on-use is the race generator.** Supabase (and Cloudflare OAuth
   posture) rotate the refresh token on every use. The entire
   `ConnectionMintLock` DO exists to serialize that read-modify-write
   (`sub-epics/mint-serialization/`). The lock is correct — but it is
   scaffolding around a custody shape we chose, not an essential cost.
3. **A live OAuth round-trip sits on the resolve critical path.** Every
   brokered mint does `refresh → provider mint`, doubling provider calls and
   coupling run-secret resolve availability to the provider's *identity*
   plane, not just its token-issuance plane (risk R3).
4. **Identity and infrastructure credentials are conflated.** A refresh token
   is an *identity* credential (it represents a user session). What the broker
   needs day-2 is an *infrastructure* credential (org-owned, provider-side
   service identity). Secret managers that store user sessions inherit the
   consent, revocation, and multi-identity problems of an identity platform —
   a product we are deliberately not building (design §1's Doppler contrast).

GitHub — our own first broker — already avoids all four: the App
*installation* is the service identity; the admin's login was only the
consent that created it. This sub-epic makes that the rule, not the
exception.

## Model

> **User OAuth is only ever used to establish trust. Everything durable is a
> provider-side service identity owned by the organization.**

Two credential classes, made explicit in custody:

| Class | Examples | Lifetime | Stored? |
|-------|----------|----------|---------|
| **Identity** (bootstrap-only) | OAuth access/refresh tokens, PKCE verifiers | Minutes — one bootstrap window | Transiently; **deleted when provisioning completes** |
| **Infrastructure** (operating) | Cloudflare account-owned API token, GitHub App installation, Supabase project secret key | Durable; rotated on schedule by the platform | Yes — the only long-term custody |

The provider seam (design §2) gains a bootstrap capability next to `broker`:

```
provision?: {
  provisionServiceIdentity(parent)   // identity credential in → infrastructure credential out
  rotateServiceIdentity(current)     // scheduled re-issue, no human
  revokeServiceIdentity(current)     // connection revoke path
}
```

Per-provider mapping — bootstrap differs, the end state never does:

| Provider | Bootstrap (identity) | Operating credential (infrastructure) |
|----------|----------------------|----------------------------------------|
| GitHub | App install redirect | Installation → installation tokens *(already conforms — the archetype)* |
| Cloudflare | OAuth PKCE **or** token paste | **Account-owned API token** `orun/{org}/service` |
| Supabase | OAuth PKCE | Per-project secret keys; management plane stays refresh-custody (provider gap, see below) |
| AWS (IH10 dormant) | OIDC trust bootstrap | IAM role assumption |

What "**deprecating user token minting**" means precisely: no *mint* may use a
user-derived OAuth token as its parent. Minting itself (templates, TTL clamp,
ledger, both surfaces, brokered resolve) is untouched — only the parent that
authorizes it changes class. The public mint API keeps issuing short-lived
child credentials to callers; those were never the problem.

## Cloudflare design

The paste posture already proved the primitive: a durable **account-owned**
parent token minting scoped children via `POST /accounts/{id}/tokens`. The
OAuth posture then regressed the custody class to a user refresh token. SI
merges the postures: **OAuth is the front door, the paste-shaped token is the
outcome.**

Bootstrap (in the `/ingress/cloudflare/oauth` callback, replacing today's
"store refresh token, done"):

```
exchange code → access token                      (identity, in-memory only)
POST /accounts/{id}/tokens                        (create service identity)
  name: orun/{orgId}/service
  policies: union of template permission groups + "Account API Tokens Write"
  no expires_on (durable; platform-rotated)
verify via GET /user/tokens/verify
envelope as kind `cloudflare_service_token`
delete cloudflare_refresh_token + cloudflare_pkce_verifier; best-effort
  revoke the OAuth grant
```

Day-2 minting is byte-identical to the shipped paste posture: children are
created from the service token, `template ⊆ parent grant` deny-by-default,
`providerRef` revoke, orphan sweep — all unchanged. `"Account API Tokens
Write"` on the service token is what lets it mint children *and* roll itself.

Consequences:

- **The mint lock becomes unnecessary for Cloudflare.** The parent is static
  between scheduled rotations; there is no rotate-on-use window. The lock
  stays wired (it is harmless and still guards the revoke sweep) but the race
  class it was built for disappears for this provider.
- **Rotation is a cron, not a consent.** `rotateServiceIdentity` rolls the
  token value (`PUT /accounts/{id}/tokens/{tokenId}/value`) under the
  connection lock, re-envelopes, stamps `rotated_at`. No human, no OAuth.
- **Revoke is total.** Connection revoke deletes the service token
  provider-side (which kills all outstanding children of it) then zeroizes
  custody — a strictly stronger guarantee than today's refresh-token revoke.

**Gate (decision SI-D1).** The bootstrap requires the OAuth-minted access
token to be allowed to create account-owned tokens carrying `"Account API
Tokens Write"` — i.e. the granted scope set must cover token administration.
If Cloudflare's OAuth scope catalog cannot express that, the callback
degrades to a **guided paste**: the console walks the admin through creating
exactly the `orun/{org}/service` token (template pre-filled via deep link)
and pasting it — the shipped token-paste posture with better UX. Either
branch ends in the same custody state; nothing downstream can tell which
door was used. This must be probed against a live OAuth app before SI2 is
scheduled (same park-and-continue posture as D3).

## Supabase design

Supabase has no org-level service accounts for its Management API (epic
risks, D4 discussion) — the management plane is only reachable as a user.
So SI splits the planes instead of pretending:

- **Project plane (the run-time 95%).** At bootstrap — and on a reconcile
  cron — use the management session to enumerate projects and custody the
  projects' **service-role keys** as kind `supabase_project_secret` (one
  encrypted JSON map per connection, keyed by project ref; `external_ref` =
  the Supabase org id — preserving the `(connection_id, kind)` uniqueness
  and zeroize-on-revoke discipline). These are project-owned,
  person-independent infrastructure credentials, served by a new
  **custody-served template `project-service-key`** (`params: [projectRef]`)
  — no refresh, no rotation race, no user tie, no management-API
  availability on the resolve path. (TTL semantics change class: a
  service-role key is not TTL-clamped by the provider, so these mints return
  the custodied key and rely on the provider's key-rotation API for the
  revoke story — the ledger records issuance exactly as before.)

  **Decision SI-D2 (supersedes the earlier "re-target `db-migrate` /
  `functions-deploy`" sentence):** those two templates genuinely require the
  Management API — a service-role key cannot run DDL or deploy Edge
  Functions — so re-targeting them would break their function. They stay on
  the management plane (refresh-derived, labeled `user-derived`); the
  project-plane escape from the user tie is `project-service-key`, which is
  what run-time data-plane bindings (e.g. `SUPABASE_SERVICE_ROLE_KEY`)
  should bind to.
- **Management plane (the connect-time 5%).** `management-access` (project
  create, config, branches) genuinely requires a user-consented session.
  The refresh token stays — but demoted and labeled: custody row carries
  `credential_class = 'identity'`, connection health surfaces
  **`user-derived`** with the authorizing admin named, and the console offers
  **re-bootstrap** (any admin re-consents; custody swaps atomically under the
  mint lock). The mint lock remains load-bearing here — this is its one
  remaining tenant.
- **Paste posture parity (optional).** Accept an admin-pasted per-project
  secret key as a connect method for orgs that refuse OAuth — same guided-
  paste shape as Cloudflare's fallback.

If Supabase ships management-plane service credentials later,
`provisionServiceIdentity` absorbs them and the split collapses to the
Cloudflare shape — the seam is already right.

## Data model

Migration `840_service_identity_custody`:

- `integrations.provider_credentials.kind` CHECK adds
  `cloudflare_service_token`, `supabase_project_secret`.
- `integrations.provider_credentials.credential_class TEXT NOT NULL DEFAULT
  'infrastructure' CHECK IN ('identity','infrastructure')` — backfilled:
  refresh tokens + PKCE verifiers → `identity`, parent/bot tokens →
  `infrastructure`.
- `integrations.minted_credentials.parent_kind TEXT` — ledger annotation of
  which custody kind authorized each mint (rollout observability + audit
  answer to "was this minted from a user token?").
- Custody candidate order flips to prefer service identities:
  `cloudflare: [cloudflare_service_token, cloudflare_parent_token,
  cloudflare_refresh_token]` — dual-read makes the rollout a no-op for
  un-migrated connections.

## Migration path (existing connections, zero downtime)

| ID | Milestone | Done when |
|----|-----------|-----------|
| SI1 | **Contract + custody classes.** `provision` capability on the seam; migration `840`; candidate-order flip; ledger `parent_kind` | Dual-read live; every new mint row carries `parent_kind`; no behavior change for existing connections |
| SI2 | **Cloudflare provisioning.** OAuth callback provisions the service token (or guided paste per SI-D1); identity credentials deleted post-provision | A fresh OAuth connect ends with only `cloudflare_service_token` in custody; mints flow from it |
| SI3 | **Backfill.** Per-connection upgrade job for active Cloudflare OAuth connections: under the mint lock — refresh once, provision service token, verify with a probe mint, swap custody, delete refresh token, emit `integration.connection.upgraded`. Failure leaves the connection exactly as it was (refresh re-enveloped); health flags it for manual re-connect | `parent_kind = cloudflare_refresh_token` count reaches zero in the ledger; refresh custody rows for Cloudflare are gone |
| SI4 | **Supabase project credentials.** Project-key custody + reconcile cron; custody-served `project-service-key` template (SI-D2); management plane labeled `user-derived` with re-bootstrap flow | Run-time resolves of `project-service-key` make zero management-API calls; the user-tie is confined to the management-plane templates |
| SI5 | **Deprecation + hardening.** Reject new Cloudflare refresh-token custody writes; drop `cloudflare_refresh_token` from candidates; scheduled `rotateServiceIdentity` cron (IH9 lane); orphan sweep extended to service tokens | A user-derived parent can no longer authorize a Cloudflare mint, structurally; rotation runbook is a no-op doc |
| SI6 | **Console + copy.** Connect flow states the contract ("your login provisions Orun's own identity, then is discarded"); connection detail shows credential class, rotation age, and — where applicable — the user-tie warning | Hub cards reflect class; docs updated |

Rollback at every step is the dual-read: as long as `840`'s candidate order
is deployed, restoring a refresh-token custody row restores the old path.

## What does NOT change

The resolve wire contract, the `{"v":"brokered"}` envelope, both mint
surfaces, policy/entitlement gates, the ledger shape (additive column only),
orphan machinery, and the **orun CLI (zero change — again)**. Brokered
secrets bound to a connection survive SI3 untouched: the binding names the
connection, not the credential.

## Verification

- SI2/SI3: integration tests against the recorded-fixture Cloudflare fake —
  bootstrap provisions + deletes identity credentials; backfill is idempotent,
  crash-safe mid-swap (re-runs converge), and probe-mint-gated.
- Mint-lock regression suite keeps passing with the Supabase management-plane
  tenant; a new test asserts Cloudflare mints never enter a refresh.
- Ledger assertion in CI: after SI5, `parent_kind` ∈ user-derived kinds is a
  hard failure for cloudflare.
