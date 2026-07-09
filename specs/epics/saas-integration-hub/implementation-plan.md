# saas-integration-hub — Implementation Plan (IH0–IH10)

Status: Draft. Milestones are PR-sized coherent units; the Orchestrator
sequences them. IH0, IH4's core, and all fixture-driven adapter logic are
human-independent; live paths park per provider on the registrations in
`risks-and-open-questions.md` (D1 Slack, D3 Cloudflare posture, D4 Supabase)
— the same park-and-continue posture as IG's GitHub App gate. IH7 rides the
secret manager (SM1–SM3) and must not land its live path before the resolve
endpoint exists.

## IH0 — Foundation (dormant) — 🗓️ Planned

The seam-and-schema slice with zero live behavior.

- Capability seam refactor in `apps/integrations-worker/src/providers/`
  (design §2): `IntegrationProviderCore` + `InboundCapability` +
  `CredentialBrokerCapability` + `MessagingCapability`; registry capability
  narrowing + typed `capability_not_supported`. GitHub adapter re-expressed
  against it — behavior-identical, verified by the existing handler tests.
- `packages/contracts`: widen `IntegrationProviderId` to
  `"github" | "slack" | "cloudflare" | "supabase"`; `ScopeTemplate`,
  `MintedCredential` (safe projection), mint request/response, `messaging.*`
  event payload projections (versioned v1), new policy actions + entitlement
  keys (design §7).
- `packages/db`: migration `700_integration_hub_foundation`
  (`provider_credentials`, `minted_credentials`, `slack_workspaces`,
  `cloudflare_accounts`, `supabase_orgs` per design §3; manifest + checksum),
  repo layer + fixtures, `mint_` id prefix.
- `specs/components/17-integrations.md` amended: capability vocabulary,
  broker generalization, the messaging archetype, custody rules for parent
  credentials (normative deltas, additive).
- Adapters registered **dormant** (`slack`, `cloudflare`, `supabase` return
  unconfigured until their env secrets exist — the `githubApp.configured`
  pattern); console cards stay ghosts until each provider's connect milestone.

**Done when:** typecheck/lint/test green; migration applies + rolls back on
stage; GitHub connect/inbound/link/token flows pass unchanged against the
re-expressed adapter; `/health` reports per-provider configured flags; no new
public route reachable.

## IH1 — Slack connect end-to-end — 🗓️ Planned (gated: D1)

- Slack adapter: OAuth v2 authorize URL + signed single-use state,
  `oauth.v2.access` exchange, bot-token custody (`provider_credentials`),
  `slack_workspaces` facts, `auth.test`-based health, `auth.revoke` on
  platform-side revoke.
- Routes: `POST …/integrations/slack/connect`; edge `GET /ingress/slack/oauth`
  (design-§5 rules; allowlist, no resolveActor); connection list/read/revoke
  reuse the generic handlers.
- Console: Slack card goes live (popup connect, reusing the GitHub popup/poll
  machinery), minimal connection detail (workspace facts, scopes, revoke).
- Events: `integration.connected`/`.revoked`; entitlement
  `feature.integrations.slack`; IT scope/share-mode applies automatically —
  verified by an account/workspace test.

**Done when:** on stage, an org admin connects a real Slack workspace from the
hub and the connection shows `active` with team facts; a second org cannot
claim the same workspace; revoke works both ways (console revoke calls
`auth.revoke`; Slack-side removal converges via IH3's `app_uninstalled`, with
health-poll fallback until IH3 lands); all mutations audited; gates fail
closed.

## IH2 — Slack delivery upgrade (`slack_app` channel) — 🗓️ Planned

- notifications-worker: `slack_app` `ChannelProvider` (Block Kit send via
  `chat.postMessage`, edit via `chat.update`); internal credential fetch from
  integrations-worker (`POST /internal/slack/credentials`, service-binding
  allowlist, in-memory ≤5 min); retry ladder + rate-limit backoff
  (respect `Retry-After`; ~1 msg/s/channel).
- integrations-worker: `GET …/integrations/{id}/slack/channels`
  (MessagingCapability `listChannels`, cursor + query).
- Channels CRUD accepts kind `slack_app` (config = connection + channel refs);
  console channel picker in the notifications settings + connection detail;
  `slack_incoming_webhook` untouched and never force-migrated.
- Event-group message updating: first post records `{channel, ts}` on the
  delivery attempt; group updates edit in place; severity escalation adds a
  thread reply (design §4.2).

**Done when:** a rule targeting a picked channel delivers a Block Kit message
on stage; a correlated event group renders as **one** Slack message that edits
in place across `scm.check.completed` × `state.run.completed`, with a thread
reply on escalation; deleting the connection flips dependent channels to
`disabled` with a console banner; incoming-webhook channels keep delivering
throughout.

