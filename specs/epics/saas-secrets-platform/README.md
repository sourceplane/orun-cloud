# Epic: saas-secrets-platform (SP)

**Secrets become a substrate; each integration owns the authoring of its own
secrets.** The secret manager stops being the place you go to wire up a
Cloudflare or Supabase credential — it becomes the governed *value plane* every
integration writes into through one stable interface. Creation of an
integration-bound secret is owned by the integration's own space (the Cloudflare
page creates Cloudflare secrets, manages its scope templates, models its own
posture); the Secrets surface is the substrate lens where any secret is
**viewed and acted on by type**, but where you can no longer *create* an
integration secret. A new integration onboards as a **plugin**: it declares a
capability, implements at most two verbs, and gets a first-class secrets
experience for free — with zero edits to the secret store, the resolve path, the
Secrets console, or the CLI.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft — for review** |
| Cluster | **SP** (SP0–SP6) |
| Owner(s) | `apps/config-worker` (substrate: store/resolve/type-generic actions), `apps/integrations-worker` (the provider capability seam), `apps/web-console-next` (the Secrets lens + per-integration secret spaces), `packages/{contracts,sdk,cli}`, `orun` CLI (`orun secrets` + integration-namespaced authoring) |
| Builds on | `saas-integration-hub` (IH0 capability seam, IH4/IH5/IH6 broker), `saas-secret-manager` (SM1–SM6 store/resolve/policy), `saas-integration-hub/sub-epics/provider-rotated-secrets` (RS0–RS4, shipped) |
| End-state target | Adding a secret-producing integration is a *plugin* task — declare a `SecretsCapability`, implement `mint` (produce) and optionally a materialize `Adapter` (deliver), optionally supply a custom authoring surface — and it lights up create/list/rotate/reveal/health across console + CLI with no changes to the substrate |

## Thesis

The `provider-rotated-secrets` work proved the mechanism is sound but exposed
the seam problem: the **runtime** is cleanly decoupled (the secrets plane
touches integrations through exactly two narrow seams), while the **onboarding
metadata** is scattered across five hardcoded lists in three packages. A new
integration is trivial to let *consume* a secret and needlessly invasive to let
*produce* one.

Two moves fix it, and together they define the epic:

1. **Invert ownership (the product move).** A secret is authored where its value
   comes from. A **human** value is authored on the Secrets surface (its native
   home). A **provider-minted** value is authored in the *provider's own space* —
   the Cloudflare integration page owns "create a Cloudflare secret," owns its
   scope-template catalog, and models the flow however suits Cloudflare. The
   Secrets surface becomes the **substrate lens**: it lists every secret, renders
   each by its type, and offers type-generic actions (view metadata, rotate,
   reveal via break-glass, revoke, versions, health) — but it does **not** create
   integration-bound secrets. "Create" for those lives with the owner.

2. **Make the seam a capability (the platform move).** Collapse the five
   hardcoded lists into one `SecretsCapability` the substrate reads at runtime.
   Everything the console and store currently hardcode — which providers can
   back a secret, which support rotation, which templates exist — becomes a
   *declaration* the integration owns and the substrate derives from.

The result: the substrate owns **mechanism** (store, encrypt, version, resolve,
govern, act-by-type); the integration owns **experience** (connect, templates,
create UX, provider posture). Neither reaches into the other's space.

## The ownership boundary (the keystone)

> **The substrate owns the value. The integration owns the authoring.**

| Concern | Owner | Why |
|---|---|---|
| Store / encrypt / version | **Substrate** (config-worker) | One governed value plane; ciphertext never leaves it |
| Resolve / inject / reveal / materialize | **Substrate** | The decrypt path is the single audited seam (SM3) |
| Scope chain, lock, policy, entitlement | **Substrate** | Governance is uniform across every secret type |
| **Create an integration-bound secret** | **Integration** | The integration knows its connections, templates, posture — it "feels suited" |
| Scope-template catalog + management | **Integration** | Templates are provider grammar; the integration curates them |
| Provider-specific create UX | **Integration** | Cloudflare's flow (account pick, template builder) ≠ Supabase's |
| **View / list any secret by type** | **Substrate** (Secrets lens) | One place to see everything; rendered by type |
| Rotate / reveal / revoke / versions / health | **Substrate** (type-generic) | These are secret-lifecycle verbs, not provider verbs — surfaced on the Secrets lens AND embeddable in the integration space |
| Create a **static** (human) secret | **Substrate** | A human value has no integration owner — Secrets is its native home |

The asymmetry is deliberate and is the whole design: **creation flows down from
the owner; lifecycle flows through the substrate.**

## Secret types (the shared vocabulary)

Model a secret as a point on four **orthogonal axes**, not a flat enum — this is
what lets the substrate reason about "any integration" mechanically.

| Axis | Values |
|---|---|
| **Provenance** | `human` · `provider-minted` |
| **Lifetime** | `static` (until rotated) · `dynamic` (per-resolve, lease-bound) |
| **Delivery** | `injected` (per-run jobs) · `materialized` (long-lived apps) |
| **Governance** | scope chain · lockable · policy-gated (uniform) |

