# saas-integration-hub — Design

Status: Draft (normative once IH0 lands)

The architecture for growing the integrations platform from one provider
(GitHub) to four, across three archetypes, without weakening a single IG
keystone. Written against repo reality as of 2026-07-09: IG0–IG4/IG9 shipped
(connect, inbound inbox, repo links, token broker, write-back); IT1–IT8
shipped (account-shared connections, admission); ES0–ES7 shipped (rules,
`ChannelProvider` seam, Slack incoming webhooks, event groups); SM1–SM3
specced but unbuilt (the secret store v3 + lease-bound resolve — the decrypt
path does not exist in code yet); the console hub renders Supabase, Cloudflare,
and Slack as non-interactive "Soon" ghosts.

## 1. The shape of the problem: three archetypes, one platform

GitHub taught the platform five trust relationships (IG design §1). The new
providers recombine the same five — none introduces a genuinely new *kind* of
trust path, which is why this epic is an extension, not a second platform:

| Relationship | GitHub (shipped) | Slack | Cloudflare | Supabase |
|--------------|------------------|-------|------------|----------|
| Customer connects their account | App install + signed state | OAuth v2 + signed state | **pasted parent token** + verify | OAuth 2 (PKCE) + signed state |
| Provider pushes events to us | HMAC webhook | signing-secret events/commands/interactivity | — (deferred) | — (deferred) |
| We call the provider as ourselves | App JWT → installation token | bot token (custodied) | parent token (custodied) | refresh → access token (custodied) |
| Tenant/product acts on the provider | brokered installation token (IG4) | — (delivery is ours, not theirs) | **brokered child token** | **brokered access token** |
| We deliver *to* the provider | check runs / statuses (IG9) | Block Kit messages (via ES seam) | — | — |

Reading the columns as capabilities:

| Capability | github | slack | cloudflare | supabase |
|------------|--------|-------|------------|----------|
| `connect` (lifecycle, health) | ✅ | ✅ | ✅ | ✅ |
| `inbound` (verified ingress → inbox → normalized events) | ✅ `scm.*` | ✅ `messaging.*` | ⏳ deferred `infra.*` | ⏳ deferred |
| `scm` (repo links, branch→env) | ✅ | — | — | — |
| `messaging` (channel delivery via ES) | — | ✅ | — | — |
| `credential-broker` (short-lived scoped mint) | ✅ (IG4, re-expressed) | — | ✅ | ✅ |

That table **is** the seam design: one core contract everyone implements, plus
optional capability interfaces the registry can interrogate. The console
renders by capability; handlers stay provider-generic; only adapters know
provider APIs.

## 2. The capability seam (evolves `IntegrationProvider`, additively)

Today's `apps/integrations-worker/src/providers/types.ts` interface is
SCM-shaped (`buildInstallUrl`, `verifyInboundSignature`, `mintToken` "future").
IH0 refactors it into a core + capabilities without changing GitHub behavior:

```ts
interface IntegrationProviderCore {
  id: IntegrationProviderId;          // "github" | "slack" | "cloudflare" | "supabase"
  displayName: string;
  connectKind: "install" | "oauth" | "token";   // drives the console connect UX
  buildConnectUrl?(input): string;              // install/oauth kinds; signed state
  completeConnect(input): Promise<ProviderConnection | null>;  // callback or token-paste
  revokeConnection(connection): Promise<void>;  // best-effort provider-side cleanup
  fetchConnectionHealth(connection): Promise<ConnectionHealth>;
}

interface InboundCapability {
  verifyInboundSignature(rawBody, headers, secret): Promise<boolean>;
  deliveryKey(headers, payload): string | null;  // provider's idempotency key
  normalizeEvent(headers, payload): NormalizedEvent | null;  // scm.* | messaging.*
}

interface CredentialBrokerCapability {
  scopeTemplates(): ScopeTemplate[];             // named, versioned, in contracts
  mintCredential(connection, template, params, ttlSeconds): Promise<MintedCredential>;
  revokeCredential(connection, providerRef): Promise<void>;   // best-effort; TTL is the backstop
}

interface MessagingCapability {
  listChannels(connection, query): Promise<ChannelRef[]>;     // the channel picker
  // NOTE: message *delivery* is NOT here — see §4 (custody/delivery split)
}
```

