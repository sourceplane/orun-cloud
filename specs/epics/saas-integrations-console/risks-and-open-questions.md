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

- **Q1 (IX3).** Does the org secrets list already surface `binding.connectionId`
  so a connection's brokered secrets can be filtered client-side, or is the new
  `GET /integrations/{connectionId}/secrets` read required? Resolve at IX3 build
  time; record in STATUS.
- **Q2 (IX2).** Repository All/Selected: is there (or should there be) a write
  path to set the installation's selected repos from the console, or does editing
  stay a "Manage on GitHub" deep link? Default: read + filter + deep link; a write
  path is a later slice if desired.
- **Q3 (IX4).** Should notification routing bind to a small
  `connection_notification_routes` table (per-route channel) or a JSONB fact on
  the connection? Decide by whether per-route channel selection is needed in v1
  (mockup shows fixed event→channel routes with on/off — a JSONB on/off map may
  suffice).
- **Q4 (IX2/IX4).** `capability_prefs` / routing on `PublicConnection`: confirm no
  read-model consumer breaks when the field is absent (additive, optional, default
  applied server-side).
- **Q5 (detail routing).** For `multiConnection` providers, does "Manage" from the
  hub target the provider page (single active connection) or disambiguate when
  several are active? v1: single active → provider page; multiple → the provider
  page lists connections and Manage targets `…/connections/{id}`.
