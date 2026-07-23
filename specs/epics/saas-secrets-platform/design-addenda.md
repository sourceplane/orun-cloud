# Design addenda — 2026-07-23 review (SP-A1–A7)

> A product-design pass over SP0c–SP6, grounded in the shipped code (SP0a/SP0b
> merged as #570/#571). Each addendum is a decision the milestones below adopt;
> where an addendum tightens a milestone's scope, the implementation plan
> references it by id.

## SP-A1 — The console reads capabilities in bulk, through the existing facade

SP0c's wire is **one org-scoped collection read**, not N per-provider reads:

```
GET /v1/organizations/{orgId}/integrations/secrets-capabilities
→ 200 { capabilities: ProviderSecretsCapability[] }
```

- Served by integrations-worker on its **public** (actor-authed) surface;
  enumerates configured + dormant providers and projects `provider.secrets`
  for each — the per-provider `/internal/providers/secrets-capability` read
  (SP0a) stays as the service-binding seam for config-worker.
- The path lives under `/integrations/`, so it matches api-edge's existing
  `ORG_INTEGRATIONS_RE` — **zero api-edge changes**, and the actor/rate-limit/
  idempotency posture is inherited.
- SDK: `client.integrations.listSecretsCapabilities(orgId)`; console: one
  query key (`qk.secretsCapabilities(orgId)`) with a long `staleTime` —
  capabilities are static per deploy.
- Why bulk: the create surface needs *all* eligible providers to filter the
  connection picker (today's `brokerConnections()`), and the Secrets lens needs
  them to label rows and route "managed by" affordances. One read, one cache.

## SP-A2 — SP2 builds a *provider space*, not a bigger connection page

There is no per-provider page today (only the hub and per-connection
`ConnectionDetail`). The integration's own space is a new route:

```
/orgs/[orgSlug]/integrations/providers/[providerId]
```

- **IA:** provider header (identity, connect state, connect CTA) · **Secrets**
  (the create surface + "this provider's secrets" filtered list) · **Scope
  templates** (read-only at SP2; managed at SP4) · **Connections** (links into
  the existing `ConnectionDetail` pages — custody/revoke stay there).
- Cloudflare registers the custom authoring surface here; declarative
  providers (Supabase) get the same route rendering the default surface —
  the route is substrate chrome, the create surface inside it is the plugin.
- The hub's provider cards link to the space; the space is also the deep-link
  target for every "managed by {integration}" affordance (SP3).

## SP-A3 — No dead ends: "New secret" becomes a routed menu

When SP3 removes the brokered/rotated tabs, the Secrets page must not become a
discovery dead-end for integration secrets:

- "New secret" becomes a **menu**: "Static value" (opens the native dialog)
  plus one "From {provider}…" item per capability-declaring provider, each
  deep-linking to that provider's space (SP-A2). Items derive from SP-A1's
  bulk read — never a hardcoded list.
- The empty state and the type filter make the same offer: filtered to
  `brokered`/`rotated` with zero rows → "Create one from {provider}" links.
- Providers with no live connection still appear (routed to the space, which
  owns the connect CTA) — creation *starts* at the owner even when the owner
  needs connecting first.

## SP-A4 — Legacy deep-links migrate, they don't break

The shipped `?bind=1[&connection=int_…]` deep-link on the Secrets page (the
target of `ConnectionDetail`'s "Create scoped credential" button, and of any
user bookmark) must survive the inversion:

- SP3: the Secrets page keeps parsing `?bind=1` but **redirects** to the
  owning provider space (resolving the connection's provider via the already-
  fetched connections list), carrying `?connection=` through so the picker
  pre-selects.
- `ConnectionDetail`'s button retargets to the provider space directly in SP2.

## SP-A5 — Capability reads degrade progressively, never to a hardcode

The console treats the capability read as progressive enhancement:

- While loading or on error, integration-create entry points render disabled
  with a "capabilities unavailable" hint; the static-create path is never
  blocked; rows still render from their own metadata (`source`, `rotation`).
- **Never** fall back to a baked-in provider list — a silent stale fallback
  would reintroduce the hardcode as a shadow.

## SP-A6 — SP4 templates pin a version at create

`IntegrationScopeTemplate` already carries `version`. SP4 makes it real:

- A create stamps `(templateId, templateVersion)` into the binding metadata.
- Editing a template bumps the version; existing secrets keep resolving and
  rotating against their pinned version's params.
- **Soft-retire**: a retired template disappears from create surfaces but
  stays resolvable for bound secrets; hard-delete is refused while any live
  secret pins it (typed 409 listing the dependents).

## SP-A7 — SP5 deprecation prints the exact replacement

- `orun secrets set --from-broker cloudflare/workers-deploy …` keeps working
  one release, printing the precise substitute:
  `deprecated: use \`orun integrations cloudflare secret create --template workers-deploy …\``.
- `orun integrations {provider} secret …` derives its help (providers,
  templates, modes, delivery targets) from the capability read at runtime —
  the CLI carries no template catalog.
- The secrets tree's typo-suggestion UX (`unknownSecretsSubcommand`) extends
  to the new namespace.
