# Risks & open questions — saas-integrations-console

## Risks

- **R1 — No local full-stack.** The console talks to real api-edge; there is no
  MSW/mock backend. Mitigation: pure view-models + jest component tests as the
  gate, `/demo` mock-data gallery for screenshots, live checks on stage separately.
  New surfaces must be pure functions of props so they are testable without a
  backend.
- **R2 — Env-gated providers.** Slack app / Cloudflare / Supabase OAuth are
  registration-gated per environment (IH). Surfaces must degrade honestly
  (skeleton → empty → "not configured"), never a baked fallback (SP-A5 discipline).
- **R3 — Superseding the generic space.** IR2/IR-U folded connection detail into
  `ProviderSpace`; IX5 must migrate without dropping its reused sub-components
  (admission, activity, channels, repositories, secret wizard) or breaking deep
  links (`?create=1`, `?connect=1`, legacy `int_…` redirect). Mitigation: reuse
  the components, keep the route model, redirect legacy paths.
- **R4 — Scope creep into other domains.** Notification routing touches
  notifications-worker/ES territory. IX4 ships only the per-connection authoring
  surface with an explicit boundary; it does not implement delivery.

## Open questions

- **Q1 (IX3). RESOLVED.** `PublicSecretMetadata` carries `binding.connectionId`
  (brokered) and `rotation.connectionId` (rotated), so a connection's produced
  secrets are filtered client-side from the org secrets list (`secret-model.ts`
  `connectionSecrets`). No new endpoint was needed. Limitation: the org-scope
  list only catches org-scoped secrets; project/env-scoped brokered secrets are
  not surfaced on the connection's Secrets tab (a later slice could add a chain
  read).
- **Q2 (IX2).** Repository All/Selected: is there (or should there be) a write
  path to set the installation's selected repos from the console, or does editing
  stay a "Manage on GitHub" deep link? Default: read + filter + deep link; a write
  path is a later slice if desired.
- **Q3 (IX4). RESOLVED.** The mockup shows fixed event→channel routes with
  on/off, so a per-route boolean suffices — persisted in the existing
  `capability_prefs` blob (no new table/column/migration). Per-route channel
  *binding* (choosing which channel a route posts to) is a later slice.
- **Q4 (IX2/IX4).** `capability_prefs` / routing on `PublicConnection`: confirm no
  read-model consumer breaks when the field is absent (additive, optional, default
  applied server-side).
- **Q5 (detail routing).** For `multiConnection` providers, does "Manage" from the
  hub target the provider page (single active connection) or disambiguate when
  several are active? v1: single active → provider page; multiple → the provider
  page lists connections and Manage targets `…/connections/{id}`.
