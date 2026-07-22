# Implementation plan — saas-secrets-platform (SP0–SP6)

Re-anchored on shipped code: the IH0 capability seam
(`apps/integrations-worker/src/providers/types.ts`), the SM store + resolve
(`apps/config-worker`), the RS producer path
(`provider-rotated-secrets`, shipped), and the Go materialize registry
(`orun/internal/materialize`). Each milestone is additive and independently
shippable; the boundary moves are ordered so no surface is ever orphaned.

## SP0 — The capability + endpoint (foundation)

**Scope.**
- Add `SecretsCapability` to the provider seam (`providers/types.ts`) and
  implement it on the Cloudflare + Supabase adapters (reproducing today's
  templates/modes exactly — a pure lift of the hardcodes into the declaration).
- Route `GET …/internal/providers/{id}/secrets-capability` in integrations-worker
  (service-binding + console-reachable read), returning
  `{scopeTemplates, supportedModes, deliveryTargets, authoring}`.
- **config-worker**: replace the `ALLOWED_ROTATION_PROVIDERS` check
  (`db/config/rotation-binding.ts`) with a capability lookup at the rotated/
  brokered create gate (`create-secret.ts`) — provider must declare the mode +
  template + (for rotated) the delivery target.
- **console**: replace `BROKER_CAPABLE_PROVIDERS` and `SCOPE_TEMPLATE_CATALOG`
  reads with the endpoint (fold into the connection-status query already
  fetched by `BindSecretForm`).

**Done when** all three hardcoded lists are deleted, Cloudflare + Supabase
create/list/rotate behave identically to today (the declaration reproduces the
old lists), and a regression test asserts the capability round-trips the shipped
template set. **No behavior change** — pure de-hardcode.

## SP1 — The Secret Authoring Interface

**Scope.**
- Freeze `createBrokeredSecret` / `createRotatedSecret` / `createSecretMetadata`
  as the authoring contract (contracts + SDK; no shape change).
- Extract the headless UI primitives (`<SecretKeyField>`, `<ScopeChainPicker>`,
  `<RotationPolicyControl>`, `<EntitlementError>`, the write hooks) out of
  `secrets-panel.tsx`'s `BindSecretForm` into `packages/ui` (or a shared
  console module).
- Define the authoring-surface registry (`authoringSurfaceFor(providerId)`) with
  a `defaultAuthoringSurface` rendered from a capability (the generalized RS4
  form) and a `CUSTOM_AUTHORING` graft map.

**Done when** the existing Rotated/Scoped-credential dialogs render entirely
from the primitives + the default surface (no behavior change), and the registry
resolves the default for every provider.

## SP2 — Integration-owned creation (Cloudflare first)

**Scope.**
- Add a **Secrets** section to the Cloudflare integration page: a custom
  authoring surface (account/connection pick, template pick/manage, brokered vs
  rotated, policy/grace/deliver) built on the SP1 primitives; a filtered
  "this connection's secrets" list; the entry point for creating a
  Cloudflare-bound secret.
- Register Cloudflare's custom surface in `CUSTOM_AUTHORING`
  (`authoring: "custom"`); Supabase stays declarative (default surface) as the
  contrast.

**Done when** a Cloudflare-bound rotated/brokered secret can be created entirely
from the Cloudflare space, the substrate performs the governed write, and the
new row appears (unchanged) on the Secrets lens. **Lands before SP3.**

## SP3 — Secrets surface → substrate lens

**Scope.**
- Remove the "Scoped credential" + "Rotated" create tabs from the Secrets-page
  dialog; it creates **static** secrets only.
- Keep integration rows visible with type-generic actions (SP-D1); add the
  "Managed by {integration}" affordance + deep link for create-shaped actions.
- Empty-state + type-filter point to the owning integration for integration
  types.

**Done when** the Secrets page creates only static secrets, still lists + manages
every type, and every "create an integration secret" path routes to the owner.
Depends on SP2 (no orphaned create window).

## SP4 — Integration-owned scope templates

**Scope.**
- Promote scope templates from code-declared (SP0) to integration-*managed* at
  runtime: a template store owned by the integration context, curated in the
  integration space, served to the substrate via the SP0 endpoint (the source
  of truth never leaves the integration).
- Versioned templates; a template in use cannot be deleted out from under a
  live secret (soft-retire).

**Done when** an operator can add/edit a Cloudflare scope template in the
Cloudflare space and it appears in the create surface + the capability endpoint,
with no console/db redeploy.

## SP5 — CLI ownership parity

**Scope.**
- `orun secrets` = view/manage all types + create static.
- Integration-namespaced authoring: `orun integrations {provider} secret create
  …` (reads the capability for templates/modes; calls the authoring SDK).
- Deprecate `orun secrets set --from-broker` toward the namespaced form (keep
  working with a deprecation notice for one release).

**Done when** the CLI mirrors the UI boundary and the namespaced authoring
command creates a provider-bound secret from the declared templates.

## SP6 — Pluggability proof

**Scope.**
- Onboard a second live provider end-to-end through the contract (Supabase as
  the live proof; an AWS-STS dormant proof mirroring IH10's
  `DORMANT_PROVIDER_IDS`) — implement `broker.mint` + declare `SecretsCapability`
  + (Supabase) inherit the default authoring surface.
- Assert **zero** changes to config-worker, the Secrets lens, or the CLI
  substrate for the new provider — a compile-time + test-time proof.

**Done when** a provider is added by declaration + mint + env-gate only, and a
test proves no substrate file changed to light up its secrets experience.

## Sequencing & gates

- **SP0 is human-independent** (pure de-hardcode) and unblocks everything.
- **SP1** is a refactor (no behavior change) — safe any time after SP0.
- **SP2 → SP3** are strictly ordered (create space before removing the old
  create) to avoid an orphaned-UX window.
- **SP4/SP5/SP6** are independent tails after SP2/SP3.
- Gates: SP2's Cloudflare space layout needs product sign-off; SP6's live proof
  is gated per provider by its connect posture (IH D3/D4), same park-and-continue
  posture as the rest of IH.
