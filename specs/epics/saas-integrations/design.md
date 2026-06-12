# saas-integrations — Design

Status: Draft (normative once IG0 lands)

The architecture for a pluggable integrations platform with GitHub App as the
flagship provider. Written against repo reality as of 2026-06-11 (OAuth login
shipped in identity-worker; webhooks outbound pipeline shipped; no Queues
anywhere — async is cron + Postgres; secrets at rest are AES-256-GCM envelopes).

## 1. The shape of the problem

A GitHub App integration has five distinct trust relationships, and the design
assigns each one a home:

| Relationship | Authenticated by | Owned by |
|--------------|------------------|----------|
| User signs in with GitHub | OAuth code exchange (user-scoped) | identity-worker (shipped, B1) |
| Customer installs the App on their GitHub org | GitHub redirect + signed `state` (install-scoped) | integrations-worker via edge callback ingress |
| GitHub pushes events to us | HMAC `X-Hub-Signature-256` over raw body | api-edge public ingress → integrations-worker |
| We call GitHub as the App | RS256 App JWT (private key) → installation token | integrations-worker (token mint + cache) |
| Tenant product acts on GitHub | Control-plane API key → brokered installation token | integrations-worker token broker |

Two of these (inbound webhook, install callback) arrive **without a bearer
token** — a trust path the edge does not have today. That is the one genuinely
new architectural concept in this epic; everything else composes existing
patterns.

## 2. Bounded context: `integrations`

New worker `apps/integrations-worker`, new schema `integrations`, new component
contract `components/17-integrations.md` (authored in IG0). It follows the
standard worker anatomy (router, handlers, ids, http; service bindings to
MEMBERSHIP_WORKER / POLICY_WORKER / BILLING_WORKER; Hyperdrive to
PLATFORM_DB; cron trigger like webhooks-worker).

Why not extend `webhooks-worker`: spec 15 declares inbound third-party OAuth
flows out of scope, and its data ownership (customer endpoints, outbound
deliveries) is the mirror image of this context's (provider connections,
inbound deliveries). Two small workers with opposite arrows beat one worker
with two personalities.

### Provider seam

Mirror of `identity-worker/src/oauth/providers.ts`, lifted to installation
semantics:

```ts
interface IntegrationProvider {
  id: "github";                       // "gitlab" later — registry-driven
  displayName: string;
  // Connect
  buildInstallUrl(input): string;     // GitHub: App install page + signed state
  completeConnect(input): Promise<ProviderConnection | null>;
  // Inbound
  verifyInboundSignature(rawBody, headers, secret): Promise<boolean>;
  normalizeEvent(headers, payload): NormalizedScmEvent | null;
  // Act
  mintToken(connection, scope): Promise<BrokeredToken | null>;
  // Lifecycle
  fetchConnectionHealth(connection): Promise<ConnectionHealth>;
}
```

Handlers, repo layer, console, SDK, and contracts are provider-generic; only
the adapter and per-provider credential config know GitHub. The pluggability
proof (IG7) is a dormant second adapter compiling against this interface — the
same proof discipline `billing-provider-abstraction` uses for Stripe-after-Polar.

## 3. Data model (`180_integrations_foundation`)

Schema `integrations`, every table `org_id UUID NOT NULL`, keyset-paginated
`(org_id, created_at DESC, id DESC)`, public IDs `int_*` / `repl_*` / `igd_*`
via the standard `prefix_<32hex>` encoding.

- **`connections`** — provider-agnostic: `id, org_id, provider, status
  (pending|active|suspended|revoked), display_name, external_account_login,
  external_account_id, created_by, connected_at, revoked_at, …`. One active
  connection per `(org_id, provider, external_account_id)`.
- **`github_installations`** — provider-specific facts behind the connection:
  `connection_id, installation_id (UNIQUE), account_type, repository_selection,
  permissions JSONB, events JSONB, suspended_at`. The `installation_id ↔ org_id`
  binding is the tenancy keystone (see §4).
- **`repo_links`** — `id, org_id, project_id, connection_id, repo_external_id,
  repo_full_name, default_branch, branch_env_map JSONB
  ({"main":"prod","staging":"stage"}), status, created_by`. Unique per
  `(project_id, repo_external_id)`. Forward-compatible with P2: a link is a
  plain record now and can be projected as a manifested resource later.
