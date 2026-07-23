# saas-integration-registry — Design

Status: Draft (normative once IR0 lands)

Written against repo reality as of 2026-07-23: IG0–IG4/IG9, IH0–IH8 substrate,
IT1–IT8, SP0–SP6 all shipped; the console has a hub
(`components/integrations/integrations-hub.tsx`), a per-connection page
(`/integrations/[connectionId]`), a per-provider space
(`/integrations/providers/[providerId]`), and a separate AI/compute panel
(`components/agents/provider-connections.tsx` + `settings/ai-providers`);
the orun CLI has capability-driven secret authoring
(`cmd/orun/command_integrations.go` + `internal/configsurface`).

## 1. The problem, stated as an invariant violation

The platform's own rule — *declare once, derive everywhere* — is honored for
secrets (SP0 deleted the hardcoded lists) and violated for everything else
about a provider. Provider knowledge lives in **six** places today:

| Knowledge | Where it lives | Consumers that re-encode it |
|---|---|---|
| Provider ids + display identity | `providers/registry.ts` (worker) · `components/integrations/providers.ts` (console) · `@saas/contracts/agents` `AGENT_PROVIDERS` | hub, Cmd-K, docs |
| Connect posture | adapter `connectKind` · console catalog `connectKind` · `integrations-hub.tsx` special-case (`provider.id === "cloudflare"`) | hub connect dispatch |
| Secrets capability | `SecretsCapability` (SP0, served) — the one solved case | console, config-worker, orun CLI |
| Scope grammar | `TEMPLATE_PERMISSION_GROUPS` (adapter) · `PARENT_TOKEN_RECIPE` (connect modal, hand-mirrored) · `integrations.scope_templates` (runtime) | modal, authoring, docs |
| Console surfaces | route tree + `authoring-registry.ts` graft + hub embedding of the agents panel | navigation, deep links |
| CLI surface | `command_integrations.go` (one verb, capability-driven) + static cobra tree | orun binary |

Every inconsistency the console audit found (three Cloudflare declarations of
connect posture; the agents panel stitched into the hub; the recipe comment
that admits it mirrors the adapter) is a symptom of the same missing object.
This epic introduces that object.

## 2. The Integration Manifest

One TypeScript object per provider, declared **beside its adapter** (same file
family as `providers/{id}.ts`), typed in `packages/contracts`:

```ts
interface IntegrationManifest {
  // — Identity —
  id: IntegrationProviderId;            // "github" | … | "anthropic" | "daytona" | …
  displayName: string;
  category: "source-control" | "messaging" | "infrastructure"
          | "ai-provider" | "compute";
  tagline: string;                      // hub card + space header copy
  docsSlug: string;                     // web-docs anchor, generated (IR8)

  // — Connect —
  connect: ConnectMethod[];             // ordered preference; console renders 1st *live* one
  multiConnection: boolean;             // may an org hold >1 active connection?
  // ConnectMethod = { kind: "install" | "oauth" | "token" | "apikey",
  //   requires?: EnvSlot[],            // env secrets that must exist for "live"
  //   recipe?: RecipeRef }             // derived guidance (e.g. Cloudflare token recipe)

  // — Capabilities (mirrors of the adapter's capability objects; metadata only) —
  capabilities: CapabilityId[];         // "inbound" | "scm" | "messaging"
                                        // | "credential-broker" | "secrets" | "provision"
                                        // | "ai-inference"   (IR5, new)

  // — Surfaces (what the console derives) —
  space: {
    tabs: SpaceTab[];                   // subset of the standard chrome, per capability
    modules: ModuleRef[];               // provider modules: "repositories" | "channels"
                                        // | "projects" | "sandboxes" | "models" | custom
    authoring: "declarative" | "custom"; // SP1 registry key, absorbed here
  };

  // — CLI (what the orun binary derives; §9) —
  cli?: {
    namespace: string;                  // = id
    verbs: CliVerb[];                   // declarative verb tree → typed endpoint calls
  };

  // — Governance —
  entitlement: string;                  // feature.integrations.{id}
  policyActions?: string[];             // additions beyond the standard set
  version: number;                      // manifest version; additive-only evolution
  status: "live" | "dormant" | "roadmap";
}
```

