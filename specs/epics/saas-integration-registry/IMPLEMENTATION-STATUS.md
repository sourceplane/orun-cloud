# saas-integration-registry — Implementation Status

As-built record. Epic designed 2026-07-23 (#593) on the shipped IH/SP/IT
rails; implementation started same day.

## Summary

| ID | Status |
|----|--------|
| IR0 | ✅ Shipped (#596) — manifest + registry read |
| IR1 | ✅ Shipped (#597) — unified hub from the registry |
| IR2 | ✅ Shipped (#598) — canonical space + nested detail + redirects |
| IR3 | ✅ Shipped (#599) — Cloudflare unified |
| IR4 | ✅ Shipped (#600) — the outcome-first secret wizard |
| IR5 | ✅ Shipped (#601) — AI + compute re-home |
| IR6 | 🗓️ Planned |
| IR7 | 🔄 In progress — served CLI verb trees (orun ICL0–ICL3 ✅ shipped, orun #559) |
| IR8 | 🔄 In progress — manifest governance + docs generation |
| IR9 | 🔄 In progress — pluggability proof + runbook |

## Notes

- 2026-07-23: IR7/IR8/IR9 as built (one PR — the closing governance slice):
  - **IR7**: the orun side shipped first (orun #559: registry client +
    cache, runtime renderer with capability-derived standard verbs,
    compiled 11-op allowlist, native-extension seam; SP5 byte-identical).
    Server side: the dormant AWS manifest serves the first explicit verb
    tree (`credentials list` → `integrations.listMinted` — served-wins
    proof); `cli-projection.test.ts` mirrors orun's op allowlist so a verb
    naming an op outside it fails in CI on BOTH sides.
  - **IR8**: `manifest-governance.test.ts` — the additive-evolution gate
    (surface snapshot: same version ⇒ identical surface; evolution ⇒
    version bump + conscious regeneration; manifest ids can never vanish)
    + the generated web-docs **Integration catalog**
    (`apps/web-docs/docs/platform/integrations/catalog.md`, rendered from
    the manifests by `manifests/docs.ts`, byte-exact freshness test;
    regenerate with REGENERATE_INTEGRATION_DOCS=1). Hand-written provider
    narratives (github.md) stay hand-written — the catalog/index is the
    generated part.
  - **IR9**: `adding-an-integration.md` — the runbook: ≤ 6 files +
    fixtures per new provider, every derived plane enumerated, the three
    CI gates named. The AWS proof now spans every plane: roadmap hub card
    (IR1), space chrome fixture (IR2), secrets declaration (SP6), served
    CLI tree (IR7) — all from the manifest + adapter files alone.

- 2026-07-23: IR5 as built:
  - **Migration `910_integration_registry_rehome`**: nullable
    `agents.provider_connections.connection_id` + index; CTE backfill
    creating one `integrations.connections` identity row per facts row
    (verified→active, unverified→pending, invalid→suspended;
    `scope='workspace'` per IR-D4); idempotent; COMMENT documents the
    facts-table turn; registered in manifest + migrations.lock.
  - **Adapters + manifests**: apikey family (anthropic/openai/openrouter/
    daytona) — `connectKind: "apikey"`, always-configured (the paste IS the
    credential; no env gate), `verifyApiKey` mirroring the agents-plane
    probes (Daytona's stays DELEGATED to the agents plane — sandbox-create
    verification is not re-implemented). Manifests live, multiConnection,
    modules models/sandboxes. `IntegrationProviderId` widened to 10.
  - **Dual-write + audit** (agents-worker): create writes the identity row
    FIRST and stamps `connection_id` on the facts INSERT (identity failure
    degrades to a NULL pointer — the pre-backfill shape, never a failed
    connect); verify flips active/suspended; delete revokes.
    `integration.connected`/`integration.revoked` now emitted (net-new —
    the agents plane had NO audit before). `ProviderConnection.connectionId`
    projected additively.
  - **Console**: the hub's embedded agents panel + kicker are DELETED —
    AI/compute render as registry cards dispatching to their spaces;
    `connect-panel.tsx` gains the apikey paste form (submits via the AGENTS
    plane — the space is chrome, custody stays where keys are consumed).
    **Deviation from IR-D3's redirect default**: `settings/ai-providers`
    stays live but connection-free (Session/Dispatch model settings +
    Copilot toggle had no other home) with a "connections moved" note —
    recorded here instead of silently redirecting settings away.
  - Verified: integrations-worker 483, agents-worker 235, console 865,
    db 978, contracts 174 — all green; typecheck + lint clean.

- 2026-07-23: IR4 as built:
  - **The wizard** (`components/config/secret-wizard.tsx` +
    `secret-wizard-lib.ts`): outcome-first stepper — use-case cards from the
    ACTIVE template catalog (org customs included) → where (scope rung +
    connection + params) → how (brokered "fresh per run" recommended vs
    rotated + delivery; the step is SKIPPED for single-mode providers) →
    review (smart `<PROVIDER>_API_TOKEN` key default, plain-language summary
    from the template's own copy, one governed write through the frozen SP1
    hooks). Validation REUSES `validateBindingForm`/`validateRotationForm` —
    no rule restated. A11y: labeled step list, focus-managed headings.
  - **Default surface swap**: the wizard replaces the mechanism-first
    default (`authoring-surface.tsx` deleted); the Cloudflare custom surface
    (`cloudflare-authoring.tsx`) proved fully expressible by the generic
    wizard and was DELETED — SP-D4 confirmed at n=2. The adapter + manifest
    flip `authoring` back to `"declarative"` (conformance-linted); the SP0c
    test expectation updated.
  - **Deep links**: `?create=1&connection=&template=` seeds and locks;
    `?template=` never pre-selects retired/unknown ids.
  - Verified: console 88 suites / 864 tests (18 new wizard tests),
    integrations-worker 458/458, typecheck + lint clean.

- 2026-07-23: IR3 as built:
  - **Recipe on the wire**: `IntegrationConnectRecipe` (contracts, additive)
    on served connect methods; the Cloudflare adapter exports
    `buildParentTokenRecipe()` DERIVED from `TEMPLATE_PERMISSION_GROUPS` +
    the template catalog + the mint grant — the manifest's token method
    serves it. The console's hand-mirrored `PARENT_TOKEN_RECIPE` is deleted
    with the modal; grammar literals now exist only in the adapter
    (conformance-tested: every template's groups + the mint grant appear in
    the served recipe).
  - **Generic connect surface** (`connect-panel.tsx`): renders the
    descriptor's ORDERED methods — live install/oauth primary, token-paste
    beneath with the served recipe; zero provider-name branches. The
    token form reuses the shipped `token-connect-flow` reducer and posts
    through the provider-generic SDK connect (`{ parentToken }`).
    `cloudflare-connect-modal.tsx` deleted; the space's `spaceOwnsConnect`
    is now descriptor-driven (`connectDispatch(...) === "space"`).
  - **Multi-account first-class**: `multiConnection` drives an "Add
    account" header CTA on the space; the connections tab, activity picker,
    and authoring connection picker were already connection-scoped.
  - Verified: integrations-worker 458/458, console 87 suites / 843 tests,
    typecheck + lint clean.

- 2026-07-23: IR2 as built:
  - **Route model**: `/integrations/[slug]` is the canonical integration
    route — the one dynamic segment resolves by shape via
    `components/integrations/route-model.ts` (`int_<32hex>` → legacy
    connection redirect resolving the provider from the connections list;
    anything else → the provider space). Nested detail:
    `/integrations/{provider}/connections/{connectionId}` (ConnectionDetail
    gains `backHref`/`backLabel`); `providers/[providerId]` became a
    redirect stub carrying `?create/?connection/?connect` through (the
    `settings/integrations` precedent). The R2 guard test enumerates the
    contract provider ids against the connection-id shape + reserved
    segments.
  - **Space chrome**: the space renders the standard tab skeleton
    (Overview · Connections · Secrets · Templates · Activity · Settings)
    from `descriptor.space.tabs`, degrading to a capability-derived tab set
    while the registry read is unavailable (SP-A5). `?tab=` deep-links.
  - **Activity tab** (`space-activity.tsx`, new): per-connection mint
    ledger (template, purpose, run/actor attribution, expiry, live/expired/
    revoked state, revoke action — the first console consumer of the
    shipped `listMintedCredentials`/`revokeMintedCredential` surface) and
    inbound delivery log (event, attempts, status, replay for failures) —
    metadata only, by construction.
  - **Link sweep**: `providerSpaceHref` now canonical; hub connection cards
    and space connection rows link nested; every legacy URL redirects, none
    break.
  - Verified: console 87 suites / 843 tests (route-model + updated
    provider-space routing expectations), typecheck + lint clean.

- 2026-07-23: IR1 as built:
  - **Console registry lib** (`components/integrations/registry.ts`): pure
    helpers over the served descriptors — `CATEGORY_ORDER/LABELS`,
    `groupByCategory`, `cardState` (connected / available / locked /
    configure / roadmap — a pure function of descriptor + connections),
    `connectDispatch` (popup for a single live install/oauth method; the
    provider's SPACE for token/multi-method postures — posture-driven,
    never provider-named), `primaryLiveConnect`, `providerDisplayName`
    (fail-soft to the id), icon resolution with category fallback.
  - **Hub rewrite** (`integrations-hub.tsx`): renders every section from
    `qk.integrationRegistry(orgId)`; the `providers.ts` catalog and the
    `id === "cloudflare"` special case are DELETED; connect uses the new
    provider-generic SDK `connect(orgId, providerId)`; locked cards get the
    U7 upgrade CTA; "configure" renders the honest env gate; roadmap strip
    from `status: "roadmap"`; SP-A5 loading/error states (never a fallback
    catalog). The AI & compute section keeps the embedded agents panel
    under registry-ordered chrome until IR5.
  - **Provider space** (`provider-space.tsx`): reads identity from the
    registry (name/tagline); owns connect for space-dispatch providers via
    `?connect=1` — the shipped Cloudflare modal mounts as the one-milestone
    shim IR3 replaces with the descriptor-driven connect panel; OAuth
    primary action runs the generic connect popup.
  - **Fallout**: `archetype.ts` shrank to `archetypeForProvider` for
    connection-detail (dies in IR2); `secrets-panel.tsx` derives provider
    display names from the registry read.
  - Verified: console 86/86 suites (840 tests, incl. the new
    `integration-registry-helpers` suite replacing the deleted catalog
    test), integrations-worker 457/457, typecheck + lint clean.

- 2026-07-23: IR0 as built:
  - **Contracts** (`packages/contracts/src/integrations.ts`, additive):
    `IntegrationCategory`, `IntegrationManifestStatus`, `IntegrationSpaceTab`,
    `IntegrationModuleRef`, the CLI-projection types (`IntegrationCliArg` /
    `IntegrationCliInvoke` / `IntegrationCliVerb` / `IntegrationCliNamespace` —
    types only in IR0; verb data lands with IR7), `IntegrationManifest`,
    `IntegrationConnectMethod{,Decl}`, `IntegrationDescriptor`,
    `IntegrationRegistryResponse`.
  - **Manifests** (`apps/integrations-worker/src/providers/manifests/`): one
    module per provider beside its adapter (github, slack, cloudflare,
    supabase live; aws, discord roadmap/dormant), each `{ manifest,
    resolveConnect(env) }`. `shared.ts` carries the module contract + the
    default `liveWhenConfigured` resolver (the `getConfiguredProvider` gate,
    reported); Cloudflare supplies its own two-method resolver (oauth when a
    client is registered, token whenever custody exists).
  - **Registry read**: `GET /v1/organizations/{org}/integrations/registry`
    (`handlers/registry.ts`; route matched before `ORG_INTEGRATION_RE`).
    Descriptor = manifest + per-env `connect[].live` + fail-soft `entitled`
    (per live provider via billing-worker; omitted on service error — never
    fabricated, the SP-A5 rule). ETag = SHA-256 of the payload;
    `If-None-Match` → 304. Zero api-edge changes (rides
    `ORG_INTEGRATIONS_RE`, verified against the facade tests).
  - **Projection**: `secrets-capabilities.ts` now iterates the manifest
    registry instead of `KNOWN_PROVIDER_IDS + DORMANT_PROVIDER_IDS`; wire
    shape unchanged (all shipped SP0c tests pass untouched).
  - **SDK**: `client.integrations.getRegistry(orgId)`.
  - **Tests**: `manifest-conformance.test.ts` (manifest ⊆ adapter —
    capabilities exact-match, connect kinds cover the adapter's resolved
    posture, authoring matches the secrets declaration, tabs are a pure
    function of capabilities, per-env liveness honesty incl. the Cloudflare
    matrix) + `registry-read.test.ts` (route, liveness projection, fail-soft
    entitlement, ETag/304, metadata-purity, 401/404/405).
  - Verified: integrations-worker 457/457, contracts, api-edge 525/525
    (after `wire:fixture`), typecheck + lint clean.