- **`inbound_deliveries`** — the durable inbox: `id, org_id NULL-able until
  attributed, provider, delivery_key (UNIQUE per provider — GitHub's
  X-GitHub-Delivery), event_type, action, payload JSONB, signature_ok,
  status (received|attributed|emitted|skipped|failed), attempts, next_attempt_at,
  emitted_event_id, received_at`. This is both the idempotency ledger and the
  cron work queue.
- **`installation_tokens`** — cache: `connection_id, token_ciphertext
  (AES-256-GCM envelope), permissions JSONB, repository_ids JSONB, expires_at`.
  Never logged, never returned by list/read APIs; broker re-mints rather than
  widening a cached scope.

Platform credentials (App private key, webhook secret, client id/secret) are
**not rows** — they are per-environment worker secrets (`wrangler secret put`),
following `GITHUB_OAUTH_CLIENT_*` naming: `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`,
`GITHUB_APP_CLIENT_ID/SECRET`, `INTEGRATIONS_STATE_SECRET`,
`SECRET_ENCRYPTION_KEY`. IG7 lifts them into the BF instance-parameter surface.

## 4. Connect flow and the tenancy keystone

The single highest-risk join in the epic is `installation_id ↔ org_id`. GitHub
redirects to one global setup URL with an `installation_id`; nothing in that
redirect says which tenant initiated it. The binding is therefore carried by
**our** signed state, never inferred:

1. Console (org admin, policy-gated `organization.integration.connect`) calls
   `POST /v1/organizations/{orgId}/integrations/github/connect` → worker creates
   a `pending` connection and returns the GitHub install URL carrying a signed,
   single-use, short-TTL `state` (HMAC, nonce persisted on the pending
   connection — same signed-state discipline as `oauth/state.ts`).
2. Customer installs the App on github.com.
3. GitHub redirects to `GET /ingress/github/setup?installation_id&state`.
   The edge forwards to integrations-worker, which verifies + consumes the
   state nonce, resolves the pending connection (and thus the org), calls
   GitHub as the App to fetch installation facts, and activates the connection.
4. Unsolicited installations (no valid state — e.g. installed straight from the
   GitHub marketplace page) are recorded as **orphaned** and surfaced only to
   admin-worker; they are never auto-bound to a tenant. The console connect
   flow can later claim an orphan by proving GitHub-side admin via a user OAuth
   check. Fail closed.

## 5. Edge ingress: the new unauthenticated trust path

New facade class on api-edge, deliberately separate from the bearer-token
facades: `/ingress/github/webhook` (POST) and `/ingress/github/setup` (GET).

Rules (these go into `components/01-edge-api.md` when IG1 lands):

- **No `resolveActor`.** Authentication is HMAC (webhook) or signed state
  (setup). These routes are the only public surface with this property; the
  facade is allowlist-routed, not pattern-general.
- **Raw body first.** The HMAC is over raw bytes; verify before any parse.
  Constant-time compare (reuse the technique in `packages/webhook-verifier`,
  not the library itself — GitHub signs `body`, not `timestamp.body`).
- Body-size cap, per-source rate limit, immediate 401 on signature failure
  (no per-tenant attribution cost on garbage traffic), 2xx fast-ack (<10s
  budget; target: verify + insert + ack, everything else async).
- Edge stays thin: verify nothing tenant-specific at the edge; signature
  verification happens in integrations-worker, which owns the secret. The edge
  forwards raw body + headers over the service binding.

## 6. Inbound pipeline: inbox → normalize → event_log

Mirrors the shipped outbound pattern (cron + table + bounded retries), opposite
direction. No Queues — consistent with the rest of the platform; a queue
accelerator is a later, additive hardening (wake-up signal; the inbox row stays
authoritative, cron stays the backstop).

1. **Ingest** (sync, in the ack path): verify signature → upsert
   `inbound_deliveries` keyed by `delivery_key` (replays/redeliveries are
   no-ops) → 200.
2. **Attribute** (cron): map payload `installation.id` → connection → org.
   Lifecycle events (`installation`, `installation_repositories`,
   `github_app_authorization`) mutate connection/installation state here —
   uninstall and suspend are processed even though they arrive like any other
   delivery.
3. **Normalize + emit** (cron, transactional): project the GitHub payload into
   a versioned, provider-neutral `scm.*` event and insert into event_log in the
   same transaction that marks the delivery `emitted`. Exactly-once emission by
   construction.