Registry: `getConfiguredProvider(env, id)` stays; it gains
`getCapability(provider, "credential-broker")`-style narrowing so handlers can
404 cleanly on capability mismatch (asking Slack for a credential mint is a
`capability_not_supported` typed error, not a 500). `KNOWN_PROVIDER_IDS`
widens; `packages/contracts` `IntegrationProviderId` widens (it is documented
as "widens as adapters land"). The GitHub adapter is re-expressed: its install
flow becomes `connectKind: "install"`, its webhook verify moves under
`InboundCapability`, and IG4's token mint becomes the first
`CredentialBrokerCapability` implementation (scope template `repo-token`,
params = repositories + permissions) with the existing
`POST …/integrations/github/token` route kept as a back-compatible alias.

**What does not change:** the signed-state discipline, the edge-ingress rules
(01-edge-api additions from IG1/IG2), the inbox tables, repo links, IT's
resolution seam, and every existing public route and contract shape.

## 3. Data model (`700_integration_hub_foundation`)

Schema `integrations`, same conventions as `180` (org-scoped, keyset
pagination, `prefix_<32hex>` public ids). New tables; nothing existing is
altered except widening implicit provider expectations (no CHECK on
`connections.provider` exists today — good).

- **`provider_credentials`** — parent-credential custody, provider-generic:
  `id, connection_id FK, kind
  (slack_bot_token | slack_app_config | cloudflare_parent_token |
  supabase_refresh_token | supabase_access_token_cache), ciphertext BYTEA
  (AES-256-GCM envelope, SECRET_ENCRYPTION_KEY), scopes JSONB,
  external_ref TEXT NULL (provider-side id, e.g. Cloudflare token id),
  expires_at NULL, rotated_at, created_at`. Write-only: no read API returns
  plaintext, ever; rows are zeroized on connection revoke. GitHub's
  `installation_tokens` cache stays where it is — no migration of shipped
  custody.
- **`minted_credentials`** — the broker ledger (never values): `id (mint_…),
  org_id, connection_id, provider, template TEXT, params JSONB (scoped-down
  request — zone ids, project refs; never secrets), purpose
  (api | secret_resolve), requested_by (actor ref), run_id TEXT NULL,
  job_id TEXT NULL, ttl_seconds INT, provider_ref TEXT NULL (for revocation),
  minted_at, expires_at, revoked_at NULL, revoke_status
  (pending | revoked | expired | orphaned)`. This is both the audit substrate
  and the reconcile work-queue for the orphan sweep (IH9).
- **`slack_workspaces`** — provider facts behind a Slack connection (twin of
  `github_installations`): `connection_id FK, team_id TEXT UNIQUE,
  team_name, enterprise_id NULL, bot_user_id, app_id, granted_scopes JSONB,
  installed_by_external_user TEXT NULL`. The `team_id ↔ org_id` binding is
  the Slack tenancy keystone — carried by our signed state, never inferred
  (§5), same rule as `installation_id`.
- **`cloudflare_accounts`** — `connection_id FK, account_external_id TEXT
  UNIQUE, account_name, parent_token_ref TEXT (provider-side token id),
  granted_policies JSONB (the verified parent grant, refreshed by health),
  token_status (active | expiring | invalid), parent_expires_at NULL`.
- **`supabase_orgs`** — `connection_id FK, supabase_org_id TEXT UNIQUE,
  org_name, granted_scopes JSONB, projects JSONB (cached ref list for the
  console + scope params, refreshed by health)`.

Platform-level app credentials are per-environment worker secrets, following
the `GITHUB_APP_*` convention: `SLACK_APP_CLIENT_ID/SECRET`,
`SLACK_APP_SIGNING_SECRET`, `SUPABASE_OAUTH_CLIENT_ID/SECRET`,
plus the existing `INTEGRATIONS_STATE_SECRET` and `SECRET_ENCRYPTION_KEY`.
Cloudflare needs **no platform credential** (the customer's pasted parent
token is the only credential — one reason token-paste is the v1 posture).
IH9 lifts all of these into the BF instance-parameter surface alongside the
GitHub App's.

## 4. Slack: the messaging archetype

### 4.1 Connect (IH1)

OAuth v2, `connectKind: "oauth"`, same keystone discipline as GitHub:

