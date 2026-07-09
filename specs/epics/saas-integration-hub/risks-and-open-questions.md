# saas-integration-hub — Risks & Open Questions

Status: Draft. D1–D7 are human-gated registration/product decisions (the
epic's equivalent of IG's GitHub-App gate); R1–R8 are engineering risks owned
by the milestones.

## Human-gated decisions

### D1 — Slack App registration per environment (blocks IH1–IH3 live paths)

One Slack App per environment (dev/stage/prod), owned by the operating
workspace's Slack account — exactly the class of gate ES's risks predicted
("the same class of gate as IG's GitHub App registration"). Needed from the
operator: app name per env, client id/secret, signing secret, OAuth redirect
URL, event/interactivity/command request URLs pointed at that env's edge,
and the bot scope set (D2). Slack **app directory listing is not required**
(customers install via our OAuth URL); directory review is a later,
marketing-driven decision. Until provided: IH0 fully, and IH2/IH3 worker
logic against recorded fixtures, proceed; live connect/delivery/inbound
parks. **Default recommendation:** register `orun-dev|stage|prod` apps under
the operating Slack workspace; secrets via the SS escrow lane; BF instance
parameters at IH9.

### D2 — The Slack bot scope set (blocks D1 registration form)

Visible to every installing customer; widening later forces re-authorization.
**Default recommendation (minimal two-way set):**

| Scope | Why |
|-------|-----|
| `chat:write` | post + update messages (event groups) |
| `channels:read`, `groups:read` | channel picker (public + private-the-bot-is-in) |
| `commands` | `/orun` |
| `links:read`, `links:write` | console-link unfurling |
| `team:read` | workspace facts on connect |

Explicitly **not** requested: `chat:write.public` (posting to channels the
bot wasn't invited to — surprising), `users:read` (no identity mapping in
v1, D6), any history scopes (we never read customer messages).

### D3 — Cloudflare connect posture (blocks IH5)

Cloudflare offers no general OAuth for its API, so v1 is **token-paste**: the
customer creates an account-scoped parent token from our recipe and pastes it
once. The decision to confirm: the documented **minimum parent grant** —
default recommendation: `Account API Tokens: Edit` (the mint authority) plus
the union of the v1 template permissions (Workers Scripts, Pages, KV, R2,
DNS, account read), account-scoped, with an expiry the customer chooses
(health surfaces it). Alternative rejected for v1: per-template parent tokens
(N pastes, N rotations — worse custody). If Cloudflare ships partner OAuth,
it slots in as `connectKind: "oauth"` with no schema change.

### D4 — Supabase OAuth app registration (blocks IH6 live path)

One published Supabase OAuth app per environment (client id/secret, redirect
URL). Fallback if the OAuth program stalls: PAT-paste (`connectKind:
"token"`), same custody rules as Cloudflare — the adapter supports both;
OAuth is the default recommendation because it yields revocable, refreshing
grants and a real uninstall signal.

### D5 — Broker exposure posture (blocks IH4 gate wiring)

