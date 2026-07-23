# Epic: saas-integration-registry (IR)

**One registry, one page per integration, every plane derived.** Today the
platform has *two* integration systems (the integrations hub and the AI/compute
provider panel), *three* console surfaces per provider in the worst case
(hub card + connection detail + provider space), *three* parallel provider
registries (worker adapter registry, hardcoded console catalog, authoring-surface
registry), and a CLI that can only see the secrets slice of a provider. This
epic collapses all of that into a single **Integration Registry**: every
integration — GitHub, Slack, Cloudflare, Supabase, Anthropic, OpenAI,
OpenRouter, Daytona, and every future provider — is described by one
**Integration Manifest**, listed on one Integrations tab, owns one canonical
drill-down space that is *its* product home, and projects itself into the CLI
as a pluggable command namespace. Cloudflare — the provider that accreted two
disjoint surfaces and three copies of its scope grammar — is the unification
proof.

## Status

| Field | Value |
|-------|-------|
| Status | **Shipped** (2026-07-23) — IR0 #596 · IR1 #597 · IR2 #598 · IR3 #599 · IR4 #600 · IR5 #601 · IR6–IR9 #602 · CLI: orun ICL0–ICL3 #559; as-built record in `IMPLEMENTATION-STATUS.md` |
| Cluster | **IR** (integration registry — unifies **IH** capability seam + **SP** secrets-platform ownership + the **AG** provider panel into one registry and one IA) |
| Owner(s) | `apps/integrations-worker` (registry + manifests), `apps/web-console-next` (unified hub + integration spaces), `apps/config-worker` (unchanged substrate), `apps/agents-worker` (consumes re-homed connections), `packages/{contracts,sdk,cli}`, `orun` CLI (`specs/orun-integrations-cli/` — the cross-repo twin) |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `saas-integrations` (IG: provider seam, connect discipline, broker) · `saas-integration-hub` (IH0 capability-typed adapters, IH4–IH7 broker + brokered secrets) · `saas-integration-tenancy` (scope/share-mode) · `saas-secrets-platform` (SP0–SP6, **shipped 2026-07-23**: `SecretsCapability`, authoring primitives + registry, the provider space route, runtime scope templates, CLI capability-driven authoring) · `saas-agents` (AG5–AG7: `agents.provider_connections`, Daytona plane, key custody in config-worker) |
| Decisions locked | (1) **One manifest, one registry, N projections** — the `IntegrationManifest` is declared in code beside each adapter and aggregated by integrations-worker; the console catalog, the authoring registry, the secrets-capability read, and the CLI command tree become *projections* of it, never peers; (2) **identity unifies, planes stay put** — no new workers: integration *identity* (connection rows, custody, registry) is owned by integrations-worker; capability *planes* (secret substrate, message delivery, compute/sessions) stay in their bounded contexts and consume credentials over the existing internal seams — AI providers and Daytona re-home their **connections** into `integrations.connections` while `agents.provider_connections` becomes a provider-facts table (the `cloudflare_accounts` pattern) and key custody stays exactly where it is; (3) **the space is the page** — `/orgs/{slug}/integrations/{provider}` is the single canonical home per integration (standard chrome + capability-driven tabs + manifest-declared provider modules); connection detail nests under it; the hub, the Secrets lens, Cmd-K, and every deep link route to it; legacy routes redirect, never break (SP-A4 discipline); (4) **Cloudflare's scope grammar has one source** — `TEMPLATE_PERMISSION_GROUPS` in the adapter is canonical; the connect recipe, the authoring surface, and the docs derive from the manifest — the modal's hand-mirrored copy is deleted; (5) **connect posture is manifest-declared, environment-resolved** — the console never special-cases a provider id again (the `provider.id === "cloudflare"` branch dies); the manifest lists ordered connect methods and the registry read reports which are live per environment; (6) **CLI commands are registry-served** — the manifest's `cli` block declares a verb tree the orun binary renders at runtime (the SP5 pattern generalized from one verb to the whole namespace); native Go commands may *extend* a namespace, never contradict it. |
| Gate | IR0–IR4 and IR6–IR9 are human-independent (fixtures + shipped rails). IR5 (AI/Daytona re-home) needs a product sign-off on the migration window for the `settings/ai-providers` surface (redirect posture is designed, see risks IR-D3). |

## Thesis

