# Epic: saas-integration-hub

**The three ghost cards become real — and each one proves a different archetype.**
The console Integrations hub already promises Slack, Cloudflare, and Supabase as
"Soon" ghosts next to the live GitHub card. This epic ships them — not as three
one-off bolt-ons, but as the three provider *archetypes* the integrations
platform was built to host: **messaging** (Slack: a first-party OAuth app that
delivers rich notifications *and* listens back), and **infrastructure
credential brokering** (Cloudflare, Supabase: connect once, then every `orun`
run receives short-lived, scoped, auditable credentials through the secret
manager — no long-lived API key is ever pasted into a secret again). GitHub
proved the seam for source control; this epic makes the seam earn its name.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft — for review** |
| Cluster | **IH** (integration hub — extends **IG** `saas-integrations`; resolves **ES** D1; consumes **IT** tenancy, **SM/OV8** secret manager, **B11** entitlements) |
| Owner(s) | `apps/integrations-worker` + `apps/notifications-worker` (delivery only) + `apps/config-worker`/`apps/state-worker` (brokered resolve) + `apps/api-edge` (ingress) + `packages/db` + `packages/contracts`/`sdk`/`cli` + `apps/web-console-next` |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `saas-integrations/design.md` (provider seam, edge ingress rules, inbox discipline, token broker — all shipped through IG4/IG9); `saas-integration-tenancy` (account-shared connections, share mode — shipped IT1–IT8); `saas-event-streaming` (ES2 rules, ES3 `ChannelProvider` seam + Slack incoming webhooks, ES4 event groups — shipped); `saas-secret-manager` SM1–SM3 + `orun/specs/orun-secrets` v3 (lease-bound resolve, the reserved `provider` envelope seam); `components/17-integrations.md`; `apps/web-console-next/src/components/integrations/providers.ts` (the ghost catalog this epic makes live) |
| Decisions locked | Structural: (1) **one seam, three archetypes** — the `IntegrationProvider` interface is evolved (additively) into a core connect/lifecycle contract plus optional **capabilities** (`scm`, `messaging`, `credential-broker`, `inbound`); GitHub is re-expressed against it, never rewritten; (2) **custody/delivery split for Slack** — integrations-worker owns the OAuth install and bot-token custody; notifications-worker keeps *delivery* behind the shipped ES `ChannelProvider` seam via a new additive `slack_app` channel kind, fetching credentials over an internal service binding (resolves ES's parked D1 exactly as ES predicted: "an additive channel kind, not a migration"); (3) **nothing durable leaves the platform** — parent credentials (Slack bot token, Cloudflare parent API token, Supabase refresh token) exist only as AES-256-GCM envelopes inside integrations-worker; everything issued outward is short-lived, scoped-down, ledgered, and revocable — IG4's posture generalized to every provider; (4) **brokered secrets ride the reserved seam** — a secret key can be *bound* to a broker scope template instead of a stored value; the value is minted inside the SM3 lease-bound resolve, TTL-clamped to the job lease, with **zero orun CLI changes** (the resolve wire shape is unchanged); (5) **tenancy is inherited, not reinvented** — connections get IT's `scope`/`share_mode` for free; (6) **"rules route, channels deliver" stays** — no project↔channel link table; Slack routing remains ES notification rules targeting `slack_app` channels. |
| Gate | IH0 (foundation) and the broker/secret plumbing against recorded fixtures are human-independent. Live paths are gated per provider: **D1** Slack App registration per environment, **D3** Cloudflare parent-credential posture, **D4** Supabase OAuth app registration — the same park-and-continue posture as IG's GitHub App gate (see `risks-and-open-questions.md`). |

## Thesis

`saas-integrations` made a bet: build a pluggable integrations *platform*, not
a GitHub feature. The bet half-paid — the seam is real (provider-generic
handlers, repo layer, contracts, console) but the registry still knows exactly
one provider, and the pluggability proof (IG7's dormant GitLab adapter) never
shipped. Meanwhile the platform grew the two rails that make new providers
*compound* rather than merely exist: the event pipeline (ES: rules, channels,
event groups) and the secret manager (SM/SEC: lease-bound resolve with a
reserved `provider` envelope seam for external-backed values).

This epic cashes the bet with the three providers the console already
advertises, chosen because each one exercises a different half of the platform:

- **Slack** is the *messaging* archetype and the payoff of ES. ES shipped Slack
  as a credential-free incoming webhook and explicitly parked the first-party
  app ("channel picker, threads, interactivity — the same `ChannelProvider`
  interface later; an upgrade, not a rewrite"). IH ships that app: OAuth
  install bound to the org, channel picker instead of pasted URLs, **one
  updating message per event group** instead of append-spam, notification
  actions (acknowledge / mute rule) in the message itself, an `/orun` slash
  command, and console-link unfurling. Slack becomes two-way: `messaging.*`
  events flow back through the same inbox discipline GitHub deliveries use.
- **Cloudflare and Supabase** are the *credential broker* archetype and the
  payoff of the secret manager. Today "integrate with Cloudflare" means
  pasting a long-lived API token into the secret store and rotating it by
  hand, forever. After IH: connect the Cloudflare account or Supabase org
  once in the hub; bind `CLOUDFLARE_API_TOKEN` (or `SUPABASE_ACCESS_TOKEN`)
  as a **brokered secret** at whatever scope the chain allows; every `orun`
  run's lease-bound resolve mints a fresh, scoped, ~run-lifetime credential;
  the mint ledger and audit log record every issuance; revoking the
  connection kills the whole class. Vault calls this dynamic secrets; we get
  it without a second engine because the resolve path, the policy layers,
  the redactor, and the run provenance already exist.

The strategic claim is the same one IG made, one level up: products (and now
`orun` itself) should hold **one** platform credential and zero provider
credentials. GitHub proved it for source control; Slack proves the platform
can *speak*; Cloudflare/Supabase prove it can *arm a deploy* without anyone
ever seeing a durable key.

## How it maps to the references

| Reference | Here |
|-----------|------|
| Vercel marketplace: install an integration onto the team | Hub card → connect flow; connection bound to the account org (IT scope/share-mode for free) |
| Datadog Slack App: channel picker, threaded updates, actionable alerts | IH2: `slack_app` channel kind + event-group message updating + ack/mute actions |
| Slack slash commands / unfurls in Linear, GitHub | IH3: `/orun` command + console-link unfurling via the same signed ingress |
| Vault dynamic secrets: no stored value, short-TTL leases, revocation | IH4/IH7: broker scope templates + mint ledger + brokered secret bindings resolved at lease time |
| Doppler/GitHub "paste a token" integrations (the anti-pattern) | Explicitly what IH retires: long-lived provider keys in the secret store |

## Read order

1. `README.md` (this file) — status + thesis + milestones-at-a-glance.
2. `design.md` — the archetype model, the capability seam, per-provider
   designs (Slack app, Cloudflare broker, Supabase broker), the brokered-secret
   resolve path, data model, console UX, governance.
3. `implementation-plan.md` — IH0–IH10, each with "done when".
4. `risks-and-open-questions.md` — the per-provider registration gates and
   product decisions, plus the engineering risks (parent-credential custody,
   broker-on-the-critical-path, Slack ack budgets).

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| IH0 | Foundation (dormant): capability seam, widened contracts, `700_integration_hub_foundation` migration (parent-credential custody, mint ledger, provider facts), adapters registered dormant | 🗓️ Planned |
| IH1 | Slack connect: OAuth v2 install e2e, `team_id ↔ org_id` keystone, bot-token custody, hub card goes live | 🗓️ Planned (gated: D1 Slack App per env) |
| IH2 | Slack delivery upgrade: `slack_app` ChannelProvider, channel picker, event-group message updating, coexistence with incoming webhooks | 🗓️ Planned |
| IH3 | Slack inbound: signed events/interactivity/commands ingress, `messaging.*` events, notification actions, `/orun` slash command, unfurls | 🗓️ Planned |
| IH4 | Credential broker core: provider-generic mint API, scope templates, mint ledger + revocation, policy/entitlement/audit; GitHub's IG4 broker re-expressed on it | 🗓️ Planned |
| IH5 | Cloudflare adapter: parent-token connect + verification, scoped short-TTL child-token mint, auto-revoke sweep, health | 🗓️ Planned (gated: D3) |
| IH6 | Supabase adapter: OAuth connect, refresh custody, short-lived access-token mint, project scoping | 🗓️ Planned (gated: D4) |
| IH7 | Brokered secrets: the `provider`-envelope binding kind, mint-at-resolve inside SM3's lease-bound path, plan/chain visibility, zero CLI change | 🗓️ Planned (rides SM1–SM3) |
| IH8 | Console to marketplace standard: capability-grouped hub, per-archetype connection detail, mint-ledger activity, brokered-binding UX in the secrets UI, Cmd-K | 🗓️ Planned |
| IH9 | Lifecycle hardening: per-provider health/reconcile crons, orphan-mint sweep, failure budgets via ES rules, rotation runbooks, BF instance params | 🗓️ Planned |
| IH10 | Pluggability proof: dormant fourth-archetype adapters (AWS STS broker; Discord/Teams messaging) compiling against the capability seams | 🗓️ Planned (optional tail) |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The Slack first-party app (OAuth connect, bot-token custody, `slack_app` channel kind, event-group message updates, notification actions, `/orun` slash command, unfurls, `messaging.*` inbound events); the provider-generic credential broker (scope templates, mint ledger, revocation); Cloudflare + Supabase adapters; brokered secret bindings resolved at lease time; the capability-typed provider seam; hub + connection-detail console surfaces; SDK/CLI; entitlements; audit | Slack incoming webhooks (shipped, ES3 — kept working, never migrated forcibly); notification *routing* (ES rules own it); paging/on-call (a future channel kind, per ES); Cloudflare/Supabase *inbound* event ingestion (alerting webhooks → `infra.*` — deferred, see risks); materializing brokered secrets into provider stores (brokered = resolve-only in v1); per-tenant Slack/Supabase apps (one app per instance environment, BF params); a user-visible "workflow builder" over integrations; GitHub — untouched except re-expression against the capability seam |

## Relationship to existing work

- **IG (`saas-integrations`)**: the platform this epic extends. Every IG
  keystone survives untouched: the signed-state connect discipline, the
  unauthenticated edge-ingress rules (design §5), the durable inbox +
  transactional emission, the broker posture (short-lived, scoped-down, never
  logged). IH0's capability seam is the *promotion* of IG7's dormant
  pluggability proof into three live providers. IG4's GitHub token broker is
  re-expressed as the first `credential-broker` capability — same routes kept
  back-compatible.
- **IT (`saas-integration-tenancy`)**: connections created by this epic get
  `scope` (account-shared / workspace-private) and `share_mode` for free —
  a Slack workspace or Cloudflare account connected at the account serves
  every admitted workspace, exactly like the GitHub installation does today.
  No new tenancy machinery.
- **ES (`saas-event-streaming`)**: shipped the rules engine, the
  `ChannelProvider` seam, and Slack incoming webhooks, and parked the OAuth
  Slack App as its D1 with the explicit shape this epic now fills ("an
  additive channel kind, not a migration"). IH2 adds `slack_app` beside
  `slack_incoming_webhook`; the router, rules, throttles, and event groups
  are consumed unchanged. ES4's event-group append-post degradation under
  incoming webhooks is upgraded to true message editing.
- **SM / OV8 / `orun/specs/orun-secrets` (SEC v3)**: the secret manager's
  data model reserves a `provider` field in the value envelope — "for a
  future external-backed value the envelope is a pointer, not ciphertext."
  IH7 is that future: the pointer names a connection + scope template, and
  config-worker's resolve handler calls integrations-worker to mint instead
  of decrypting. The resolve wire contract (`state-api-contract.md` §4) is
  unchanged — which is why the **orun CLI needs zero changes**: runner
  injection, redaction, TTL re-resolve, and sealed-run provenance all apply
  to brokered values exactly as to stored ones.
- **BF (bootstrap factory)**: the Slack App and Supabase OAuth App credentials
  are per-instance parameters, same as the GitHub App (IG7's alignment) —
  IH9 lifts them into the instance surface.
- **PX2 (config/flags/secrets UI)**: the secrets console gains the "bind to
  integration" affordance in IH8; the write-only value discipline is
  preserved (a brokered binding has no value to reveal at all).

## Why the `orun` repo is untouched

The CLI-side consumption story is deliberately zero-change: brokered secrets
resolve through the same `POST …/state/runs/{runId}/secrets/resolve` wire
shape the SEC v3 design already specifies (values in, `resolved[]` provenance
out). A brokered value arrives, is redacted, injected, TTL-governed, and
sealed into run provenance identically to a stored value — the runner cannot
tell the difference, which is the point. The only CLI-visible delta is
additive metadata (`resolved[].source: "broker"` and the `orun plan` chain
annotation `(brokered · cloudflare)`), which rides existing fields per the
contract's additive-evolution rule. If a dedicated CLI surface for connection
management is ever wanted (`orun cloud integrations …`), it is a later,
optional convenience — the console + SDK/CLI in this repo are the surface.
