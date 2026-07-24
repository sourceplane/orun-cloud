# Design — saas-integrations-console

Source of truth for the target UI: the **Orun Integrations Console** mockup. This
doc records the design and, for each surface, the existing read/write it maps to
(so the console stays a pure projection).

## Design language

Northwind (the shipped console system): serif display headings, sans body, mono
for identifiers; rounded-xl cards, hairline borders, generous whitespace; light
+ dark via tokens. Primitives reused: `Screen`, `PageHeader`, `Breadcrumbs`,
`Kicker`, `Pill`/`StatusDot` (tone), `Chip`/`ChipRow`/`ChipDivider` (the filter
bar), `ListCard`/`ListRow`/`RowChevron` (connected rows), `StatCard` (summary +
overview stats), `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` (underline tab
rail), `Switch` (capability + routing toggles), `EmptyState`, `Skeleton`,
`ConfirmDialog`, `useToast`, `Button`, `Badge`. New shared bits: a small
`SegmentedControl` (All-repos/Selected, Open-to-all/By-invitation, etc. — the
mockup's pill-segment; today done inline in `ConnectionAdmission`), and a
`ProviderTile` (the colored provider glyph tile).

## Archetype model

The detail page's tab set and body come from the provider's archetype. Rather
than a console-side map (the doomed `archetype.ts`), archetype is derived from
the served descriptor's `category` + declared `capabilities`:

| Archetype | Providers | Category | Tabs |
|-----------|-----------|----------|------|
| source-control | github | `source-control` | Overview · Repositories · Workspace access · Activity |
| messaging | slack | `messaging` | Overview · Channels · Notifications · Activity |
| infrastructure (secret-broker) | cloudflare, supabase | `infrastructure` | Overview · Secrets · Projects · Activity |
| ai-provider / compute | openai, anthropic, … | `ai-provider`/`compute` | Overview · Activity (models via space module) |

Derivation: `messaging` cap → messaging; `credential-broker`/`secrets` cap →
infrastructure; `scm` cap → source-control; else generic. The descriptor already
carries `space.tabs` + `space.modules`; IX treats those as the seam and only
falls back to the category derivation when a descriptor doesn't pin tabs. This
keeps a future provider's page a pure projection of its manifest.

## HUB — `/orgs/{slug}/integrations`

Reads (all exist): `integrations.list(orgId)` → connections; `getRegistry(orgId)`
→ descriptors; **new count only:** the org secrets list (config client) filtered
to `source === "brokered"` for the "Brokered secrets" stat. All derivations are
client-side.

- **Header** — serif "Integrations" + the orchestration-plane description;
  right: `Search integrations` input + `+ Connect` (opens the IX5 picker).
- **Summary stats** (3 `StatCard`s): Connected (N across M categories) · Brokered
  secrets (N from M providers) · Available (N ready to connect). Derived from the
  reads above.
- **Filter bar** (`ChipRow`): `All | Connected | Available` ‖ category chips
  (`Source control · Messaging · Infrastructure · AI providers`) present only for
  categories that have ≥1 descriptor. Pure client filter over the two lists.
- **Connected · N** — `ListCard` of `ListRow`s: `ProviderTile` · name · `• Connected`
  status · meta line (`{account} · {sharing} · {repo|secret summary} · {age}`) ·
  **Manage** → detail page · chevron. Meta comes from `PublicConnection`
  (scope/shareMode/repositorySelection/connectedAt) + counts.
- **Available · N** — grid of cards: name · Connect / Upgrade (entitlement 412) /
  "Not configured" (env-gated) · category kicker · tagline. This is today's
  `ProviderCard` restyled; card state from `cardState(descriptor, connections)`.
- **On the roadmap** — `status: "roadmap"` descriptors as one honest strip with a
  "Get notified" affordance.

## DETAIL — `/orgs/{slug}/integrations/{provider}` (single active connection) and `…/{provider}/connections/{connectionId}` (specific)

`Breadcrumbs` (‹ Integrations › {Name}) + header: `ProviderTile` · serif name ·
`• Connected` · UPPERCASE sharing badge (ACCOUNT-SHARED / WORKSPACE-PRIVATE) ·
subtitle (`{anchor} {external login} · {type} · authorized {date}`); right:
`Open on {Provider}` ↗ (external management URL, when the descriptor provides one).
Below: the archetype `Tabs`.

### Overview (all archetypes)
3 `StatCard`s tuned per archetype (GitHub: Repositories/Sharing/Connected;
Supabase: Projects/Managed secrets/Connected; Slack: Channels/Sharing/Connected).
Then an archetype block:
- source-control → **Capabilities** (`Switch` rows) — see new noun #1.
- infrastructure → **What Orun can broker** (descriptive rows from the provider's
  `secrets` capability `scopeTemplates()` / describe).
- messaging → folded into Channels/Notifications tabs.
Then a **danger zone** (Revoke) — reuses the existing revoke + orphan-safety
(`parseRevokeBlockers`, `?force=true`, `orphaned[]`).

### Repositories (source-control) — read `listRepositories(orgId, connectionId)`
`SegmentedControl` All repositories | Selected only. All → dashed note ("All N
repositories are accessible…"). Selected → filter input + `N of M selected` +
checkbox rows (repo + language). Selection reflects
`github_installations.repositorySelection`; editing the allowlist is a
**Manage on GitHub** deep link (the installation's repo set is GitHub-owned) —
the console shows and filters, and links out to change it. (If a future write
path lands, this view is ready for it.)

### Secrets (infrastructure) — read org secrets (config) filtered by binding connection
"Secrets brokered from {Provider}" + `+ New secret`. Rows: NAME (mono) · meta
(`{source} · {provider} · {template}` / scope · TTL) · badge (`• Fresh per run`
for brokered, `• Rotated · {N}d` for rotated) · Manage / **Rotate now**. Create →
the SP outcome-first wizard (`CreateBrokeredSecretRequest` /
`CreateRotatedSecretRequest`, config-worker). Rotate → `RotateScopedCredentialRequest`.
Needs a **public read** listing a connection's brokered secrets (there is an
internal `by-connection` lookup; IX3 exposes an org-scoped, admission-checked read
or filters the org secrets list client-side by `binding.connectionId`).

### Projects (infrastructure) — from custody / provider facts
Rows: db glyph · mono project name · region · `• Active`. Source: the connection's
custody `scopes` / the per-provider facts table (`supabase_orgs` /
`cloudflare_accounts`) via `get(orgId, connectionId)`. If region isn't in
custody, IX3 surfaces what's available and omits absent fields (no fabrication).

### Channels (messaging) — read `listSlackChannels(orgId, connectionId)`
"Connected channels" + `Add channel`. Rows: `#name` + default badge. Connected
set is the persisted channel selection (notifications-worker `slack_app` channel
kind); Add opens a channel picker over `listSlackChannels`.

### Notifications (messaging) — new noun #2
"Notification routing" — `Switch` rows: Run outcomes → `#deploys`, Approval
requests → `#eng-approvals`, Incident alerts → `#incidents`, Daily digest →
`#agent-digest`. Persisted per-connection routing prefs; delivery is ES/
notifications-worker's job (honest boundary noted in-surface).

### Activity (all archetypes) — reuse `SpaceActivity`
Composes the mint ledger (`listMintedCredentials`) + inbound deliveries
(`listDeliveries`) into one timeline: colored dot (success/info/warning) · title ·
mono detail · relative time. IX restyles it to the mockup's row form.

## New backend, precisely

- **IX2 `capability_prefs`** — additive JSONB on `integrations.connections`
  (default all-supported-on). `PublicConnection.capabilityPrefs?: Record<string,
  boolean>`. `UpdateConnectionRequest` gains optional `capabilityPrefs`. New
  numbered migration; repo read-model + handler; SDK `update` already exists.
  Governance: only capabilities the manifest declares are accepted.
- **IX3 read** — `GET /integrations/{connectionId}/secrets` (org-scoped,
  admission-checked) → the brokered/rotated secret metadata bound to this
  connection, projected from config-worker's `by-connection` reverse lookup (or a
  console-side filter of the org secrets list, decided in IX3).
- **IX4 `notification_prefs`** — additive per-connection routing map (same
  connection-fact pattern as capability_prefs, or a small
  `connection_notification_routes` table if it needs per-route channel binding).
  Read on `PublicConnection`; written via `PATCH`.

## Verification strategy

No local mock backend exists; the console talks to real api-edge. Per repo norm:
1. **Component tests** (`tests/web-console-next/`, jest) for every new pure
   view-model + component — the CI gate.
2. **`/demo` gallery** entries render each new surface with mock data for
   token-free screenshot capture (browser pane, pixel-compare to the mockup).
3. **Backend** (integrations-worker) changes covered by
   `tests/integrations-worker/` + manifest-conformance/governance gates.
4. typecheck + lint via the turbo filters on every PR.
