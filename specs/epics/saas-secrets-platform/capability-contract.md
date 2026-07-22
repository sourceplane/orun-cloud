# SecretsCapability — the plugin contract

> The single declaration an integration adds to become a secret source, plus the
> authoring interface it consumes to create one. Grounds every claim in the
> shipped IH0 capability seam (`apps/integrations-worker/src/providers/types.ts`)
> and the SM store (`apps/config-worker`). Nothing here invents storage, a
> resolve path, or an encryption path — those stay substrate-owned.

## 1. Where it hangs

`SecretsCapability` is a new **optional capability object** on the existing
`IntegrationProvider`, exactly like `broker`, `messaging`, `inbound`,
`provision`. Asking a provider for a capability it lacks is already a typed
`capability_not_supported`, never a 500 — this inherits that.

```ts
interface IntegrationProvider {
  id; displayName; connectKind;
  capabilities: IntegrationCapability[];   // add "secrets" when present
  broker?:    CredentialBrokerCapability;  // PRODUCE (shipped)
  secrets?:   SecretsCapability;           // DESCRIBE (new, this epic)
  // messaging?, inbound?, provision? unchanged
}
```

`secrets` is present iff `capabilities` includes `"secrets"`. A provider that
declares `secrets` MUST also declare `broker` (you cannot produce a value
without a mint). The registry validates this at construction.

## 2. The declaration

```ts
interface SecretsCapability {
  /** DESCRIBE — the canonical scope-template catalog for this provider. Becomes
   *  the single source of truth (the console SCOPE_TEMPLATE_CATALOG is deleted;
   *  the db validators derive from this). Same shape the broker already returns
   *  from scopeTemplates() — unified here so there is ONE list. */
  scopeTemplates(): readonly ScopeTemplate[];

  /** Which stored/served modes this provider's mint can back. Replaces the
   *  hardcoded BROKER_CAPABLE_PROVIDERS + ALLOWED_ROTATION_PROVIDERS lists.
   *   - "brokered": the mint yields a short-lived value fit for mint-at-resolve.
   *   - "rotated":  the mint yields a value that can be STORED and re-minted
   *                 (the provider issues a token with a settable expiry). */
  supportedModes: readonly ("brokered" | "rotated")[];

  /** Materialize target ids this provider can write a rotated value INTO for a
   *  long-lived consumer (deliver). Validates rotation_deliver_target; maps to
   *  the Go materialize.Adapter registry. Omit for providers that only serve
   *  per-run consumers. */
  deliveryTargets?(): readonly DeliveryTargetId[];

  /** How this integration wants its create experience rendered (see §5).
   *   - "declarative": the substrate renders the default authoring surface from
   *                    scopeTemplates() + supportedModes.
   *   - "custom":      the integration registers its own authoring surface. */
  authoring: "declarative" | "custom";
}

interface ScopeTemplate {
  id: string;                         // e.g. "workers-deploy"
  displayName: string;
  description: string;                // states EFFECTIVE breadth honestly (IH R5)
  params: readonly string[];          // param names the mint requires
  /** Modes this specific template supports, when narrower than the provider's
   *  supportedModes (optional; defaults to the provider set). */
  modes?: readonly ("brokered" | "rotated")[];
}

type DeliveryTargetId = string;       // e.g. "cloudflare-worker"
```

**Design rule:** every field is *data the integration owns*, not behavior the
substrate hardcodes. Adding a provider never edits a substrate list.

## 3. The wire seam (SP0)

The declaration is static per provider, but the *live* set (which connections in
this org can back a secret, with which templates) is org-scoped. One internal
read, served by integrations-worker, consumed by config-worker and the console:

```
GET  …/internal/providers/{providerId}/secrets-capability
→ 200 { scopeTemplates: [...], supportedModes: [...], deliveryTargets: [...], authoring }
```

- **config-worker** calls it to validate a rotated/brokered create (does this
  provider support this mode? is this template real? is this a known delivery
  target?) — replacing the `ALLOWED_ROTATION_PROVIDERS` check in
  `db/config/rotation-binding.ts`.
- **console** calls it (or reads it folded into the connection status already
  fetched) to render the create surface — replacing `SCOPE_TEMPLATE_CATALOG`
  and `BROKER_CAPABLE_PROVIDERS` in `bind-secret-flow.ts` / `archetype.ts`.

Cacheable (static per provider version); the org-scoped part (usable
connections) already rides the shipped connection-status read.

## 4. The three verbs (mapped to shipped code)