## IH3 — Slack inbound: events, commands, actions — 🗓️ Planned

- Edge ingress: `POST /ingress/slack/{events|interactivity|commands}` —
  v0 signature verify (constant-time, raw body, ±300s window),
  `url_verification` handled synchronously, everything else inbox-inserted
  (`delivery_key = event_id` / interaction id) and acked ≤3s; commands ack
  with an ephemeral "On it…".
- Cron drain: lifecycle (`app_uninstalled`/`tokens_revoked` → revoke +
  zeroize; `channel_rename`/`channel_archive` → channel refresh/disable),
  normalize + emit `messaging.*` transactionally (the IG2 discipline).
- `/orun` slash command v1 (`status`, `runs [project]`, `help`) responding
  via `response_url` with org-viewer-safe summaries + console deep links.
- Notification actions: Acknowledge (thread reply + `messaging.action.invoked`)
  and Mute-rule-1h (ES throttle mutation as system actor with Slack-user
  attribution in the audit payload; unauthorized → ephemeral error).
- Console-link unfurling via `link_shared` + `chat.unfurl` (metadata only).
- Fixture-driven worker tests for all three payload families
  (human-independent; live path needs D1).

**Done when:** on stage, uninstalling the app in Slack converges the
connection to `revoked` within one cron cycle; `/orun status` answers in a
connected workspace within Slack's deadline; the Ack button threads an
attribution reply and lands in the audit log; a replayed (stale-timestamp)
event is rejected with 401 and no inbox row.

## IH4 — Credential broker core — 🗓️ Planned

- Provider-generic mint/revoke/list:
  `POST …/integrations/{id}/credentials`, `DELETE …/credentials/{mintId}`,
  `GET …/credentials` (ledger, safe projection) per design §5.1 — template
  validation, parent-grant subset check, TTL clamp, reveal-once response,
  `minted_credentials` ledger, revoke fan-out on connection revoke.
- Policy `organization.integration.credential.issue` (D5 posture), entitlement
  `feature.integrations.credential_broker`, per-org mint rate limit,
  `integration.credential.issued/.revoked/.mint_failed` events.
- GitHub re-expressed on the core as template `repo-token`; the IG4 route
  `POST …/integrations/github/token` preserved as a back-compatible alias
  (same response shape), now writing the unified ledger.
- SDK (`integrations.credentials.mint/revoke/list`) + CLI
  (`integrations credentials mint --template …`); recipe doc mirroring the
  IG4 "act on GitHub" recipe.

**Done when:** GitHub token issuance round-trips through the new core with the
old route and response unchanged (existing IG4 tests pass) and appears in the
unified ledger; a mint against a capability-less provider (Slack) returns the
typed `capability_not_supported` error; ledger list never contains credential
material; SDK/CLI round-trip tested.

## IH5 — Cloudflare adapter — 🗓️ Planned (gated: D3 posture confirm)

- Token-paste connect: verify (`/user/tokens/verify`) + account discovery,
  envelope custody, `cloudflare_accounts` facts incl. verified granted
  policies; connect modal with the parent-token recipe inline
  (documented minimum grant).
- Mint: account-owned child tokens (`POST /accounts/{id}/tokens`) per
  template (`workers-deploy`, `pages-deploy`, `dns-edit`, `r2-data`,
  `account-read`), `expires_on = now + ttl`, optional IP condition,
  description `orun/{org}/{template}/{mintId}`; revoke = provider-side
  delete.
- Health cron: parent re-verify, granted-policy refresh, `expiring` flag →
  connection badge + ES-routed notification.
- Console: Cloudflare card live; connection detail with grant table, template
  catalog, mint ledger.

**Done when:** on stage, pasting a correctly-scoped parent token activates the
connection with its verified grant rendered; a `workers-deploy` mint produces
a child token that deploys a test Worker and expires on schedule; a template
exceeding the parent grant fails with `parent_grant_insufficient`; revoking
the connection deletes live child tokens (verified provider-side) and
zeroizes the parent envelope.

## IH6 — Supabase adapter — 🗓️ Planned (gated: D4)

- OAuth (PKCE) connect via the platform's Supabase OAuth app; refresh-token
  custody; `supabase_orgs` facts + project list cache; failed-refresh →
  `suspended` + re-auth CTA.
- Mint templates: `management-access`, `db-migrate` (project ref),
  `functions-deploy` (project ref) — provider-fixed TTLs reported honestly in
  the ledger; effective breadth documented per template (R5).
- Health cron; console card + detail (org facts, projects, template catalog,
  ledger).