1. Console (policy `organization.integration.connect`, entitlement
   `feature.integrations.slack`) calls
   `POST /v1/organizations/{orgId}/integrations/slack/connect` → pending
   connection + Slack authorize URL carrying our signed single-use `state`.
2. Customer approves the app for their workspace (bot scopes only — D2).
3. Slack redirects to `GET /ingress/slack/oauth?code&state`. The edge forwards;
   the worker verifies + consumes the state nonce, exchanges the code
   (`oauth.v2.access`), stores the bot token as a `provider_credentials`
   envelope, records `slack_workspaces` facts, activates the connection.
4. No unsolicited path exists (Slack installs always start from our URL), but
   a `state`-less callback is still recorded orphaned + admin-visible, fail
   closed — the IG rule applied uniformly.

One active connection per `(org_id, 'slack', team_id)`; IT's account-shared
scope applies (a workspace under the account consumes the account's Slack
connection the same way it consumes the GitHub installation).

### 4.2 Delivery: the custody/delivery split (IH2)

ES owns delivery ("rules route, channels deliver") and its seam explicitly
anticipated this epic. The split:

- **notifications-worker** gains `ChannelProvider` kind **`slack_app`**
  (beside `slack_incoming_webhook`, which keeps working untouched). Channel
  config (`config_ciphertext`) stores `{connectionId, channelExternalId,
  channelName}` — a *reference*, not a credential.
- **integrations-worker** exposes an internal, service-binding-only credential
  read: `POST /internal/slack/credentials` (caller allowlist:
  notifications-worker; same pattern as `/internal/github/writeback`).
  notifications-worker holds the bot token **in isolate memory only**, ≤5 min,
  and calls Slack Web API (`chat.postMessage`, `chat.update`) itself — so
  spec 14's extraction seam ("callers must not import provider SDKs" for
  delivery) and spec 17's ("no component holds durable provider credentials")
  are both honored.
- **Channel picker**: console → api-edge → integrations-worker
  `GET …/integrations/{id}/slack/channels` (MessagingCapability
  `listChannels`, `conversations.list` with cursor + query) → user picks →
  console creates a `notification_channels` row of kind `slack_app`. Private
  channels require inviting the bot; the picker says so inline.
- **Event-group upgrade**: ES4 groups degrade to append-posts under incoming
  webhooks. Under `slack_app`, the first post per `(group, channel)` records
  `{channel, ts}` on the group's delivery attempt; subsequent group updates
  call `chat.update` — one Slack message per story that edits in place, plus
  a thread reply on severity escalation. This is the single most visible
  buyer-facing win of IH2 (the Datadog-Slack-App behavior).

### 4.3 Inbound: Slack talks back (IH3)

Three new edge ingress routes under the IG design-§5 rules (allowlisted, no
`resolveActor`, raw-body-first, fast-ack):

- `POST /ingress/slack/events` — Events API. Signature = HMAC-SHA256 of
  `v0:{timestamp}:{rawBody}` with the signing secret, constant-time compare,
  ±300s timestamp window (replay defense). Handles `url_verification`
  challenge synchronously; everything else is inbox-inserted
  (`inbound_deliveries`, `delivery_key = event_id`) and 200-acked within
  Slack's 3s budget.
- `POST /ingress/slack/interactivity` — block actions; payload carries a
  `response_url` (valid 30 min) the drain uses to respond.
- `POST /ingress/slack/commands` — slash commands. Ack immediately with an
  ephemeral "On it…" (the only synchronous body any ingress route returns);
  real response goes to `response_url` from the cron drain — verify → insert
  → ack, everything else async, exactly the GitHub inbox discipline.

Subscribed event set (deliberately small): `app_uninstalled`,
`tokens_revoked` (lifecycle → connection `revoked`, credential zeroize),
`channel_rename` / `channel_archive` (keep channel references fresh; archive
flips dependent channels to `disabled` + notifies), `link_shared` (unfurls).

Normalized taxonomy (versioned, additive, in contracts beside `scm.*`):

```
messaging.command.invoked        messaging.action.invoked
messaging.channel.renamed        messaging.channel.archived
integration.connected/.revoked/…  (existing lifecycle vocabulary, reused)
```

Product behavior on top:

- **`/orun` slash command**: `/orun status` (org/project run + catalog
  summary), `/orun runs [project]` (recent runs with console deep links),
  `/orun help`. Command → org resolution is via the connection (`team_id`);
  *authorization* is the platform's: the responder only surfaces what an
  org-viewer may see, and v1 answers are org-scoped summaries with deep links
  into the console (where real RBAC applies) rather than embedding sensitive
  detail into a shared channel. Per-Slack-user identity mapping is deliberately
  deferred (risks D6).
- **Notification actions**: `slack_app` notifications carry buttons —
  *Acknowledge* (posts a visible "acked by @user" thread reply + emits
  `messaging.action.invoked`) and *Mute rule 1h* (calls the ES rule-throttle
  mutation, policy-gated: the action carries the rule id; the mutation runs
  as a system actor recorded with the Slack user attribution in the audit
  payload). Failure to authorize degrades to an ephemeral error.
- **Unfurls**: `link_shared` for the console domain → `chat.unfurl` with a
  compact card (entity/run/event-group title, status, scope) — metadata only,
  never secret-bearing.

## 5. Cloudflare + Supabase: the credential-broker archetype

### 5.1 The broker core (IH4)

Provider-generic mint API, generalizing IG4:

```
POST /v1/organizations/{orgId}/integrations/{connectionId}/credentials
{ "template": "workers-deploy", "params": {…}, "ttlSeconds": 900,
  "purpose": "api" }
→ 200 { "credential": { …reveal-once fields… }, "mintId": "mint_…",
        "expiresAt": "…" }
```

Rules (all IG4 rules, generalized):

- **Scope templates, not raw scopes.** Adapters publish named, versioned
  templates in contracts; a request names a template + params. The adapter
  computes the provider-native grant and enforces *template ⊆ parent grant*
  — deny-by-default; a template the parent credential cannot cover is a
  typed `parent_grant_insufficient` error surfaced in connection health.
- **TTL requested, clamped.** `min(requested, template max, provider max)`;
  ledger records the actual expiry. Default 15 min, hard ceiling 1h (D5).
- **Reveal-once, never cached, never logged.** The response is the only time
  the platform emits the value; the ledger row + `integration.credential.issued`
  event carry template/params/ttl/actor — never the credential.
- **Revocable.** `DELETE …/credentials/{mintId}` best-effort revokes
  provider-side (`revokeCredential`) and marks the ledger; TTL is the
  backstop when a provider offers no revoke. Connection revoke fans out a
  revoke sweep across live mints.
- Policy `organization.integration.credential.issue` (service principals +
  owner/admin by default — D5); entitlement
  `feature.integrations.credential_broker`; per-org mint rate limit.

GitHub's IG4 route is re-expressed as template `repo-token` on this core
(alias preserved), so the platform has exactly one broker, one ledger, one
audit vocabulary.

### 5.2 Cloudflare adapter (IH5)

- **Connect** (`connectKind: "token"`): the customer creates an
  account-scoped parent token in the Cloudflare dashboard from our documented
  recipe (minimum: `Account API Tokens: Edit` + the union of permissions the
  scope templates need) and pastes it once. The worker verifies
  (`GET /user/tokens/verify`), discovers the account
  (`GET /accounts`), stores the envelope, records `cloudflare_accounts`
  facts including the **verified granted policy set** (rendered in the
  console so the customer sees exactly what they handed over). Paste-connect
  is v1 posture because Cloudflare offers no general OAuth for the API (D3);
  the connect modal is explicit that the parent token itself is never
  re-shown and revoking it in Cloudflare kills the connection.
- **Mint**: `POST /accounts/{id}/tokens` (account-owned tokens) with
  `policies` = the template's scoped-down grant, `expires_on = now + ttl`,
  optional `condition.request_ip` pinning (param). Templates v1:
  `workers-deploy` (Workers Scripts:Edit, KV:Edit, account read),
  `pages-deploy`, `dns-edit` (zone-scoped; params: zone ids),
  `r2-data` (bucket-scoped), `account-read`. The child token id is the
  ledger's `provider_ref`; revoke = `DELETE /accounts/{id}/tokens/{ref}`.
- **Health cron**: re-verify the parent token, refresh `granted_policies`,
  flag `expiring` (parent `expires_on` within 14 days) → connection health
  badge + ES-routed notification. Naming: minted tokens are created with
  description `orun/{org}/{template}/{mintId}` so the orphan sweep (IH9) can
  reconcile provider-side truth against the ledger.