| Verb | Contract | Shipped today | SP change |
|---|---|---|---|
| **Produce** | mint `(connection, template, params, purpose)` → `{value, providerRef, expiresAt}` | `CredentialBrokerCapability.mintCredential`; `mintBrokeredCredential` over the service binding; `internal-resolve-secrets.ts` is provider-agnostic | none — keep |
| **Deliver** | write a value into the provider's runtime store | Go `materialize.Adapter` (`Name()`/`Put()`), `Registry` (`Register`/`Lookup`) | declare target ids in `deliveryTargets()`; validate against them |
| **Describe** | declare templates + modes + targets + authoring | scattered across 5 hardcodes | the `SecretsCapability` above |

## 5. The Secret Authoring Interface (what a producer consumes)

An integration author never touches ciphertext, an encryption path, or the
scope/policy checks — it calls the authoring interface and the substrate does
the governed write (mirrors `create-secret.ts`, which already gates
brokered/rotated creation behind `secret.write` + `credential.issue`).

**Programmatic (frozen SDK contract).** The producer calls one of:

```ts
client.config.createRotatedSecret(scope, { secretKey, rotation, rotationPolicy?, displayName? })
client.config.createBrokeredSecret(scope, { secretKey, binding, rotationPolicy?, displayName? })
```

These already exist; SP1 freezes them as *the* authoring contract and mirrors
them on the CLI under an integration namespace (SP5).

**UI primitives (headless).** The substrate exports the governed pieces an
integration space composes into its own create surface:

- `<SecretKeyField>` — key grammar + collision hints.
- `<ScopeChainPicker>` — the account→workspace→project→environment(+personal)
  rung selector (the substrate owns the chain).
- `<RotationPolicyControl>` — the `<n>[hdwmy]` cadence + grace/deliver inputs.
- `<EntitlementError>` — the inline 412 broker-entitlement message.
- `useCreateRotatedSecret()` / `useCreateBrokeredSecret()` — the write hooks
  that call the SDK and surface typed errors.

The integration composes these; the substrate performs the write and returns the
`PublicSecretMetadata`. The RS4 dialog (`secrets-panel.tsx` `BindSecretForm`) is
refactored into these primitives + the default surface (§6).

## 6. Declarative vs custom (modeling "its own way of working")

A per-provider **authoring registry** maps `providerId → authoring surface`,
the same graft-point pattern as `getConfiguredProvider`:

```ts
function authoringSurfaceFor(providerId: string): AuthoringSurface {
  // custom-registered surface, else the default rendered from the declaration
  return CUSTOM_AUTHORING[providerId] ?? defaultAuthoringSurface;
}
```

- **Declarative** (`authoring: "declarative"`) — the substrate renders the
  default surface from `scopeTemplates()` + `supportedModes`. A new broker
  provider gets a working create flow with zero UI code. This is the generalized
  RS4 form.
- **Custom** (`authoring: "custom"`) — the integration ships its own surface in
  its own space (a component/route under the integration page) built on the §5
  primitives. Cloudflare uses this for account selection + a richer scope-
  template manager + provider copy. The substrate still performs the write and
  owns lifecycle.

## 7. Onboarding a new integration (the checklist)

1. Implement `broker.mintCredential` — **produce** (the one method that talks to
   the provider).
2. Declare `SecretsCapability` — **describe** (templates + modes + authoring).
   *Data.*
3. *(Optional)* register a `materialize.Adapter` + list it in `deliveryTargets()`
   — **deliver** (only if it is also a delivery target).
4. *(Optional)* register a custom authoring surface — else inherit the default.
5. Add the provider to `getConfiguredProvider` + env secrets — the one deliberate
   human-gated edit.

**Zero changes to** the SM store, the resolve path, the Secrets lens, the CLI
substrate, or any validator — those all read the declaration.

## 8. Invariants (regression-tested)

1. A `secrets`-declaring provider always declares `broker` (validated at
   registry construction).
2. The substrate names **no provider** in the resolve/store/validator path — it
   passes `(connectionId, template)` and reads the capability.
3. A create is rejected unless the provider's declaration lists the requested
   mode and template (fail closed, typed reason).
4. A `deliverTarget` is rejected unless it is in `deliveryTargets()`.
5. No integration code path can write ciphertext or bypass `secret.write` +
   `credential.issue`.
6. Deleting a hardcoded list (SP0) changes no behavior for the shipped
   Cloudflare/Supabase providers — the declaration reproduces the old lists.