**Done when:** on stage, an org connects a Supabase org via OAuth and the
project list renders; a `db-migrate` mint yields credentials that run a
migration against a scratch project; refresh-token revocation provider-side
converges the connection to `suspended` within one health cycle.

## IH7 — Brokered secrets (mint at resolve) — 🗓️ Planned (rides SM1–SM3)

- Binding write path: `POST …/config/secrets` accepts `binding`
  (connection + template + params) as the value alternative; dual policy
  gate (`secret.write` ∧ `organization.integration.credential.issue`);
  `integration.secret_binding.created/.removed` events; bindings render in
  chain metadata with `source: "broker"`.
- Resolve path: config-worker resolve handler short-circuits `brokered`
  heads to integrations-worker `POST /internal/credentials/mint`
  (service-binding-only; `purpose: "secret_resolve"`, run/job attribution,
  TTL clamped to lease remainder + buffer); value returned through the
  unchanged resolve response with additive `resolved[].source`/`mintId`;
  fail-closed typed `binding_unavailable` on suspended/revoked connections.
- Materialize targets reject `brokered` bindings (typed error).
- Contract: `state-api-contract.md` §4 gains the additive `resolved[]`
  fields + the `binding` write shape (checksum bump; vendored copy refreshed
  in `orun` by the standard contract-sync flow — the only `orun`-repo touch,
  and it is mechanical).
- E2E: an `orun` run on stage resolves `CLOUDFLARE_API_TOKEN` from a
  brokered binding and deploys a Worker with **no stored Cloudflare value
  anywhere** — the done-when of the whole epic.

**Done when:** the e2e above passes with an unmodified `orun` binary; the run's
sealed provenance and the mint ledger join on `mintId`; the value never
appears in logs (redactor verified); revoking the Cloudflare connection makes
the next resolve fail closed with `binding_unavailable` naming the
connection; a stored-value secret continues to resolve byte-identically.

## IH8 — Console to marketplace standard — 🗓️ Planned

- Hub regrouped by archetype (design §6); ghost strip repopulated with
  genuinely-future providers; connect UX per `connectKind`.
- Per-archetype connection detail complete (Slack channels-in-use +
  `messaging.*` activity; Cloudflare/Supabase grant table + template catalog
  + mint ledger + bound-secrets list); secrets UI "Bind to integration" flow;
  Cmd-K actions; designed empty/skeleton/error everywhere.

**Done when:** the surface passes the PX buyer-credibility bar (no stubs, no
native confirm(), designed states); a verified-live walkthrough of all three
providers is recorded in `IMPLEMENTATION-STATUS.md`.

## IH9 — Lifecycle hardening — 🗓️ Planned

- Reconcile crons: Slack `auth.test`, Cloudflare parent verify + **orphan
  mint sweep** (provider-side tokens matching the `orun/…` naming with no
  live ledger row → revoke + `orphaned` mark), Supabase refresh liveness.
- Failure budgets: mint error-rate and ingress error-rate rules through ES;
  admin-worker: connection search across providers, ledger inspection,
  orphaned-callback visibility.
- Rotation runbooks (Slack signing secret, Cloudflare parent token
  re-paste, Supabase client secret); platform app credentials lifted into
  the BF instance-parameter surface beside the GitHub App's.

**Done when:** deleting a minted Cloudflare token provider-side (or the
worker missing a revoke) converges the ledger within one sweep; an induced
mint-failure storm alerts through an ES rule; a fresh instance can wire
Slack + Supabase apps from `instance.yaml` + runbook without code edits.

## IH10 — Pluggability proof (optional tail) — 🗓️ Planned

- Dormant `aws` adapter compiling against `CredentialBrokerCapability`
  (STS `AssumeRole` shape) and dormant `discord` adapter against
  `MessagingCapability` — no live paths; the Stripe-after-Polar discipline,
  now per-capability.

**Done when:** both adapters typecheck with zero handler/console changes.

## Sequencing note

Two independent spines share IH0: the **messaging spine** IH0 → IH1 → IH2 →
IH3 and the **broker spine** IH0 → IH4 → IH5/IH6 → IH7. They touch disjoint
files after IH0 and can proceed in parallel; within the broker spine IH5 and
IH6 are order-free (default IH5 first — Cloudflare needs no OAuth app
registration, so it is the fastest path to the IH7 e2e). IH7's live path
waits on SM3 (the resolve endpoint) but its binding write path and the
internal mint route can land against fixtures earlier. IH8 trails whichever
surfaces exist; IH9 trails live traffic; IH10 is detachable. Fixture-first
discipline throughout: every adapter's verify/normalize/mint logic is
testable before its registration gate opens, exactly as IG2 was built ahead
of D1.