Rules:

- **The manifest is metadata, never behavior.** Adapters keep every behavior
  (connect, verify, mint, normalize). A manifest field that would require the
  console to *do* provider-specific work is wrong by construction — it should
  be a module or an adapter method instead.
- **The adapter is the source for anything it already knows.** `connect[].kind`
  must equal the adapter's `connectKind` options; `capabilities` must equal the
  capability objects present; the secrets slice must equal `SecretsCapability`.
  IR0 adds a unit lint (`manifest-conformance.test.ts`) asserting exactly this,
  so the manifest can never drift from the adapter the way the console
  catalogs did.
- **Additive evolution** (the contracts rule): fields are added, never
  repurposed; `version` bumps on additions; consumers ignore unknown fields.

## 3. The registry read (IR0)

```
GET /v1/organizations/{orgId}/integrations/registry
→ 200 { registry: IntegrationDescriptor[], etag }
```

- `IntegrationDescriptor` = manifest **projected per environment + org**:
  each `connect[]` entry gains `live: boolean` (its `requires` env slots are
  present — the `getConfiguredProvider` gate, reported instead of hidden);
  entitlement state is projected (`entitled: boolean`, from the shipped
  per-org entitlement seam) so the hub can render locked cards with the U7
  upgrade UX without a second read.
- Served on the public actor-authed surface under `/integrations/` — matched
  by api-edge's existing `ORG_INTEGRATIONS_RE`, **zero api-edge changes**
  (the SP-A1 precedent).
- One bulk read, long `staleTime`, ETag'd — manifests change per deploy
  (+ scope-template edits bump nothing here; templates stay on their own read).
- **Projections, not peers:**
  - `GET …/integrations/secrets-capabilities` (SP0) is re-expressed as a
    filter over the registry — same wire shape, same handler path signature,
    zero client breakage. Internally one source.
  - `components/integrations/providers.ts` (`INTEGRATION_PROVIDERS`,
    `availableProviders`, `roadmapProviders`, `popupConnectMethod`) is
    **deleted**; the console derives from the registry query (one query key,
    `qk.integrationRegistry(orgId)`).
  - `AGENT_PROVIDERS` remains for agents-worker internals but stops feeding
    any UI catalog after IR5.
- Degradation follows SP-A5: while the read is loading/failed, connect entry
  points render disabled with a hint; **never** a baked-in fallback list.

## 4. Unified hub (IR1)

`/orgs/{slug}/integrations` renders **one** system:

- **Sections by category** (registry-driven order): Source control · Messaging
  · Infrastructure · AI providers · Compute. The "AI & compute providers"
  kicker that embeds `components/agents/provider-connections.tsx` is retired
  in IR1 (cards render from the registry like everyone else; their connect
  flows keep working against the agents endpoints until IR5 re-homes them —
  the card is registry-chrome either way).
- **Card anatomy** (uniform): logo/name/tagline · status chip (Connected ·
  n connections / Available / Configure — env not ready / Locked — plan ·
  Roadmap) · primary action (Open space / Connect / Upgrade). No per-provider
  branches: the card is a pure function of the descriptor. The
  `provider.id === "cloudflare"` special case and `setCloudflareOpen` die
  here; **connect always navigates to the space**, which owns the flow (§5).
- **Roadmap strip**: `status: "roadmap"` manifests (aws, discord) render as
  non-interactive cards — same source of truth as live ones, so "ghost"
  drift can't recur.
- Cmd-K: "Open {provider}", "Connect {provider}" entries derive from the
  same query.

## 5. The canonical space (IR2) — the integration's product home

### 5.1 Route model

```
/orgs/{slug}/integrations                          → hub
/orgs/{slug}/integrations/{provider}               → THE page (canonical)
/orgs/{slug}/integrations/{provider}/connections/{connectionId}
                                                   → nested connection detail
```

