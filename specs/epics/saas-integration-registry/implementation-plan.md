# saas-integration-registry — Implementation Plan

Status: Draft. Milestones are ordered for incremental merge to `main`; each is
independently shippable and reversible (redirect/projection discipline — no
milestone breaks a shipped route, wire shape, or CLI verb).

Cross-repo pairing: IR7 pairs with `orun/specs/orun-integrations-cli/`
(ICL0–ICL3); the two plans reference each other and can land in either order
(the CLI renders from the registry read only when it exists; until then the
static tree stays).

## IR0 — The manifest + registry read

**Scope**
- `packages/contracts`: `IntegrationManifest`, `IntegrationDescriptor`,
  `CliVerb`, category/capability/connect-method enums; additive.
- `apps/integrations-worker`: `providers/manifests/{github,slack,cloudflare,supabase}.ts`
  beside the adapters; `manifests/{aws,discord}.ts` as `dormant`/`roadmap`;
  registry assembly (`manifest-registry.ts`) with per-env `live` resolution
  reusing the `getConfiguredProvider` gates; handler
  `GET /v1/organizations/{org}/integrations/registry` (actor-authed, ETag,
  entitlement projection); `secrets-capabilities` handler re-expressed as a
  filter over the registry (wire-identical — contract test pins the shape).
- `manifest-conformance.test.ts`: manifest ⊆ adapter (connect kinds,
  capabilities, secrets slice) for every registered + dormant provider.
- SDK: `client.integrations.getRegistry(orgId)`.

**Done when** the registry read serves all four live + two dormant
descriptors with correct per-env `live` flags in fixtures; the
secrets-capabilities response is byte-shape-identical to pre-IR0 recordings;
conformance lint is in CI.

## IR1 — Unified hub

**Scope**
- Console: hub renders from `qk.integrationRegistry(orgId)`; category
  sections (Source control · Messaging · Infrastructure · AI providers ·
  Compute); uniform card component (pure function of descriptor + connections
  summary); roadmap strip from `status: "roadmap"`.
- Delete `components/integrations/providers.ts` and every import
  (`archetype.ts` grouping re-keys off manifest `category`).
- Delete the hub's Cloudflare special-case and `setCloudflareOpen` path —
  connect CTA navigates to the space (until IR3 lands the space connect
  panel, the space mounts the existing modal component on arrival —
  one-milestone shim, noted in code).
- AI/compute cards render from registry descriptors (IR0 ships their
  `roadmap→live` manifests only with IR5; until then the section renders the
  embedded agents panel *under registry-driven section chrome* — the panel's
  last stand, removed in IR5).
- SP-A5 degradation states; Cmd-K entries from the registry query.

**Done when** the hub shows every integration in category sections from one
query; no console file hardcodes a provider list; connect on any provider
navigates to its space; skeleton/error/entitlement-locked states verified.

## IR2 — The canonical space + nested connection detail

**Scope**
- Route: `/integrations/[slug]` resolver (provider id → space; `int_…` →
  redirect to `…/{provider}/connections/{id}`);
  `/integrations/[slug]/connections/[connectionId]` nested detail;
  `/integrations/providers/[providerId]` → redirect stub (carry
  `?create=1&connection=&template=` through).
- Standard chrome: header (identity/health/CTA), tab bar derived from
  descriptor capabilities; Overview, Connections (absorb
  `connection-detail.tsx` into the nested route), Secrets (mount existing
  SP2 surface), Templates (mount SP4 manager), Activity (mint ledger +
  deliveries, reusing shipped components), Settings.
- Module registry (`space-modules.ts`, the SP1 graft pattern); Overview
  renders declared module summaries (modules themselves land in IR6 —
  Overview falls open to connection cards + activity teaser).
- Redirect tests for every legacy deep link inventoried in SP-A4.

**Done when** every provider has one canonical URL; both legacy routes 301
with state carried; connection detail is reachable only nested; the chrome
renders correct tabs per capability for all six descriptors (incl. dormant
AWS in a fixture story).

## IR3 — Cloudflare unified

**Scope**
- Space connect panel: ordered methods from descriptor (`oauth` primary when
  live, `token` beneath); `cloudflare-connect-modal.tsx` refactored into the
  token-method panel (form/reducer `token-connect-flow.ts` reused); delete
  `PARENT_TOKEN_RECIPE` — recipe rendered from descriptor
  (adapter-computed from `TEMPLATE_PERMISSION_GROUPS` + the account-token
  requirement; served in the registry read as `connect[].recipe`).
- Multi-account: `multiConnection: true`; "Add account" CTA; account
  switcher on Overview; authoring/templates/activity connection-scoped
  filters (data model already supports it).
- Grant diffing: connection detail's grant table diffs granted policies vs
  each template's required groups from the single-source grammar; health
  badge reflects `parent_grant_insufficient` per template.

**Done when** the Cloudflare story is one page (connect → accounts →
secrets → templates → activity) with zero scope-grammar duplication
(`grep` for permission-group literals finds only the adapter); two accounts
connected in fixtures render and scope correctly everywhere.

## IR4 — Secret creation v2 (the wizard)