Normalized taxonomy (additive, versioned in contracts):

```
scm.push                       scm.repo.linked / scm.repo.unlinked (platform-originated)
scm.pull_request.opened|updated|merged|closed
scm.check.completed            scm.release.published
scm.branch.created|deleted     scm.tag.created
integration.connected / .suspended / .revoked / .repo_selection_changed
```

Payloads carry `orgId`, `projectId` (when a repo link matches), `provider`,
repo identity, and a compact, documented projection — never the raw GitHub
payload (raw stays in the inbox, admin-visible, for replay/debug). Events with
a repo matching a `repo_link` are emitted per linked project with `projectId`
set; unlinked-repo events emit org-scoped only.

**Products consume these with zero new machinery**: spec-15 outbound webhooks
already fan event_log out to customer endpoints with signing, retries, replay,
and failure budgets; the audit surface already renders them.

## 7. Acting on GitHub: the token broker

The control plane holds the only durable GitHub credentials. Products act
through:

- **`POST /v1/organizations/{orgId}/integrations/github/token`** — body asks
  for `repositories` (must be linked to a project the actor can access) and
  `permissions` (must be ⊆ the App's granted permissions; deny-by-default).
  Worker mints App JWT → exchanges for an installation token **scoped down** to
  exactly those repos/permissions → returns it with `expiresAt` (≤1h). Emits
  `integration.token.issued` (audited: actor, repos, permissions — never the
  token). Entitlement-gated; idempotency not required (tokens are cheap and
  expire).
- Cached tokens (§3) serve only the platform's own calls (repo listing,
  connection health); brokered tokens are always minted fresh and never cached,
  so revocation semantics stay GitHub's.
- A convenience **proxy** for the two highest-value writes (create check run,
  create deployment status) may ship behind the same gate later — the broker is
  the contract; the proxy is sugar. Optional, IG4 stretch.

This is the move that makes the integration a *product*: a tenant backend on
AWS holds one control-plane API key and zero GitHub secrets, and every GitHub
action it takes is tenant-scoped, short-lived, and in the org's audit log.

## 8. Console UX (Vercel-standard, per the shipped design system)

- **Settings → Integrations** (org): marketplace-style cards (GitHub live;
  GitLab/Bitbucket greyed "planned") with designed empty state. Card → connect
  flow (§4) in a popup window, optimistic pending state, toast on activate.
- **Connection detail**: status badge (active/suspended/orphaned), GitHub
  account, repository selection summary, recent `scm.*` activity (reuses the
  audit/event list components), danger zone (disconnect — confirm dialog,
  explains GitHub-side uninstall vs platform-side revoke).
- **Project → Git tab**: repo picker (searchable, from the connection's
  installation), link/unlink, branch → environment mapping editor seeded with
  `default_branch → prod`-style suggestions from the live environment list.
- **Login**: untouched (B1 shipped it).
- Cmd-K: "Connect GitHub", "Open integrations", "Link repository" registered in
  the existing registry. All states: designed empty, skeleton, error with
  requestId disclosure — per `saas-console-ux` conventions.

## 9. Governance

- **Policy** (deny-by-default, fail closed): `organization.integration.read`
  (viewer+), `.connect`/`.manage` (owner/admin), `project.repo_link.write`
  (project_admin+), `organization.integration.token.issue` (owner/admin or
  service principal with explicit role).
- **Entitlements**: `feature.integrations.github` (plan-gated; Free gets it
  off or limited), `limit.repo_links` (per-org). 412 + U7 upgrade UX, same as
  every other gate.
- **Audit**: every connect/disconnect/link/unlink/token-issue/suspension emits
  through event_log with the standard envelope. Inbound delivery raw payloads
  are admin-worker-visible only.
- **Multi-org**: connections are strictly org-scoped; a parent org's connection
  is not inherited by children (explicit per-org install; revisit only if a
  customer asks).

## 10. What deliberately does NOT exist

- No CI/CD, build, or deploy triggered by the platform itself — products react
  to `scm.*` events; execution is theirs (until P2/runtime makes it a resource).
- No repo content mirroring or search index.
- No per-tenant GitHub Apps (one App per instance environment; tenants install
  it). White-label forks get their own App via the BF instance parameters.
- No long-lived GitHub tokens handed to tenants, ever.
