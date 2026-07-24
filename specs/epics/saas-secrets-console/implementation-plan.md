# Implementation plan — saas-secrets-console (SC1 → SC4)

> Each slice lands behind tests and is independently shippable. The write-only
> invariant holds at every slice — no list/detail query ever reads a value.
> Reuse the pure view layer (`secrets-view.ts`) rather than re-deriving in JSX.

## SC1 — Derivation foundation + redesigned Secrets home

- **Build.** Extend `apps/web-console-next/src/components/config/secrets-view.ts`
  (pure, no React/DOM, no value) with:
  - `secretLifecycle(meta) → 'fresh' | 'rotated' | 'static'` (per `design.md`).
  - `secretSourceKind(meta) → 'supabase' | 'cloudflare' | ... | 'static' | 'generated'`
    (from `source` + `binding.provider`).
  - `secretHealthNote(meta, now) → { tone, label } | null` (unused-N-days /
    static-N-days / rotation-overdue / orphaned).
  - `lastActivityLabel(meta, now)` and `scopeLabel(meta, projects, envs)`.
  - `secretsOverview(secrets, now)` → `{ total, scopesCount, fresh, rotated,
    static, bySource, attention[] }` for the stat cards + banner.
  - Unit tests in `tests/web-console-next` for every branch.
  - Rebuild the Secrets home (`secrets-console.tsx` + a new
    `secrets-hub.tsx`): serif `PageHeader` + lede, `+ New secret`, four
    `StatCard`s, `AttentionBanner`, the filter bar (search `Input` + lifecycle
    `Segmented` + source `Chip`s), and the five-column table (Northwind
    `ListRow`/grid) with source icons, lifecycle `Badge`s, status dots, and the
    health subline. Rows link to the detail route (SC3; until then a stub).
  - The `+ New secret` button opens the existing create path until SC2 (kept
    functional).
  - **Relocate** org Settings/Feature-flags/Policies: un-redirect
    `/orgs/[orgSlug]/settings/config` to render `ConfigSurface` (minus Secrets)
    at org scope, and drop those tabs from the Secrets route. Project/env config
    pages are unchanged.
- **Done when.** The Secrets home matches the mockup's list frame; `pnpm -F
  web-console-next typecheck && lint` clean; new `secrets-view` tests pass; org
  Settings/Flags/Policies remain reachable; no value enters any query.

## SC2 — The New Secret 4-step modal wizard

- **Build.** A `secret-create-wizard.tsx` modal `Dialog` + a pure
  `secret-create-lib.ts` (step model, `sanitizeKey`, review/summary strings,
  validity per step) with unit tests. Steps per `design.md`:
  - *Source* — three source cards.
  - *Configure* — Broker (provider tabs from connected brokers +
    `listSecretsCapabilities`/`listScopeTemplates` grants), Paste (key +
    password value), Generate (key + format chips + masked preview).
  - *Scope & lifecycle* — scope breadcrumb + lifecycle cards / reminder / rotate
    toggles.
  - *Review* + *Ready* (copy `secrets.KEY`, View secret / Done).
  - **Wire writes** through the existing seams: Broker →
    `useCreateBrokeredSecret`; Paste → `createSecretMetadata` (write-only
    value); Generate → WebCrypto value + `createSecretMetadata`, adding
    `rotationPolicy: '90d'` when auto-rotate is on (upgraded to the real
    `createGeneratedSecret` in SC4).
  - Grants come from the live capabilities read; degrade honestly when no broker
    is connected (Broker card disabled with a "Connect an integration" hint).
- **Done when.** All three paths create a real secret at the chosen scope and
  land on the Ready screen; the list refetches; `secret-create-lib` tests pass;
  typecheck/lint clean; the wizard never persists a value it shouldn't.

## SC3 — The secret detail page

- **Build.** Route `apps/web-console-next/src/app/(app)/orgs/[orgSlug]/secrets/[secretKey]/page.tsx`
  + a `secret-detail.tsx`. Resolve the secret from the scope's metadata read
  (by `secretKey`). Header (icon, key, lifecycle badge, attention badge,
  subtitle), **Copy reference**, **Rotate now** (lifecycle ≠ fresh →
  `rotateSecret`/`rotateScopedCredential`). Tabs:
  - *Overview* — three cards + `secrets.KEY` reference + HOW IT LIVES + Revoke
    danger zone (two-step arm → `revokeSecret`, then back to the home).
  - *Usage* — `listSecretSyncs({ secretKey })` consumer rows + `lastUsedAt`;
    empty state.
  - *History* — `listSecretVersions` composed with created/rotated anchors into
    the colored-dot timeline; footer note.
  - Promote the ad-hoc version/sync query keys into `qk` where touched.
- **Done when.** Detail renders for fresh/rotated/static/brokered secrets with
  correct actions; rotate + revoke work and invalidate the right caches;
  typecheck/lint clean; no value read.

## SC4 — Generated-secret primitive + aggregate + polish

- **Build (backend).** Add `source='generated'` end to end:
  - Additive migration widening `secret_metadata.source` CHECK to admit
    `'generated'` (+ optional `generated_format` for display).
  - `config-worker` `create-secret.ts` branch: server-side high-entropy value
    (hex/base64/uuid) → encrypt → store as a normal versioned head; optional
    `rotationPolicy` → the RS2 rotation engine gets a **re-generate** branch
    (`source='generated'` re-mints a fresh random value on cadence, no provider).
  - Contract `CreateGeneratedSecretRequest` + `PublicSecretMetadata.source`
    union widened; SDK `createGeneratedSecret`.
  - Rewire the wizard's Generate path onto it (drop the client-side value).
  - Permission-diff / no-value-in-audit assertions carried.
- **Build (console).** Optional org-level cross-scope aggregate so the home's
  "{N} across {M} scopes" reflects secrets at/under the workspace (either a
  `?descendants=true` read or a documented deferral); final pixel/a11y pass vs
  the mockup (focus order, dialog semantics, dark mode); retire the dead
  old-surface code paths superseded by SC1–SC3.
- **Done when.** Generate creates a real `generated` secret (and auto-rotates
  when asked); all workers + web typecheck/lint/test green; the epic's surfaces
  match the mockup; `IMPLEMENTATION-STATUS.md` marks SC1–SC4 shipped.

## Invariants carried at every slice

- No plaintext/envelope in any list/detail query or cache; values only in the
  wizard's transient inputs and the (out-of-scope) audited reveal.
- Lifecycle/health are **derived**, never persisted (except SC4's `source`).
- Pure logic (`secrets-view.ts`, `secret-create-lib.ts`) is unit-tested in
  isolation; JSX stays thin.
- Org Settings/Flags/Policies stay reachable; project/env config pages
  unchanged.