**Scope**
- `components/config/secret-wizard.tsx` on SP1 primitives: use-case step
  (cards from active templates, custom templates included), where step
  (scope rung + connection + params with provider-backed pickers), lifecycle
  step (brokered vs rotated + delivery target), review (key-name smart
  default, plain-language grant summary from the shared grammar, chain
  annotation preview, CLI-equivalent copyable).
- Registered as the new default authoring surface; Cloudflare's custom
  surface re-expressed as wizard step-content overrides (frame is
  substrate); Supabase inherits the default wizard untouched (the
  declarative proof).
- Secrets-lens SP-A3 menu deep-links into the wizard; `?create=1&template=`
  pre-seeds Step 1.

**Done when** brokered + rotated creation for Cloudflare and Supabase flow
through the wizard end-to-end in fixtures; the old tab-dialog is removed;
grant summaries match the template grammar exactly (unit-tested against
`TEMPLATE_PERMISSION_GROUPS`); a11y pass on the stepper.

## IR5 — AI + compute re-home (gate: IR-D3 sign-off)

**Scope**
- Adapters `providers/{anthropic,openai,openrouter,daytona}.ts`
  (`connectKind: "apikey"`; verify via the same provider endpoints
  agents-worker uses); manifests flip `roadmap → live`.
- Migration `9NN_integration_registry_rehome`: insert
  `integrations.connections` per `agents.provider_connections`
  (status mapped: verified→active, unverified→pending, invalid→suspended);
  add `agents.provider_connections.connection_id` (facts-table turn);
  backfill; compat view for agents-worker reads until its repo layer
  re-points (same PR).
- Connect flow: apikey panel in the space (paste → verify → custody write
  via the existing config-worker provider-keys seam → facts row + connection
  row in one transaction path).
- `settings/ai-providers` → redirect stub; agents panel component deleted
  from the hub (decomposition into modules completes in IR6).
- Audit: `integration.connected/…` emitted on the re-homed lifecycle.

**Done when** every existing AI/Daytona connection appears as a registry
connection with identical behavior in the agent plane (session provisioning
fixture-verified pre/post), custody rows untouched (checksum), the old
settings page redirects, and rollback is a view-flip (documented).

## IR6 — Provider space modules

**Scope**
- Module components + registry entries: GitHub Repositories (org half of the
  Git tab; project tab keeps its project-scoped view), Slack Channels +
  Commands status, Cloudflare Accounts detail, Supabase Projects, AI Models +
  Key health (verification, last-verified, usage teaser from metering),
  Daytona Sandboxes (recent sessions via agents-worker read API).
- Overview compositions per provider; empty states per module.

**Done when** each live provider's Overview shows its modules with real
data in fixtures; no module holds a credential path (lint: modules import
only read hooks); the spaces visibly differ per provider while sharing the
chrome.

## IR7 — CLI projection (pairs orun ICL0–ICL3)

**Scope (this repo)**
- Manifest `cli` blocks: standard verbs derived from capabilities
  (connections/health/templates/credentials/secret) + provider-specific
  verbs; contracts for `CliVerb`; registry read already carries them (IR0).
- Verb→SDK `op` allowlist table + test: every `invoke.op` must be an
  existing SDK operation; bind-map type check.
**Scope (orun repo — specced in `orun/specs/orun-integrations-cli/`)**
- ICL0 registry client + cache · ICL1 runtime cobra renderer · ICL2 standard
  verb UX (table output, `--json`, typo suggestions) · ICL3 native-extension
  seam + collision rule.

**Done when** `orun integrations` lists providers from the registry;
`orun integrations cloudflare` renders its full tree with help/completion
offline from cache; `secret create` behaves byte-identically to SP5; a
dormant provider's tree appears with a manifest-only change (recorded
fixture); native-extension collision test passes.

## IR8 — Registry governance

**Scope**
- Additive-evolution CI check on manifests (field removal/repurpose fails);
  manifest `version` surfaced in the descriptor; docs generation: web-docs
  provider pages consume manifests at build for connect/recipe/template
  sections; dormant-manifest handling formalized (dormant descriptors are
  served with `status` so surfaces can fixture-test against them, but hub
  hides them outside the roadmap strip).

**Done when** CI fails on a destructive manifest edit (fixture); web-docs
Cloudflare page's recipe section is generated; a served dormant manifest
drives a full storybook/fixture pass of hub + space + CLI chrome.

## IR9 — Pluggability proof

**Scope**
- AWS dormant manifest gains full surface + cli blocks → hub card (roadmap),
  space chrome, CLI tree light up with zero substrate edits (the IH10/SP6
  proof, now covering every plane).
- One live onboarding rehearsal end-to-end documented as the "add an
  integration" runbook (manifest + adapter + module checklist), replacing
  the scattered per-epic notes.

**Done when** the proof PR touches only `providers/manifests/aws.ts` +
fixtures; the runbook exists and names every file a new provider touches
(target: ≤ 6).

## Sequencing

IR0 → IR1 → IR2 → {IR3, IR4} (parallel; IR4's Cloudflare overrides rebase on
IR3's panel) → IR5 → IR6 → IR7 (any time after IR0, ideally after IR3 so the
served Cloudflare tree is the rich one) → IR8 → IR9.