The integrations platform won its architectural bets: the capability-typed
adapter seam (IH0) made providers pluggable in the worker; the secrets-platform
inversion (SP) made each integration own its secret authoring; the broker made
credentials short-lived by default. But each bet shipped its own *surface* and
its own *catalog*, and nobody owns the whole:

- **Two systems.** `integrations.connections` (GitHub/Slack/Cloudflare/Supabase)
  and `agents.provider_connections` (Daytona/Anthropic/OpenAI/OpenRouter) are
  separate schemas, workers, contracts, and UI components — visually stitched
  together on one hub page (`integrations-hub.tsx` embeds the agents panel),
  which is exactly where users see the seam: AI providers have no space, no
  activity, no capability read, no CLI surface, different connect UX, different
  health vocabulary.
- **Three catalogs.** `KNOWN_PROVIDER_IDS` (worker), `INTEGRATION_PROVIDERS`
  (console, hardcoded), `AGENT_PROVIDERS` (agents contracts) — plus the
  authoring-surface registry. SP0 deleted the *secrets* hardcodes by serving
  `SecretsCapability`; everything else about a provider is still baked into
  whichever surface needed it first.
- **Three Cloudflare surfaces, three scope-grammar copies.** The connect modal
  (hub-special-cased), the connection detail, and the provider space split one
  product story across three pages; `PARENT_TOKEN_RECIPE` hand-mirrors
  `TEMPLATE_PERMISSION_GROUPS` and admits it in a comment.
- **A keyhole CLI.** `orun integrations {provider} secret create` is
  capability-driven and catalog-free (the right pattern) — but it is one verb;
  connections, health, templates, mint history are console-only.

The registry is the move that pays all four debts at once, because every one of
them is the *same* debt: provider knowledge scattered across surfaces instead
of declared once. After IR: an integration is **one manifest** (identity,
category, connect methods, capabilities, surface modules, CLI verbs) declared
beside its adapter; the hub, the space, the Secrets lens, Cmd-K, and the orun
CLI all *derive*. Onboarding provider N+1 — or evolving provider 3 in its own
direction — touches the manifest and the adapter, and every plane lights up.

## How it maps to the references

| Reference | Here |
|-----------|------|
| Vercel Marketplace: one directory, one page per integration | Unified hub from the registry read; `/integrations/{provider}` space as the canonical home |
| Stripe Apps: app manifest declares surfaces + permissions | `IntegrationManifest`: capabilities + surface modules + CLI verbs, declared in code, served over the wire |
| Doppler/Vault UI: secret engines with per-engine pages | Capability-driven tabs (Secrets/Templates only when declared); the SP ownership boundary rendered as IA |
| `gh`/`stripe` CLI: one namespace per product area, server-described | `orun integrations {provider} …` verb tree rendered from the manifest's `cli` block |
| Terraform provider registry: schema-described, versioned | Manifest versioning + additive evolution rule; dormant manifests prove pluggability |

## Read order

1. `README.md` (this file) — status + thesis + milestones-at-a-glance.
2. `design.md` — the manifest schema, the registry read, the unified IA,
   per-provider spaces (Cloudflare unification, GitHub/Slack/Supabase, AI +
   Daytona re-home), the outcome-first secret wizard, the CLI command
   projection, service topology, governance.
3. `implementation-plan.md` — IR0–IR9, each with "done when".
4. `risks-and-open-questions.md` — migration windows, route collisions,
   manifest-versioning rules, re-home data migration.
