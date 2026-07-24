# Implementation plan — saas-integrations-console

One `## <ID> — <Title>` per milestone. **Build.** = what to touch. **Done when.**
= the acceptance bar (typecheck + lint + component tests green is implied for
every milestone; each also lands a `/demo` gallery entry for screenshot capture).

## IX1 — Hub redesign

**Build.** `apps/web-console-next/src/components/integrations/`: recompose
`integrations-hub.tsx` to the mockup — a `HubSummary` (3 `StatCard`s: connected /
brokered secrets / available), a `HubFilterBar` (`ChipRow` status + category
chips, pure client filter), connected as `ListCard`/`ListRow` with a
`ProviderTile` + Manage → detail, available as restyled `ProviderCard` grid, the
roadmap strip, and a `Search integrations` input that filters both lists.
Add pure helpers in a `hub-model.ts` (summary counts, filter predicate, meta-line
formatter) so the logic is unit-testable. The brokered-secret count reads the org
secrets list (config client) filtered to `source === "brokered"`; guard the read
so the hub renders without it. New shared primitives: `ProviderTile` (colored
glyph tile) in `components/integrations/provider-tile.tsx`.

**Done when.** The hub matches the mockup (stats, filter bar, connected rows,
available grid, roadmap) at desktop + dark mode; filtering by status/category and
search narrows both sections; `hub-model.ts` has unit tests
(`tests/web-console-next/src/integrations/hub-model.test.ts`) covering counts,
filter, and meta formatting; `/demo` renders the hub with mock data; typecheck +
lint + `@saas/web-console-next-tests` green.

## IX2 — Detail framework + GitHub (source-control) page

**Build.**
- Backend (new noun #1): `packages/db/src/migrations/<next>_connection_capability_prefs.sql`
  (additive `capability_prefs jsonb` on `integrations.connections`); repo
  read-model in `packages/db/src/integrations/types.ts` + mapping;
  `packages/contracts/src/integrations.ts`: `PublicConnection.capabilityPrefs?`
  and `UpdateConnectionRequest.capabilityPrefs?` (accept only manifest-declared
  capability ids); `apps/integrations-worker/src/handlers/connections.ts`
  `handleUpdateConnection` honors it (governance validation);
  `tests/integrations-worker/` coverage. SDK `update` already carries the body.
- Console: a shared `IntegrationDetail` shell (`components/integrations/detail/`)
  — `Breadcrumbs` + header (`ProviderTile`, name, status `Pill`, sharing badge,
  subtitle, `Open on {Provider}`) + archetype `Tabs` from `detail-model.ts`
  (archetype derivation + tab set + header fields, all pure). The GitHub body:
  Overview (`StatCard`s + a `CapabilityToggles` `Switch` list wired to `update`),
  Repositories (`SegmentedControl` + `listRepositories` filter/checkboxes +
  Manage-on-GitHub link), Workspace access (wrap `ConnectionAdmission` as the
  Open-to-all/By-invitation segment), Activity (restyled `SpaceActivity`).
  Route `/integrations/{provider}` resolves the single active connection to this
  page; `/integrations/{provider}/connections/{id}` targets a specific one.

**Done when.** GitHub "Manage" opens the tabbed page matching the mockup across
all four tabs; toggling a capability persists (round-trips through `update`) and
is reflected on reload; repository All/Selected view + filter works against
`listRepositories`; Workspace access drives admission; Activity renders the
timeline; `detail-model.ts` + `CapabilityToggles` have unit tests; migration +
contract + handler covered in `tests/integrations-worker/`; `/demo` renders each
GitHub tab; all four verify commands green (console + integrations-worker).

## IX3 — Infrastructure archetype (Supabase + Cloudflare)

**Build.**
- Backend read: `GET /integrations/{connectionId}/secrets` in integrations-worker
  (admission-checked) projecting config-worker's `by-connection` brokered/rotated
  metadata; contract `ListConnectionSecretsResponse`; SDK
  `listConnectionSecrets(orgId, connectionId)`; `tests/integrations-worker/`.
  (If the org secrets list already exposes `binding.connectionId`, prefer a
  client-side filter and skip the new endpoint — decided at build time, recorded
  in STATUS.)
- Console: the infrastructure body — Overview ("What Orun can broker" from the
  provider `secrets` capability describe), Secrets tab (list brokered/rotated
  rows with `• Fresh per run` / `• Rotated · Nd` badges; `+ New secret` → the SP
  outcome-first wizard using `CreateBrokeredSecretRequest`/`CreateRotatedSecretRequest`;
  `Rotate now` → `RotateScopedCredentialRequest`), Projects tab (custody/provider
  facts via `get`), Activity. Wire Supabase and Cloudflare to the same body
  (both `infrastructure`).

**Done when.** Supabase + Cloudflare "Manage" open the infra-tabbed page; the
Secrets tab lists this connection's brokered/rotated secrets with correct badges
and the create/rotate actions call the config-worker surface; Projects lists what
custody provides (no fabricated fields); Overview shows the broker capabilities;
pure models unit-tested; new read (if built) covered in
`tests/integrations-worker/`; `/demo` renders the infra tabs; all verify commands
green.

## IX4 — Messaging archetype (Slack)

**Build.**
- Backend (new noun #2): additive per-connection notification routing prefs
  (`packages/db/src/migrations/<next>_connection_notification_routes.sql` or a
  JSONB fact, decided at build time); contract on `PublicConnection` +
  `UpdateConnectionRequest`; integrations-worker handler + governance; tests.
- Console: the messaging body — Overview (`StatCard`s), Channels (connected
  channels list + `Add channel` picker over `listSlackChannels`), Notifications
  (`Switch` routing rows event→channel, persisted), Activity. An in-surface note
  states delivery is owned by event-streaming/notifications-worker.

**Done when.** Slack "Manage" opens the messaging-tabbed page; Channels lists the
connected set and Add opens the channel picker; Notifications toggles persist per
connection; routing model unit-tested; backend covered in
`tests/integrations-worker/`; `/demo` renders the Slack tabs; all verify commands
green.

## IX5 — Connect picker · search · demo gallery · supersede legacy space

**Build.** A global `+ Connect` picker modal (registry-driven, reuses
`connectDispatch`: popup+poll or provider-space token/apikey flow); search polish
across the hub; a consolidated `/demo` "Integrations" tab covering hub + all three
archetypes for the screenshot verifier; dark-mode + a11y pass (focus rings,
`aria` on toggles/segments, `prefers-color-scheme`); and route the legacy generic
`ProviderSpace` to the new detail for covered providers (redirect or render-swap),
keeping its reused sub-components. Decommission `archetype.ts` if fully absorbed.

**Done when.** `+ Connect` opens a provider picker and starts a connect for a
chosen provider; the covered providers no longer render the old generic space;
the `/demo` integrations gallery is complete; a11y/dark-mode verified via the
browser pane; no dead code from the migration; all verify commands green.

## Sequencing & dependencies

IX1 is independent (hub only). IX2 introduces the detail shell + the first
archetype and the `capability_prefs` backend — IX3/IX4 depend on the shell. IX3
and IX4 are independent of each other (different archetypes/backends) and may land
in either order. IX5 depends on IX2–IX4 (it supersedes the legacy space only once
all archetypes have a home). Each milestone is a single PR: implement → verify
(typecheck + lint + component tests + `/demo` screenshots) → merge → next.