Next App Router can't host `[connectionId]` and `[providerId]` as sibling
dynamic segments, and today's `int_…` public ids make the two distinguishable
by shape. Resolution: one `[slug]` segment whose page resolves by shape —
provider id → render space; `int_…` → **redirect** to
`…/{provider}/connections/{id}` (resolving the provider from the
already-fetched connections list, the SP-A4 pattern). The
`/integrations/providers/[providerId]` route becomes a redirect stub to
`/integrations/{provider}` (mirroring the shipped `settings/integrations`
stub). Bookmarks, `?connection=` pre-selection, and the `?create=1` deep link
all carry through.

### 5.2 Standard chrome (substrate-owned)

Every space renders the same skeleton; capability flags decide which tabs
exist. The chrome is substrate code — a provider cannot restyle it, only fill
its slots (the SP2 rule, promoted from the secrets section to the whole page):

| Region | Content | Present when |
|---|---|---|
| Header | identity, category, connect-state summary, health badge, primary CTA (Connect / Add connection when `multiConnection`) | always |
| **Overview** | connection cards + health, provider module summaries, recent activity teaser, "what you can do here" empty state | always |
| **Connections** | list → nested detail (facts, granted scopes/policies table, admission/share panel, reauth, danger zone). Absorbs everything `connection-detail.tsx` renders today | always |
| **Secrets** | the SP2 authoring surface (default or custom) + this-provider's-secrets list + the IR4 wizard | `secrets` capability |
| **Templates** | the SP4 runtime template manager (base ⊆ custom, versioned, soft-retire) | `credential-broker` |
| **Activity** | mint ledger (broker) · inbound deliveries + replay (inbound) · provider events feed | per capability |
| **Settings** | entitlement state, default connection, provider-specific options module | always |

### 5.3 Provider modules (manifest-declared)

Modules are the "evolve in its own direction" seam — registered components
keyed by `ModuleRef`, grafted exactly like SP1's authoring registry
(side-effect import, fail-open to nothing):