5. `../../../../orun/specs/orun-integrations-cli/` — the cross-repo CLI twin
   (pluggable command rendering in the Go binary).

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| IR0 | **The manifest + registry read**: `IntegrationManifest` type beside each adapter; `GET …/integrations/registry` bulk read (per-env live/dormant resolution, ETag); secrets-capabilities read re-expressed as a projection; contracts + SDK | ✅ Shipped |
| IR1 | **Unified hub**: the Integrations tab renders every integration from the registry (categories: Source control · Messaging · Infrastructure · AI providers · Compute); connected-state summaries; hub special-cases deleted; agents panel embedding retired | ✅ Shipped |
| IR2 | **The canonical space**: `/integrations/{provider}` standard chrome (header · Overview · Connections · Secrets\* · Templates\* · Activity · Settings — \* = per capability); connection detail nests at `/integrations/{provider}/connections/{id}`; legacy `[connectionId]` + `providers/[providerId]` routes redirect | ✅ Shipped |
| IR3 | **Cloudflare unified**: connect folds into the space (posture from manifest: OAuth-if-configured, else token recipe *derived from the adapter's grammar*); multi-account first-class; scope-knowledge single-sourced; the modal's mirrored recipe deleted | ✅ Shipped |
| IR4 | **Secret creation v2**: the outcome-first wizard (use-case → where → lifecycle → review with plain-language grant summary) built on SP1 primitives; replaces the tab-shaped authoring dialog for brokered/rotated; declarative providers inherit it | ✅ Shipped |
| IR5 | **AI + compute re-home**: `anthropic`/`openai`/`openrouter`/`daytona` become registry integrations (`connectKind: "apikey"`); connection identity moves to `integrations.connections`; `agents.provider_connections` becomes the facts table; custody untouched; `settings/ai-providers` redirects to the spaces | ✅ Shipped |
| IR6 | **Provider spaces earn their keep**: GitHub (Repositories + installs + recent `scm.*`), Slack (Channels + `/orun` + recent `messaging.*`), Supabase (Projects), Daytona (Sandboxes + usage), AI providers (Models + key health + usage) as manifest-declared modules | ✅ Shipped |
| IR7 | **CLI projection**: the manifest `cli` block; registry read consumed by orun; `orun integrations` lists from the registry; per-provider verb trees rendered at runtime; SP5's secret verbs re-expressed as the first served tree (cross-repo: `orun/specs/orun-integrations-cli/` ICL0–ICL3) | ✅ Shipped |
| IR8 | **Registry governance**: manifest versioning + additive-evolution lint, dormant-manifest handling, per-env posture reporting, entitlement/policy projection into the read, docs generation from manifests | ✅ Shipped |
| IR9 | **Pluggability proof**: one dormant provider (AWS) lights up hub card + space chrome + CLI tree from a manifest-only change; one *live* provider onboarded end-to-end with zero console/CLI substrate edits | ✅ Shipped |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The `IntegrationManifest` + registry read; unified hub; the canonical per-integration space + nested connection detail + redirects; Cloudflare surface unification + single-sourced scope grammar; the outcome-first secret wizard; AI/Daytona connection re-home (identity only); provider space modules; the CLI command projection (+ the orun-side renderer, specced cross-repo); manifest governance; pluggability proof | New providers beyond the proof (each is its own follow-up); moving key **custody** or the secret substrate (SP/SM own it, unchanged); moving message delivery (ES/notifications own it); moving compute orchestration (agents-worker owns it); inbound events for Cloudflare/Supabase (still deferred per IH); marketplace billing/rev-share; user-authored workflow builders; per-integration microservices (explicitly rejected — see design §8); breaking any shipped route, wire shape, or CLI verb (redirect/alias only) |

## Relationship to existing work

- **IH (`saas-integration-hub`)** — owns the adapter capability seam. IR adds
  the *manifest* beside it (metadata, not behavior) and deletes the console
  catalogs that duplicated it. No adapter behavior changes.
- **SP (`saas-secrets-platform`, shipped)** — IR is SP's IA payoff. SP inverted
  ownership (integration owns authoring) and shipped the provider space; IR
  makes that space *the* page, generalizes the capability read into the full
  manifest read (secrets-capabilities becomes a projection, wire-compatible),
  and upgrades the default + Cloudflare authoring surfaces into the wizard.
  Every SP invariant (substrate owns value, integration owns authoring,
  SP-A1 bulk read, SP-A5 no-hardcode-fallback) is preserved.
- **AG (`saas-agents`)** — keeps the sandbox plane, session identity, and
  key-custody seams untouched. IR5 moves only the *connection identity* into
  the integrations context, following the facts-table pattern the hub already
  uses for every other provider.
- **IT (tenancy)** — re-homed connections inherit `scope`/`share_mode`
  semantics for free; AI provider keys gain account-sharing as a side effect
  (flagged in risks as a deliberate feature, IR-D4).
- **PX/U (console UX)** — the space uses the shipped design system; empty/
  skeleton/error states per `saas-console-ux`; Cmd-K entries derive from the
  registry.
- **orun (`specs/orun-integrations-cli/`)** — the cross-repo twin: the Go-side
  registry client, command renderer, offline cache, and native-extension seam.