### 5.3 Supabase adapter (IH6)

- **Connect** (`connectKind: "oauth"`): Supabase OAuth2 (PKCE) against the
  Management API — our published OAuth app (D4), signed state, keystone
  `supabase_org_id ↔ org_id`. Custody = the **refresh token** (envelope);
  short-lived access tokens are derived on demand and optionally cached
  (envelope, ≤ TTL) for the platform's own calls (project listing, health).
- **Mint**: template-shaped access issuance — v1 templates:
  `management-access` (a short-lived Management-API access token for the
  connected org; TTL = provider-fixed, reported honestly in the ledger),
  `db-migrate` (params: project ref; the credential bundle the migration
  runner needs), `functions-deploy` (project ref). Where the Management API
  exposes narrower project-scoped issuance, the adapter uses it; where it
  does not, the template documents its effective breadth (risks R5) — the
  ledger + audit still bound *usage* to the declared purpose.
- **Health cron**: refresh-token liveness (a failed refresh flips the
  connection to `suspended` with a re-auth CTA), project list refresh.

### 5.4 Brokered secrets: mint at resolve (IH7) — the keystone

The secret manager (SM1–SM3, from `orun-secrets` v3) defines the resolve path:
runner → state-worker (lease verify) → config-worker (policy + decrypt) →
values injected + redacted. Its data model **reserves** a `provider` field in
the value envelope: "for a future external-backed value the envelope is a
pointer, not ciphertext." IH7 implements that pointer:

- **Binding.** A secret at any scope rung can be created as kind `brokered`:
  instead of a value, the envelope stores
  `{ "provider": { "connectionId": "int_…", "template": "workers-deploy",
  "params": {…} } }`. Created via
  `POST …/config/secrets` with `binding` in place of `value` (policy:
  `secret.write` **and** `organization.integration.credential.issue` — you
  cannot bind authority you could not mint). The console's binding UX lives
  in the secrets UI (IH8) and the connection detail page.
- **Resolve.** Inside config-worker's resolve handler, a `brokered` head
  version short-circuits decrypt and calls integrations-worker
  (`POST /internal/credentials/mint`, service-binding-only) with
  `purpose: "secret_resolve"`, `run_id`/`job_id` from the resolve context,
  and `ttlSeconds = clamp(leaseRemainder + buffer, template bounds)`. The
  minted value is returned **through** the existing resolve response —
  same `secrets{}` map, same `resolved[]` provenance entry with additive
  `source: "broker"` + `mintId`. Redaction, in-memory-only injection,
  `ttlSeconds` re-resolve, `secret.accessed` audit, and sealed-run
  provenance all apply unchanged — the runner cannot distinguish a brokered
  value from a stored one. **Zero orun CLI changes.**
- **Two-layer policy applies twice-cheaply.** Layer 1/Layer 2 secret policy
  gates the *secret* read as usual; the broker's own policy + entitlement
  gate the *mint* (checked with the binding's stored authority, executed as
  the platform with the run attribution in the ledger). A revoked or
  suspended connection makes resolution of dependent keys fail closed with
  a typed `binding_unavailable` error naming the connection — visible in
  `orun plan --chain` output and the run failure.
- **Plan visibility.** The chain metadata (`GET …/config/secrets?chain=true`
  and the resolve `resolved[]`) carries `source: "broker"` +
  provider/template, so `orun plan` renders `CLOUDFLARE_API_TOKEN ←
  environment (brokered · cloudflare · workers-deploy)`. Doppler cannot say
  that; Vault can — now the catalog-integrated platform can too.
- **Materialization is excluded in v1.** A brokered secret is resolve-only;
  `materialize` targets reject `brokered` bindings with a typed error
  (materializing a 15-minute token into a Worker secret is self-defeating).
  Rotation-driven materialization of brokered values is a named future
  (risks, deferred).
- **Latency posture.** The mint adds one provider round-trip to first
  resolve. Accepted v1; the adapter pre-warms nothing and caches nothing
  (credentials are per-run by design). If p95 resolve latency becomes
  runner-visible, the escalation is mint-at-claim (state-worker initiates
  mint when the lease is granted) — additive, ledger-identical (risks R3).