| Provider | Modules |
|---|---|
| GitHub | **Repositories** (repo links + branch→env maps, absorbed from the project Git tab's org half), installs, recent `scm.*` |
| Slack | **Channels** (in-use channels from notification channels of kind `slack_app`, picker), **Commands & unfurls** status, recent `messaging.*` |
| Cloudflare | **Accounts** (multi-account facts + verified grant), token health | 
| Supabase | **Projects** (cached project list, per-project scoping hints) |
| Anthropic / OpenAI / OpenRouter | **Models** (available models, default model), **Key health** (verification status, last-verified, usage teaser from metering) |
| Daytona | **Sandboxes** (recent sessions from agents-worker read API), usage |

Modules read through existing worker APIs; a module never gets its own
credential path.

## 6. Cloudflare unified (IR3) — the proof by hardest case

End state: **one page** at `/integrations/cloudflare` that owns the whole
Cloudflare story. What changes:

1. **Connect folds into the space.** The hub CTA navigates to the space; the
   space's Connect panel renders per the manifest's ordered methods:
   `oauth` (when `CLOUDFLARE_OAUTH_CLIENT_ID/SECRET` are present → `live`) as
   the primary button, `token` always available beneath it. The
   `cloudflare-connect-modal.tsx` component survives as the token-method
   *panel* inside the space; its hub mounting and the hub special-case are
   deleted.
2. **The recipe is derived.** `PARENT_TOKEN_RECIPE` is deleted; the token
   panel renders the recipe from the registry descriptor, which the adapter
   computes from `TEMPLATE_PERMISSION_GROUPS` ∪ the account-tokens-edit
   requirement — one source, admitted drift eliminated. The verified-grant
   table on the connection detail uses the same grammar to diff *granted vs
   template-required* and can finally say "the `dns-edit` template exceeds
   this token's grant" with per-permission precision.
3. **Multi-account is first-class.** `multiConnection: true`; header CTA
   becomes "Add account"; every authoring flow, template, and mint is
   connection-scoped (already true in the data model — `uq` on
   `(connection_id, kind)` and per-connection binding — the UI just never
   offered it). Overview shows an account switcher chip-row.
4. **Everything Cloudflare in one IA:** Overview (accounts + token health) ·
   Connections (custody, grants, reauth, revoke fan-out) · Secrets (wizard +
   bound secrets) · Templates (SP4 manager) · Activity (mint ledger with
   run/actor links, revoke) · Settings. The two former pages become tabs of
   one; both old routes redirect with state carried.

## 7. Secret creation v2 — the outcome-first wizard (IR4)

The shipped authoring dialog is mechanism-first (pick mode tab → pick
connection → pick template → params). Operators think outcome-first. The
wizard inverts the order, built entirely on SP1 primitives (the substrate
still performs the governed write; nothing new touches ciphertext):

```
Step 1 — What do you need?      Use-case cards derived from scope templates
                                ("Deploy Workers", "Edit DNS on selected
                                zones", "Read-only account access", …custom
                                templates appear as cards too)
Step 2 — Where will it be used? Scope rung (org / project / environment)
                                + connection (pre-selected when only one;
                                account switcher when multiConnection)
                                + template params (zones, buckets) with
                                provider-backed pickers where facts exist
Step 3 — How should it live?    "Fresh per run" (brokered · recommended,
                                TTL note) vs "Managed & rotated" (rotation
                                policy + optional delivery target from
                                deliveryTargets())
Review —                        Key name (smart default e.g.
                                CLOUDFLARE_API_TOKEN), plain-language grant
                                summary ("Can deploy Workers and edit KV in
                                account Acme-prod; cannot touch DNS"), the
                                exact chain annotation orun plan will show,
                                then one governed write.
```

- The plain-language grant summary is computed from the same single-source
  grammar as §6.2 — a manifest projection, not new copy.
- Declarative providers get the identical wizard from their declaration
  (use-case cards = their templates); `authoring: "custom"` providers may
  replace Step 1/2 *content* but not the frame.
- The Secrets lens (substrate) keeps SP-A3 behavior: "New secret → From
  {provider}…" now deep-links into the wizard (`?create=1&template=…`).
- CLI parity: the wizard's review screen shows the equivalent
  `orun integrations cloudflare secret create …` invocation (copyable) —
  teaching the CLI surface from the UI.

## 8. AI providers + Daytona re-home (IR5) — and the services question

**Decision: identity unifies, planes stay put. No new workers, no
per-integration services.** Rationale, stated once: the bounded contexts are
capability planes (custody+broker / secret substrate / delivery / compute),
not provider silos. A per-provider service would shatter the shared
discipline (custody envelopes, mint ledger, signed-state connect, IT tenancy)
that makes providers cheap. The registry makes providers *look* independent
at the surface while staying cheap underneath — that is the whole trick.
Concretely rejected: a `registry-worker` (the registry is a read over
manifests integrations-worker already hosts — a new worker would add a hop
and a deploy surface for zero isolation win).

The re-home, mechanically:

1. **New connect kind** `apikey` (paste + verify + custody pointer): adapter
   family `providers/anthropic.ts`, `openai.ts`, `openrouter.ts`,
   `daytona.ts` in integrations-worker implementing core lifecycle +
   `ai-inference` / `provision` capability markers (metadata-only in v1;
   verification calls the same per-provider verify endpoints agents-worker
   uses today).
2. **Identity migration**: a migration inserts one `integrations.connections`
   row per `agents.provider_connections` row (provider, display name =
   `name`, status mapped from verification status); `agents.provider_connections`
   gains `connection_id` and becomes the **facts table** for those adapters
   (the `cloudflare_accounts` pattern) — named connections (`org, provider,
   name` uniqueness) map onto `multiConnection: true`.
3. **Custody does not move.** Keys stay in the config substrate under the
   reserved namespace (`agents/providers/…`), pointed at by `secret_ref`;
   agents-worker resolves them over the same internal seam it uses today.
   Zero change to sandbox env injection (`orun agent serve` contract
   untouched).
4. **Surfaces**: `settings/ai-providers` becomes a redirect stub to the
   spaces (the shipped `settings/integrations` precedent);
   `components/agents/provider-connections.tsx` is decomposed into the
   Models/Key-health/Sandboxes modules (§5.3).
5. **Tenancy**: re-homed connections get IT `scope`/`share_mode` — an
   account-shared Anthropic key serving all admitted workspaces becomes
   possible *by construction*; default stays workspace-private at migration
   (IR-D4).

## 9. The CLI projection (IR7, cross-repo with `orun/specs/orun-integrations-cli/`)

SP5 proved the pattern at n=1: the CLI validates against a server capability
read and carries no catalog. IR generalizes it to the namespace:

- **Manifest `cli` block** declares a verb tree; each verb maps to a typed
  invocation of an *already-public* endpoint (config plane or integrations
  plane) — a declarative verb can never reach an endpoint the SDK could not:

```ts
interface CliVerb {
  path: string[];                  // ["secret","create"] | ["connections","list"] | …
  summary: string;
  args: CliArg[];                  // positionals + flags, typed (string|int|enum|key=value)
  invoke: { plane: "config" | "integrations";
            op: string;            // SDK operation id, e.g. "createBrokeredSecret"
            bind: Record<string,string> };  // arg → request-field mapping
  needsConnection?: boolean;       // auto --connection resolution/prompt
}
```

- **The orun binary renders, never hardcodes** (ICL1): `orun integrations`
  lists providers from the registry read; `orun integrations {provider}`
  renders its verb tree as cobra commands at runtime; help text, completion,
  and typo suggestions derive. An offline manifest cache (per org, under
  `.orun/`) keeps help working without network; invocation always
  re-validates server-side.
- **Standard verbs for free** (from capabilities, no manifest entry needed):
  `connections list|get|revoke`, `health`, `templates list`, `secret create`
  (secrets capability — the SP5 verbs re-expressed), `credentials list|revoke`
  (broker), `sandboxes list` (provision). A provider ships CLI presence by
  existing.
- **Native extension seam** (ICL3): a Go-registered subcommand may *extend* a
  namespace for rich local behavior (e.g. `orun integrations cloudflare
  whoami` doing local token verify) — registered against the namespace, and
  the renderer refuses collisions with served verbs (served wins; native
  extends).
- Security posture: descriptors are data; the CLI maps them onto the same
  authed SDK calls with the same tenancy/token source (`internal/remotestate`
  precedence) — no descriptor-driven arbitrary HTTP, no local exec.

## 10. Governance (IR8)

- **Policy**: unchanged action vocabulary
  (`organization.integration.read/connect/manage`, `…credential.issue`,
  `secret.write`); re-homed AI connections adopt it (they previously rode
  agents-worker's checks — mapped 1:1, audited).
- **Entitlements**: per-provider keys exist for hub gating
  (`feature.integrations.{id}`); re-homed providers keep their existing
  agent-plane entitlements for *usage*, gaining only the connect gate.
  Registry read projects entitlement state (§3) — locked cards, 412 + U7
  upgrade UX.
- **Audit**: no new vocabulary; `integration.connected/…` now also emitted for
  re-homed providers (previously silent panel writes — an audit *gain*).
- **Docs**: `web-docs` provider pages generate their connect/recipe/template
  sections from manifests at build (IR8) — the last hand-mirrored copy dies.
- **Manifest conformance lint** (IR0) + **additive-evolution check** in CI:
  a manifest change that removes/repurposes a field fails the build.

## 11. What deliberately does NOT change

- The secret substrate, resolve path, envelope hierarchy, reveal discipline
  (SM/SP invariants) — untouched.
- Adapter behavior, connect discipline, custody, broker, ledger — untouched.
- The ES delivery seam, notification rules, channels — untouched.
- agents-worker's sandbox/session plane and the `orun agent serve` contract —
  untouched.
- Every shipped public route and wire shape — redirects and projections only.
- The orun CLI's existing verbs — `orun secrets` (substrate lens) and
  `orun integrations {provider} secret create` keep working verbatim; the
  latter becomes served-tree-rendered with identical UX.
