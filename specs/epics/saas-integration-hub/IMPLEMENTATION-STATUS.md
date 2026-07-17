# saas-integration-hub — Implementation Status

As-built record. Epic designed 2026-07-09 (#404) on the shipped IG/IT/ES
rails; implementation started 2026-07-09.

## Summary

| ID | Status |
|----|--------|
| IH0 | 🔄 In progress — capability seam, contracts, `730_integration_hub_foundation`, hub repo layer, dormant adapters |
| IH1 | 🗓️ Planned (gated: D1 Slack App per env) |
| IH2 | 🗓️ Planned |
| IH3 | 🗓️ Planned |
| IH4 | 🗓️ Planned |
| IH5 | 🗓️ Planned (gated: D3) |
| IH6 | 🗓️ Planned (gated: D4) |
| IH7 | 🗓️ Planned (rides SM1–SM3) |
| IH8 | 🗓️ Planned |
| IH9 | 🗓️ Planned |
| IH10 | 🗓️ Planned (optional tail) |

## Notes

- 2026-07-09: **Migration renumbered 700 → 730.** The design doc named the
  foundation migration `700_integration_hub_foundation`; between epic
  authoring and IH0 landing, the work context took slots 700–720
  (`700_work_v4_hierarchy`, `710_work_v4_snapshots`,
  `720_work_events_kind_check_repair`). Code reality wins; the design doc's
  `700_*` references read as `730_*`.
- 2026-07-09: IH0 as built:
  - **Capability seam** (`apps/integrations-worker/src/providers/types.ts`):
    `IntegrationProvider` = core (id, displayName, `connectKind`,
    `capabilities`) + optional capability objects (`inbound`, `broker`,
    `messaging`). The GitHub adapter is re-expressed behavior-identically —
    the legacy IG method names remain as delegating aliases so every shipped
    handler and test passes unchanged; the inbound handler now verifies via
    the capability object. Adapter capability lists reflect what each
    adapter object actually exposes today (GitHub advertises
    `credential-broker` from IH4, when the IG4 route is re-expressed on the
    generic core).
  - **Dormant adapters**: `slack` (real OAuth authorize-URL builder + v0
    signature verification with the ±300s window — pure, fixture-tested;
    gated on `SLACK_APP_*` secrets), `cloudflare` (v1 scope-template catalog
    published; mint parks `not_implemented` until IH5; gated on
    `SECRET_ENCRYPTION_KEY`), `supabase` (template catalog; mint parks until
    IH6; gated on `SUPABASE_OAUTH_*`). No route reaches any of them —
    connect routes are still GitHub-literal until IH1.
  - **Contracts**: `IntegrationProviderId` widened; provider descriptors
    (capabilities + connectKind), `IntegrationScopeTemplate`,
    `PublicMintedCredential` + mint request/response/list/revoke shapes,
    `messaging.*` event types + v1 payload projections, new policy actions
    (`organization.integration.credential.issue`,
    `organization.integration.messaging.manage`) and entitlement keys.
  - **DB**: `730_integration_hub_foundation` (provider_credentials,
    minted_credentials, slack_workspaces, cloudflare_accounts,
    supabase_orgs) + the additive `IntegrationHubRepository`
    (`packages/db/src/integrations/hub.ts`).
  - **Worker surface**: env gains the Slack/Supabase secret slots; `/health`
    reports `slackApp` / `supabaseOauth` / `credentialCustody` configured
    flags; `mint_` public-id helpers.
  - **Spec 17** amended (capability vocabulary, custody rules, messaging
    events, hub data ownership, internal seams).

## service-identity-bootstrap (SI1–SI6) — Shipped

Sub-epic `sub-epics/service-identity-bootstrap/` ("OAuth establishes trust,
service identities operate"), landed as #490 → #495 + the SI6 console PR:

- **SI1** — migration `840_service_identity_custody` (custody kinds
  `cloudflare_service_token` / `supabase_project_secret`,
  `credential_class` identity|infrastructure backfilled from kind, ledger
  `parent_kind`), candidate-order flip with dual-read, `provision`
  capability seam, `PublicMintedCredential.parentKind`.
- **SI2** — the Cloudflare OAuth callback provisions the account-owned
  `orun/{org}/service` token (template-union + token-administration grant,
  no provider expiry) and never stores the refresh token; mint/revoke
  posture dispatches on custody kind; connection revoke deletes the
  identity provider-side.
- **SI3** — hourly backfill sweep upgrades existing refresh-custody
  connections under the mint lock (rotate-safe, probe-before-swap,
  idempotent), emitting `integration.connection.upgraded`.
- **SI4** — Supabase per-project service-role keys custodied as one
  encrypted map (captured at connect, reconciled hourly); custody-served
  template class + `project-service-key` (zero management-API calls on the
  resolve path). Decision SI-D2: `db-migrate`/`functions-deploy` stay
  management-plane.
- **SI5** — `cloudflare_refresh_token` removed from mint candidates
  (structural deprecation); lifecycle surfaces read it explicitly; the
  callback's refresh fallback replaced by fail-closed guidance;
  grant-insufficient connections suspend with `service_identity_required`;
  daily in-place service-token rotation; orphan-sweep never-touch invariant
  for `orun/{org}/service` pinned by test.
- **SI6** — connection detail carries a metadata-only custody summary
  (`GetIntegrationResponse.custody`: class, user-tie, rotation age, safe
  scopes); the mint ledger names the authorizing custody class; hub cards
  state the provision-then-discard contract.