Who may call the mint API directly? Brokered credentials are real
infrastructure writes. **Default recommendation:** service principals +
owner/admin users behind `organization.integration.credential.issue`
(IG4's D3 answer, generalized), TTL default 15 min / ceiling 1h, per-org
mint rate limit. The `secret_resolve` purpose is *not* user-invocable — it
is reachable only via the internal service-binding route with a live-lease
resolve context.

### D6 — Slack identity mapping (deferred by default)

`/orun` responses and notification actions attribute the *Slack* user; they
do not authenticate them as platform users. Mapping Slack user ↔ platform
identity (for per-user authorization of commands/actions and DM delivery)
is deliberately out of v1 — it belongs with TC's per-user notification
targets and would ride the existing OAuth identity plane. Until then:
commands return org-viewer-safe summaries + deep links; the mute action is
policy-checked as a system actor with Slack attribution recorded. Confirm
this posture or pull identity mapping into scope.

### D7 — Plan placement (blocks gate wiring across IH1/IH4–IH7)

Which tiers include `feature.integrations.{slack,cloudflare,supabase,
credential_broker}`, and the numbers for `limit.brokered_secrets` /
`limit.credential_mints_per_day`? **Default recommendation:** Slack on Free
(activation-friendly, like `limit.repo_links = 1`), the credential broker on
Pro+ (it is a power/production feature), limits decided in the same catalog
lane as the multi-org tiers.

## Engineering risks

### R1 — Parent-credential custody (severity: critical; owner IH0/IH5/IH6)

A Cloudflare parent token that can mint tokens, and a Supabase refresh token,
are the highest-value secrets the platform will ever hold per-tenant — worse
than the GitHub App key in blast *shape* (customer infrastructure, not just
repos). Mitigations are structural: envelope encryption under
`SECRET_ENCRYPTION_KEY` (SM2's DEK/KEK hierarchy adopted when it ships),
write-only rows zeroized on revoke, no read API ever returns plaintext, the
verified grant rendered at connect so customers see exactly what they handed
over, documented-minimum recipes, health-surfaced expiry, and
`run_secret_scanning` on every PR in this epic. Residual risk is accepted and
disclosed: the connect modal states the custody terms plainly.

### R2 — Slack ingress authenticity + replay (severity: high; owner IH3)

Three new bearer-less public routes. Same defenses as IG2 plus Slack's
timestamp scheme: HMAC over `v0:{ts}:{rawBody}` before parse, constant-time
compare, ±300s window, body cap, per-source rate limit, 401 without detail,
inbox dedupe by `event_id` (Slack redelivers on slow acks). The rules land as
normative additions to `components/01-edge-api.md`, not folklore.

### R3 — The broker on the run critical path (severity: high; owner IH7)

Mint-at-resolve puts a third-party API between a claimed job and its first
step. Posture: fail closed for dependent jobs (a wrong credential is worse
than a failed run), bounded retries inside the resolve budget, typed
`binding_unavailable` naming the connection, independent jobs unaffected
(the SEC degradation ladder). Named escalation if p95 hurts: mint-at-claim
(state-worker pre-mints when the lease is granted) — additive,
ledger-identical. Provider outage visibility rides connection health + ES
failure budgets.

### R4 — Minted-token sprawl provider-side (severity: medium; owner IH5/IH9)

Crashed workers or failed revokes leave live child tokens in customer
Cloudflare accounts. Mitigations: short TTLs make every leak self-healing;
deterministic naming (`orun/{org}/{template}/{mintId}`) makes provider-side
truth reconcilable; the IH9 sweep revokes unledgered survivors and marks
ledger orphans; connection revoke fans out a revoke sweep synchronously.

### R5 — Scope fidelity varies by provider (severity: medium; owner IH4–IH6)

Cloudflare child tokens can be scoped precisely; Supabase management access
may be coarser than a template implies (confused-deputy risk if we
oversell). Rule: a template documents its **effective** breadth, the ledger
records what was actually granted, and a template that cannot be narrowed to
its declared intent must say so in the console rather than pretend. The
subset check (template ⊆ parent grant) is enforced adapter-side,
deny-by-default.

### R6 — Slack rate limits + the 3s ack (severity: medium; owner IH2/IH3)

`chat.postMessage` is ~1/s/channel and event/command acks must land in 3s.
Mitigations: ingress does verify+insert+ack only (the IG2 budget discipline);
delivery honors `Retry-After` with the ES retry ladder; event-group updating
*reduces* message volume by design (edits, not posts); storm behavior is
ES7's breaker, reused.

### R7 — Cross-context coupling via the internal seams (severity: medium; owner IH2/IH7)

Two new service-binding seams (notifications→integrations credential fetch;
config→integrations mint) could smear bounded contexts. Containment: both are
allowlisted internal routes with typed contracts in `packages/contracts`,
both are read/mint-only (no state writes across the seam), and both are named
in spec 17's extraction-seam section at IH0 so the boundary is contractual,
not incidental.

### R8 — Normalized `messaging.*` contract churn (severity: low; owner IH0/IH3)

Same rule as `scm.*` (IG's R7): versioned projections in contracts, additive
only, raw payloads retained in the inbox for re-derivation via replay.

## Explicitly deferred

- **Cloudflare/Supabase inbound events** (`infra.*` — deploy alerts, quota
  warnings) — the ingress + inbox machinery is ready for it; wait for a
  product pull.
- **Brokered-secret materialization** (rotation-driven sync of minted values
  into provider stores) — contradicts short TTLs in v1; revisit with SM5's
  sync provenance if a long-TTL template class appears.
- **Slack identity mapping + DMs** (D6) — pairs with TC.
- **PagerDuty-class paging, Discord/Teams** — additive `ChannelProvider` /
  `MessagingCapability` adapters; IH10 proves the seam dormant.
- **AWS STS broker adapter** — IH10 dormant proof; a live adapter waits for
  demand (it would also want per-tenant role-trust setup docs).
- **Slack app directory listing** — marketing-driven; requires review
  hardening (D1).
- **GitHub Enterprise / Slack Enterprise Grid nuances** — base URLs and
  `enterprise_id` are carried but untested until pulled.