The shipped **named modes** are the useful combinations (`config.secret_metadata.source` + the RS `rotation_*` producer):

| Mode | Provenance | Lifetime | Owner of create |
|---|---|---|---|
| **Static** | human | static | Secrets surface |
| **Personal overlay** | human | static (per-user, env-scoped) | Secrets surface |
| **Brokered (dynamic)** | provider-minted | dynamic | **Integration** |
| **Provider-rotated** | provider-minted | static (+ re-mint) | **Integration** |

New integrations extend the *set of providers* behind the two provider-minted
modes; they do not invent new storage or new resolve paths.

## The three verbs (the plugin contract, grounded in shipped seams)

An integration exposes exactly three verbs to the secrets plane. Two are runtime
(already provider-agnostic today); one is the declaration this epic adds.

1. **Produce** — mint a value from `(connection, template, params, purpose)`.
   *Shipped:* `CredentialBrokerCapability.mintCredential` (`providers/types.ts`),
   reached provider-agnostically via `mintBrokeredCredential`
   (`config-worker/integrations-client.ts`); `internal-resolve-secrets.ts` never
   names a provider. **Keep as-is.**
2. **Deliver** — write a value into the integration's runtime store (long-lived
   consumers). *Shipped:* the Go `materialize.Adapter` registry
   (`orun/internal/materialize`, `Name()`/`Put()`/`Register`/`Lookup`).
   **Unify** its target ids into the declaration so a `deliverTarget` validates.
3. **Describe** — declare templates, supported modes, delivery targets, and the
   authoring surface. *New:* `SecretsCapability` (SP0), served over the wire so
   the console and store derive instead of hardcode.

```ts
// Extends the existing capability-typed provider seam (IntegrationProvider).
interface SecretsCapability {
  // DESCRIBE — the single source of truth.
  scopeTemplates(): ScopeTemplate[];                 // already on `broker`; becomes canonical
  supportedModes: ("brokered" | "rotated")[];        // derived eligibility
  deliveryTargets?(): DeliveryTargetId[];             // materialize targets this provider writes
  // AUTHORING — how this integration wants its create experience rendered.
  authoring: "declarative" | "custom";               // see the plugin spectrum below
}
```

## The Secret Authoring Interface (what an integration consumes)

The substrate exposes a **stable authoring interface** an integration space
consumes to create a secret — the "available secret interface" a producer calls
so it never touches storage/ciphertext directly. Two facets:

