# Epic: saas-secrets-console

## Status

| Field | Value |
|-------|-------|
| Status | Draft — SC0 spec; SC1–SC4 to build |
| Cluster | **SC** (Secrets Console — the console layer over **SM** + **SP** + **IH**) |
| Owner(s) | web-console-next, packages/{contracts,sdk}, config-worker |
| Target branch | `main` |
| Builds on | **SM1–SM6** (write-only store, versions, syncs, rotation engine, resolve — shipped), **SP0–SP6** (secrets-as-substrate, brokered/rotated create paths — shipped), **IX3** (infrastructure secret-broker archetype — shipped) |
| Design source | the `Secrets Console` mockup (a Northwind-family design); extracted verbatim into `design.md` |
| Decisions locked | The Secrets home is a **dedicated secrets-only surface** (no Feature-flags/Settings/Policies tabs). Lifecycle (`fresh`/`rotated`/`static`) and health notes are **derived client-side** from existing metadata — no new persisted lifecycle field. The create flow is **one 4-step modal wizard** (Broker · Paste · Generate). |
| Gate | Live provider brokering (Cloudflare / Supabase) is env-gated — every surface degrades honestly (skeleton → empty → "no connections"), never a baked fallback. |

## Thesis

The secrets **backend is already deep** — a write-only AES-256-GCM store with
per-workspace DEK/KEK, append-only version history, brokered secrets minted
just-in-time from an integration, provider-rotated secrets, a rotation engine,
materialization provenance (`secret_syncs`), lease-bound resolve, and audited
break-glass reveal. What the product lacks is the **console experience** that
makes that depth legible and the create flow inviting.

Today the Secrets route renders a generic multi-tab config surface (a CSS-grid
table, a routed "New secret" dropdown, a separate outcome-first wizard). The
mockup replaces it with a **dedicated Secrets console**: a stats header, a
lifecycle + source filter bar, a clean five-column table, a single **4-step
create wizard** (where does the value come from → configure → scope & lifecycle
→ review → ready), and a **per-secret detail page** with Overview / Usage /
History tabs.

This epic realizes that design as a **pure projection** of the served secret
metadata plus the integrations' secrets capabilities. The only genuinely-new
backend noun is a **generated-secret primitive** (`source='generated'` — a
high-entropy value minted by Orun, optionally auto-rotated); everything else is
recomposition of existing reads (`listSecretMetadata`, `listSecretChain`,
`listSecretVersions`, `listSecretSyncs`, `listSecretsCapabilities`) and existing
writes (`createBrokeredSecret`, `createRotatedSecret`, `createSecretMetadata`,
`rotateSecret`, `revokeSecret`).

## The one genuinely new noun

**Generated secrets** (`source='generated'`). The wizard's "Generate for me"
path mints a high-entropy value (64-char hex / 32-byte base64 / UUID v4) that no
human ever sees — webhook-signing keys, internal tokens. The backend today has
`static` and `brokered` sources plus provider-`rotation`; there is no
server-side random generator. SC4 adds `source='generated'` (contract + one
additive migration + the config-worker create branch + a rotation-engine
re-generate branch) and an SDK `createGeneratedSecret`. Until SC4 lands, the
wizard's Generate path ships on the existing `static` create with a
client-generated value (WebCrypto) — functional throughout, upgraded in place.

Everything else the mockup shows is **derived or already served**:

| Mockup concept | Where it comes from |
|---|---|
| Lifecycle `fresh` / `rotated` / `static` | Derived from `source` + `rotation` + `rotationPolicy` (client-side, `secrets-view.ts`). |
| Health note ("Unused for 34 days", "Static for 181 days") | Derived from `lastUsedAt` / `lastRotatedAt` / `createdAt` (client-side). |
| Source badge (Supabase / Cloudflare / Static / Generated) | `source` + `binding.provider` (+ `source='generated'` from SC4). |
| Broker grant templates (the wizard's Configure step) | `client.integrations.listSecretsCapabilities` + `listScopeTemplates` — real, not hardcoded. |
| Usage tab (consumers) | `client.config.listSecretSyncs({ secretKey })` + `lastUsedAt`. |
| History tab (timeline) | `client.config.listSecretVersions` composed with created/rotated anchors. |
| Rotate now / Revoke | `client.config.rotateSecret` / `revokeSecret`. |

## Milestones at a glance

| ID | Milestone | New backend? | Buildable vendor-free? |
|----|-----------|--------------|------------------------|
| SC0 | Epic spec | No | ✅ |
| SC1 | Derivation foundation (`secrets-view.ts`: lifecycle · source · health · overview + tests) + **redesigned Secrets home** (stats · attention banner · lifecycle+source filter bar · five-column table). Relocate org Settings/Flags/Policies off the Secrets route. | No | ✅ |
| SC2 | **New Secret 4-step modal wizard** — Source (Broker · Paste · Generate) → Configure → Scope & lifecycle → Review → ready. Broker grants from the live capabilities read. | No (Generate ships on `static` create) | ✅ |
| SC3 | **Secret detail page** — header + Copy reference + Rotate now · Overview / Usage / History tabs · Revoke danger zone. | No | ✅ |
| SC4 | **Generated-secret primitive** (`source='generated'` + auto-rotate branch + SDK) wired into the wizard; optional cross-scope aggregate read; final pixel/a11y pass + dead-code retirement. | Yes — `source='generated'` | ✅ |

## Read order

1. `design.md` — the target design (from the mockup): the data model, the list, the wizard, the detail page, and how each surface maps to an existing read/write.
2. `implementation-plan.md` — per-milestone **Build.** / **Done when.**
3. `IMPLEMENTATION-STATUS.md` — as-built, PR trail, deltas from design.

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The dedicated Secrets console visual redesign (list · wizard · detail) | The DEK/KEK/lease resolve plane (SM2/SM3 — reused, not changed) |
| Client-side lifecycle/health/source derivation + unit tests | A persisted `lifecycle` column (kept derived) |
| The 4-step create wizard wiring to existing create paths | The mint/resolve broker core (shipped SP/IH — reused) |
| A generated-secret primitive (`source='generated'`) | Rewriting the rotation engine (one additive branch only) |
| Usage/History composed from syncs + versions | A rich per-secret event-timeline endpoint (events-worker owns the stream; composed client-side here) |
| Relocating org Settings/Flags/Policies to `/settings/config` | The SecretPolicy tester surface (kept where it lives) |

## Relationship to existing work

- **SM (secret manager)** — this epic is the console for SM's write-only store,
  versions, syncs, rotation, reveal. No storage/crypto change beyond SC4's
  additive `generated` source.
- **SP (secrets platform)** — the wizard's Broker path is SP's brokered-create
  surface, re-expressed as a first-class step of the unified wizard.
- **IX3 (infrastructure archetype)** — the per-integration Secrets tab stays;
  this epic adds the **cross-integration** Secrets home and the shared detail
  page. `secret-model.ts` (IX3's binding/rotation filter) is reused.
- Supersedes the multi-tab `ConfigSurface` chrome **on the Secrets route only**;
  the surface stays as-is on the project/env config pages, and org
  Settings/Flags/Policies move back to `/orgs/[slug]/settings/config`.