## 6. Console UX (marketplace standard, per the shipped design system)

- **Hub** (`/orgs/{slug}/integrations`): the three ghosts become live cards,
  regrouped by archetype — *Source control* (GitHub), *Messaging* (Slack),
  *Infrastructure* (Cloudflare, Supabase), *AI & compute* (existing agents
  section, untouched). Ghost styling is retired for these; genuinely-future
  providers (Discord, AWS) take over the "On the roadmap" strip. Connect UX
  follows `connectKind`: popup OAuth (Slack/Supabase, reusing the GitHub
  popup/poll machinery), or the token-paste modal (Cloudflare) with the
  scope recipe inline and verify-before-save.
- **Connection detail, per archetype**:
  - Slack: workspace facts, granted scopes, channels in use (from
    notification channels of kind `slack_app`), recent `messaging.*`
    activity, danger zone (revoke = Slack `auth.revoke` + credential
    zeroize + dependent channels flip to `disabled` with a banner).
  - Cloudflare/Supabase: account/org facts, **verified parent grant** table,
    scope-template catalog ("what can be minted"), the **mint ledger**
    (template, purpose, actor/run link, expiry, revoke action), secrets
    bound to this connection (deep link into the secrets UI), danger zone
    (revoke = fan-out revoke sweep + dependent brokered secrets flagged).
  - GitHub: unchanged.
- **Secrets UI (PX2 surface)**: "Add secret" gains a *Bind to integration*
  path — pick connection → template → params → key name + scope rung; bound
  secrets render a broker badge + chain provenance instead of a value row.
- **Cmd-K**: "Connect Slack/Cloudflare/Supabase", "Open integrations",
  "Mint credential", "Bind brokered secret".
- All states designed (empty/skeleton/error with requestId), per
  `saas-console-ux`; the hub keeps its buyer-credibility bar (PX audits).

## 7. Governance

- **Policy** (deny-by-default, fail closed): existing
  `organization.integration.read/connect/manage` reused for all providers;
  new `organization.integration.credential.issue` (broker; D5 exposure) and
  `organization.integration.messaging.manage` (channel picker + notification
  actions administration). Repo-link and rule policies unchanged.
- **Entitlements**: `feature.integrations.slack`,
  `feature.integrations.cloudflare`, `feature.integrations.supabase`,
  `feature.integrations.credential_broker`, `limit.brokered_secrets`,
  `limit.credential_mints_per_day`. Plan placement is D7; every gate is
  412 + upgrade UX. ES's `feature.notifications.slack` continues to gate
  channels (both kinds).
- **Audit**: `integration.connected/.revoked/.suspended` (reused),
  `integration.credential.issued/.revoked/.mint_failed`,
  `integration.secret_binding.created/.removed`, `messaging.*` — all through
  event_log with the standard envelope; ledgers and payloads never carry
  credential material. Every brokered resolve is doubly visible: the
  `secret.accessed` event (secrets plane) and the mint ledger row
  (integrations plane), joined by `mintId`.
- **Multi-org**: IT semantics as-is — account-shared by default, admission
  grants under `share_mode='granted'`, workspace-private connections stay
  private. Brokered secret bindings reference connections through the same
  `effectiveIntegrationOrg` resolution used for repo links.

## 8. What deliberately does NOT exist

- No long-lived provider credential ever leaves the platform — not to
  products, not to runs, not to the console. (The Cloudflare *parent* token
  is the single pasted exception, and it enters once, write-only.)
- No second delivery engine: Slack sending stays behind ES's
  `ChannelProvider` seam; rules keep routing.
- No project↔channel link table (rules route); no repo_links analogue for
  messaging.
- No Slack per-user identity mapping / DM delivery in v1 (deferred, D6 —
  it belongs with TC's team targets and per-user preferences).
- No Cloudflare/Supabase inbound event ingestion in v1 (`infra.*` is named,
  reserved, and deferred until pulled).
- No brokered-secret materialization (resolve-only in v1).
- No per-tenant Slack/Supabase apps; one app per instance environment (BF
  parameters), tenants authorize it — the GitHub App rule, uniformly.
- No workflow builder / no user-authored automation over integrations —
  events + rules + the MCP/SDK surface remain the composition points.