- **Programmatic** — the SDK create calls already exist (`createBrokeredSecret`,
  `createRotatedSecret`, `createSecretMetadata`); this epic freezes them as the
  *authoring contract* and namespaces the integration-bound ones so the CLI
  ownership mirrors the UI (`orun integrations cloudflare secret create …`
  alongside the substrate's `orun secrets set` for static values).
- **UI primitives** — reusable, headless authoring components (key field, scope
  chain picker, rotation-policy control, the inline 412-entitlement error) the
  integration space composes. The integration renders *its* create surface;
  the substrate supplies the governed pieces and performs the write.

Invariant: an integration author **never** writes ciphertext, never picks an
encryption path, never bypasses the scope/policy checks — it calls the authoring
interface and the substrate does the governed write (mirrors how
`create-secret.ts` already gates brokered/rotated creation behind
`secret.write` + `credential.issue`).

## Declarative vs custom plugins (modeling "its own way of working")

The design supports a spectrum so each integration works the way it wants:

- **Declarative plugin** — the integration supplies only the `SecretsCapability`
  declaration (templates + modes). The substrate renders a **default authoring
  surface** from it (the generalized form the RS4 dialog already is). Cheapest
  onboarding; a new broker provider gets a working create flow for free.
- **Custom plugin** — the integration registers its **own** authoring surface (a
  component / route in its integration space) built on the authoring primitives.
  Cloudflare uses this to own account selection, a richer scope-template manager,
  and provider-specific copy — "as the integration feels suited." The substrate
  still performs the write and owns lifecycle.

A per-provider **authoring registry** (`provider id → authoring surface`) maps
the declaration to either the default or the custom surface — the same
graft-point pattern as `getConfiguredProvider`.

## Milestones (SP0–SP6)

| ID | Milestone | Human help? |
|----|-----------|-------------|
| **SP0** | **The capability + endpoint.** `SecretsCapability` on the provider seam; `GET …/providers/{id}/secrets-capability` (templates + modes + delivery targets); **derive** `BROKER_CAPABLE_PROVIDERS`, `ALLOWED_ROTATION_PROVIDERS`, and `SCOPE_TEMPLATE_CATALOG` from it — delete the three hardcodes. Additive read path. | No |
| **SP1** | **The Secret Authoring Interface.** Freeze the SDK authoring calls as the producer contract; extract the headless UI authoring primitives; define the authoring-surface registry (declarative default vs custom). | No |
| **SP2** | **Integration-owned creation.** Each integration space gets a Secrets section that OWNS create (Cloudflare first): its connections, its scope templates, its create UX (custom surface). Move brokered/rotated creation OUT of the Secrets page INTO the integration space. | Product sign-off on the Cloudflare space layout |
| **SP3** | **Secrets surface → substrate lens.** The Secrets page lists every secret, renders by type, offers type-generic actions; for integration-bound types it replaces "Create" with a "managed by {integration}" affordance + deep link to the owning space. Static create stays. | No |
| **SP4** | **Integration-owned scope templates.** Templates become integration-authored + managed in the integration space (versioned), served to the substrate via SP0's endpoint — one source of truth, no console catalog. | No |
| **SP5** | **CLI ownership parity.** `orun secrets` = view/manage (all types); integration-namespaced authoring for integration-bound creation; `--from-broker` deprecated toward the namespaced form. | No |
| **SP6** | **Pluggability proof.** Onboard a second provider end-to-end through the contract (Supabase as the live proof, an AWS-STS dormant proof) with **zero** changes to config-worker, the Secrets lens, or the CLI substrate — mirroring IH10's `DORMANT_PROVIDER_IDS`. | Gated per provider (connect posture) |

## What this removes (the hardcodes SP0 deletes)

| Hardcode | File | Replaced by |
|---|---|---|
| `BROKER_CAPABLE_PROVIDERS = ["cloudflare","supabase"]` | console `bind-secret-flow.ts` | `supportedModes` includes `brokered` |
| `ALLOWED_ROTATION_PROVIDERS = ["cloudflare"]` | `db/config/rotation-binding.ts` | `supportedModes` includes `rotated` |
| `SCOPE_TEMPLATE_CATALOG` | console `archetype.ts` | `scopeTemplates()` over the SP0 endpoint |
| create-mode tabs reaching into integrations | console `secrets-panel.tsx` | integration-owned create (SP2/SP3) |
| target-id free strings | `rotation_deliver_target`, Go registry | `deliveryTargets()` validation |

`getConfiguredProvider`'s env-gated `switch` **stays** — it is the one place a
human should confirm a provider is wired for an environment.

## Decisions & open questions (SP-D#)

| # | Decision / question | Default recommendation |
|---|---|---|
| **SP-D1** | Does the Secrets surface keep a read-only view of integration secrets, or hide them entirely? | **Keep + view/manage**, hide only *create*. One place to see all secrets is the substrate's whole value. |
| **SP-D2** | Do lifecycle actions (rotate/revoke) live on the Secrets lens, the integration space, or both? | **Both** — they are type-generic; embed the same primitives in each. Create is the only owner-exclusive verb. |
| **SP-D3** | Templates: integration-declared-in-code (SP0) now, integration-*managed*-at-runtime (SP4) later? | Yes — SP0 ships declared templates; SP4 promotes to runtime-managed without moving the source of truth off the integration. |
| **SP-D4** | Default authoring surface for declarative plugins — is the RS4 form generic enough to reuse? | Yes — generalize it behind the primitives (SP1); it is already parameterized by connection + template. |
| **SP-D5** | CLI: integration-namespaced authoring command shape? | `orun integrations {provider} secret create …`; keep `orun secrets` for view/manage + static create; deprecate `--from-broker`. |
| **SP-D6** | Does an integration ever need a *new* storage/lifetime the four modes don't cover? | Assume no for v1 — new integrations pick an existing mode. Revisit only with a concrete provider that can't. |

## Non-goals

- **Not a new secret store or a new resolve path.** The substrate is the shipped
  SM store; integrations plug into it, never around it.
- **Not moving governance to integrations.** Scope chain, lock, policy,
  entitlement, and the decrypt seam stay substrate-owned.
- **Not per-integration ciphertext.** One envelope/DEK hierarchy; integrations
  never encrypt.
- **Not removing static secrets from the Secrets surface** — human values have no
  integration owner and keep their native home.
- **Not a provider SDK rewrite** — extends the IH0 capability seam additively;
  GitHub/Slack/Cloudflare/Supabase adapters are re-expressed, never rewritten.

## Relationship to existing epics

- **saas-integration-hub (IH)** — owns the provider capability seam this epic
  extends (`SecretsCapability` is a new capability object alongside `broker`,
  `messaging`, `inbound`, `provision`) and the credential broker (`Produce`).
- **saas-secret-manager (SM)** — owns the substrate (store, resolve, policy,
  key hierarchy) this epic makes consumable. SP adds no new SM storage.
- **provider-rotated-secrets (RS, shipped)** — the proof-of-need: it delivered
  the mechanism and left the five hardcodes SP0 deletes. SP generalizes RS's
  single-provider path into the plugin contract.
- **saas-secrets-sync (SS)** — the platform's *own* worker secrets; unaffected.
  SP is the customer-facing producer plane.

## Read order

1. `README.md` (this file) — thesis, ownership boundary, secret types, verbs.
2. `ownership-model.md` — the substrate/integration boundary, surface by surface
   (Secrets lens · integration space · CLI) + the authoritative ownership matrix.
3. `capability-contract.md` — the `SecretsCapability`, the wire endpoint, the
   authoring interface, declarative-vs-custom, the onboarding checklist,
   invariants.
4. `implementation-plan.md` — SP0–SP6 with scope + "done when" + sequencing.
