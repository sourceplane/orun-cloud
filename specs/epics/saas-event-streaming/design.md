# saas-event-streaming — Design

Status: Draft (normative once ES0 lands). Written against repo reality as of
2026-07-02.

## 1. The shape of the problem

The platform has exactly one event bus and it already works: every bounded
context appends to `events.event_log` through `@saas/db/events`
(`appendEvent` / `appendEventWithAudit`, one atomic CTE writing the log row and
its audit projection), with a versioned envelope that carries tenancy
(`org_id`/`project_id`/`environment_id`), actor, subject, and — crucially,
unconsumed today — `correlation_id`, `causation_id`, and `idempotency_key`.
Inbound GitHub deliveries are verified, deduplicated, attributed, and
re-emitted onto the same log as versioned `scm.*` projections (IG2). Intake is
solved.

Everything downstream of intake is where the platform stops and Datadog
begins:

| Layer | Datadog has | We have |
|-------|-------------|---------|
| Fan-out | Event pipelines, subscriber routing | One hardcoded consumer: webhooks-worker's private cron poll with a per-org cursor |
| Rules | Monitors + notification rules with `@channel` handles | Webhook subscriptions matching exact / `*` / single-level `x.*` — no severity, no attributes, no throttling |
| Channels | Slack, email, PagerDuty, webhooks, mobile | Email only (`CHECK (channel IN ('email'))`), synchronous, single-attempt, no retry cron |
| Dedup/correlation | Aggregation keys, related-event grouping | Envelope fields exist; nothing reads them |
| Failure handling | Dead-letter, replay, delivery tracking | Webhooks lane has attempts+replay; there is no dead-letter store and `event.delivery_failed` (spec 09) was never emitted |
| Explorer | Events Explorer with facets | Audit table UI (compliance lens, not operational lens) |

Two latent defects are absorbed into this epic because they sit exactly on its
seam:

- **notifications-worker emits into the void.** Its lifecycle events
  (`notification.sent|failed|…`) POST to
  `https://events.internal/v1/internal/events` — a route events-worker has
  never had. The emit is best-effort and swallowed, so notification delivery
  is not auditable today despite spec 14 requiring it. ES0 fixes this the way
  every other context does it: direct `@saas/db/events` writes.
- **The lane seam already has a name.** `webhooks.webhook_dispatch_cursor` is
  keyed `(org_id, subscriber_lane)` — the schema anticipated multiple lanes;
  only `'webhooks'` ever existed. ES1 promotes that pattern to a shared,
  events-owned contract instead of inventing a parallel one.

## 2. Bounded contexts: the routing brain and the channel owners

**No new worker.** Spec 09 assigns "persist once → determine subscribers →
forward to delivery lanes → track failures / dead-letter / replay" to the
`events` context. events-worker grows from a read-only audit API into the
router:

- **events-worker (routing brain):** owns the catalog-driven read side — lane
  dispatch cron, rule evaluation, dedup/correlation grouping, dead letters,
  the events/groups query API. It gains a cron trigger and service bindings to
  `NOTIFICATIONS_WORKER` (to enqueue channel work). It still never serves
  unauthenticated traffic.
- **notifications-worker (channel owner):** owns *how* a notification reaches
  a human: provider seam (email shipped; Slack new), channel records, per-channel
  retries via its own new cron, preferences and suppression as today. It does
  not evaluate rules.
- **webhooks-worker (channel owner):** unchanged delivery mechanics (signing,
  backoff, auto-disable, replay). ES1 moves its cursor onto the shared lane
  table; ES2 lets notification rules reference an existing endpoint as a
  target — reusing the endpoint, not re-implementing delivery.
- **integrations-worker:** untouched. It remains the intake edge for external
  providers; its `scm.*` output is what ES4 correlates.

Why not a new `stream-worker`: the router is not a new bounded context — it is
the unbuilt half of an existing one, and splitting it would put the event
tables' primary consumer outside the schema's owning context (the constitution's
bounded-context rule cuts the other way here). Deployment count is negotiable;
context boundaries are not.

## 3. The event catalog (`packages/contracts`)

Routing, deduplication, severity facets, and human-readable rendering all need
a vocabulary. Today event names are scattered constants
(`NOTIFICATION_EVENT_TYPES`, `SCM_EVENT_TYPES`, …) and some emitters (webhook
lifecycle) bypass contracts entirely. ES0 introduces the registry:

```ts
// packages/contracts/src/event-catalog.ts
export interface CatalogEntry {
  type: string;                    // "scm.check.completed" — must match envelope pattern
  version: number;                 // payload projection version, additive-only
  category: EventCategory;         // "activity" | "security" | "billing" | "delivery" | "system" | "custom"
  severity: EventSeverity;         // "info" | "notice" | "warning" | "error" | "critical" (default; payload may escalate)
  title: string;                   // render template: "Check {payload.checkName} completed: {payload.conclusion}"
  dedupKey?: string;               // aggregation-key template: "scm.check:{tenant.orgId}:{payload.repoFullName}:{payload.headSha}"
  correlates?: string[];           // sibling types that share a story, e.g. state.run.* joins
  audit: boolean;                  // whether emitters project an audit_entry (mirrors current behavior)
}
export const EVENT_CATALOG: Record<string, CatalogEntry>;
```

Rules of the catalog:

- **Additive-only.** Types and payload fields are never renamed or removed
  (same discipline as the envelope; this is IG's R7 generalized). A CI check in
  `tests/contracts` asserts every literal passed to `appendEvent` in the
  workspace is registered — unregistered types fail the build, which
  retroactively catches the webhooks-worker hardcoded literals.
- **The catalog is code, not rows.** It ships with the platform version;
  tenants never edit it. Tenant-authored `custom.*` events (ES5) get one
  catch-all entry with `severity`/`title` read from the payload under caps.
- **Dedup keys are authored, never inferred.** A type with no `dedupKey`
  never groups (R2: false merges are worse than duplicates).
- Existing scattered constants stay as re-exports; the registry is the new
  source of truth.

## 4. The streaming substrate: lanes, cursors, dead letters

The webhooks lane proved the pattern under production traffic: an immutable
log, a per-`(org, lane)` cursor, a minutely cron that drains new rows in
batches, per-delivery attempt records with bounded backoff, and replay from
the durable row. ES1 generalizes exactly that — **a lane is a named,
at-least-once, cursored subscription over event_log** — and nothing else. No
Queues, no DOs: async on this platform is cron + Postgres (house pattern), and
because the contract is "cursor over an ordered log," it is *also* the
extraction seam spec 09 promised — a lane maps 1:1 onto a Kafka consumer group
or a Queues consumer if D2 ever flips.

Data model — migration `580_event_streams_foundation`, schema `events` (every
table `org_id UUID NOT NULL` where tenant-scoped, keyset-paginated
`(org_id, created_at DESC, id DESC)`, public IDs via the standard
`prefix_<32hex>` encoding):

- `events.subscriber_lanes` — the registry spec 09 called for. One row per
  lane (platform-global, not tenant rows): `lane_key TEXT PK`
  (`'webhooks'`, `'notifications'`, `'grouping'`), `owner_context`,
  `type_filter TEXT[]` (glob prefilter so lanes skip irrelevant types),
  `status (active|paused)`, `batch_size`, timestamps. Pausing a lane is the
  operational kill switch (R1).
- `events.lane_cursors` — `(lane_key, org_id) PK`, `last_event_id`,
  `last_occurred_at`, `updated_at`. ES1 backfills the `'webhooks'` rows from
  `webhooks.webhook_dispatch_cursor` in the same migration window
  (copy-then-cutover; the old table is dropped only after webhooks-worker
  reads the new one — R6).
- `events.dead_letters` — `id (dl_…)`, `lane_key`, `event_id FK event_log`,
  `org_id`, `reason` (safe string, same hygiene as webhook `failure_reason`),
  `attempts`, `first_failed_at`, `last_failed_at`,
  `status (open|replayed|discarded)`. The event payload is *not* copied — the
  log row is durable; a dead letter is a pointer plus forensics. Emits
  `dead_letter.created`; replay emits `dead_letter.replayed` and re-runs the
  lane handler for that single event.
- Lifecycle events (new, additive, registered in the catalog):
  `event.delivery_failed`, `dead_letter.created`, `dead_letter.replayed` —
  closing the spec 09 gaps. Recursion guard: lane dispatch skips
  `event.*`/`dead_letter.*` types (generalizing the existing `webhook.*` guard
  in webhooks-worker).

The dispatcher (events-worker `scheduled()`): for each active lane × org with
new rows, read a batch past the cursor (reusing the shipped keyset queries),
hand it to the lane handler, advance the cursor only on success, route
poisoned single events to `dead_letters` after bounded retries so one bad row
cannot wedge an org's lane (the webhooks drain's exact discipline).

## 5. Notification rules

A rule answers "which events, under which conditions, reach which targets, how
often." Rules are data, owned by the `events` schema, evaluated inside the
`'notifications'` lane handler.

- `events.notification_rules` — `id (rule_…)`, `org_id`, `project_id NULL`
  (org-wide or project-scoped), `name`, `status (enabled|disabled)`,
  `event_types TEXT[]` (multi-segment globs: `scm.pull_request.*`, `billing.*`,
  `*` — strictly more expressive than webhook subscriptions' single-level
  wildcard), `min_severity` (catalog severity ladder), `sources TEXT[] NULL`,
  `attribute_filters JSONB NULL` (conjunctive list of
  `{path, op: eq|neq|in, value}` against the payload — deliberately not a query
  language; R-scoped in §11), `throttle_window_seconds`, `throttle_max`
  (default: at most N notifications per window per rule × group — storm
  control from day one), `created_by`, timestamps. Unique `(org_id, name)`.
- `events.rule_targets` — `id`, `rule_id FK`, `target_kind
  (email|slack_channel|webhook_endpoint)`, `target_ref` (email address /
  `notifications.notification_channels.id` / `webhooks.webhook_endpoints.id`),
  `enabled`. `target_kind` is forward-defined to admit `team` (TC expands
  team→members at enqueue) and `inbox` (P4) without schema change.
- Evaluation: the `'notifications'` lane handler loads the org's enabled rules
  (small N, cached per cron tick), matches type glob → severity → scope →
  attribute filters in that order (cheapest first), applies throttle state,
  then enqueues one notification per surviving `(rule, target)` via the
  existing notifications-client path — with `idempotencyKey =
  hash(rule_id, target_id, event_id)` so cron overlap can never double-send
  (the shipped `(org_id, idempotency_key)` unique constraint does the work).
- Rule mutations emit `notification_rule.created|updated|deleted` (audited).
  Rule *firings* are not events (no meta-event feedback loops); they are
  visible as notification rows and, in ES6, on the rule's detail page.

## 6. Channels: the provider seam and Slack

Spec 14 shipped email with the type deliberately widened for future channels
but the DB CHECKs hard-locked to `'email'`. ES3 does the lift:

- Migration `590_notification_channels`: `CHECK (channel IN ('email','slack'))`
  across the four notification tables, plus
  `notifications.notification_channels` — `id (chan_…)`, `org_id`, `kind`
  (`'slack_incoming_webhook'` first), `name`, `config_ciphertext` (AES-GCM via
  the existing `SECRET_ENCRYPTION_KEY` discipline — a Slack incoming-webhook
  URL is a bearer credential and is treated exactly like a webhook endpoint
  secret: write-only, never echoed, never logged, never in event payloads —
  R4), `status (active|disabled)`, `last_verified_at`, `created_by`,
  timestamps.
- **Provider seam** in notifications-worker mirroring the shipped registries
  (`identity` OAuth providers, `integrations` provider adapters,
  `billing-provider-abstraction`):

```ts
// apps/notifications-worker/src/channels/types.ts
export interface ChannelProvider {
  kind: ChannelKind;
  send(input: RenderedNotification, channel: ChannelConfig): Promise<ChannelSendResult>;
  verify?(channel: ChannelConfig): Promise<ChannelVerifyResult>; // test send
}
```

- **Slack first via incoming webhooks** (D1 default): the customer creates an
  incoming webhook in their Slack workspace and pastes the URL — no OAuth app
  registration per environment, no credential gate, live on day one. Rendering
  uses Block Kit (title from the catalog template, severity color bar, tenant
  scope line, deep link to the console event/group page). The OAuth Slack App
  (channel picker, threads, interactivity) is the same `ChannelProvider`
  interface later — an upgrade, not a rewrite.
- **Async delivery becomes real:** notifications-worker gains a cron; enqueue
  writes the row and returns; the cron drains `queued` rows through the
  provider with the webhook-style backoff ladder (30s·4^n, capped attempts —
  finally exercising `notification_attempts` as designed). Email inherits the
  retry ladder for free. The request-time synchronous path remains only as a
  fast-path attempt zero.
- Channel mutations emit `notification_channel.created|updated|deleted|verified`.

## 7. Correlation and deduplication (the Datadog-grade part)

The goal: a push to a linked repo currently produces `scm.push`, one or more
`scm.check.completed`, and — through the state plane — `state.run.completed`,
each of which could match a rule and each of which pings separately. The
customer should get **one story**.

Two mechanisms, both catalog-driven, both running in a dedicated `'grouping'`
lane *before* notification evaluation:

- **Dedup keys.** The lane renders each event's catalog `dedupKey` template.
  Events sharing a rendered key within an inactivity window belong to one
  group. `scm.check.completed` and `state.run.completed` for the same
  `(repo, headSha)` render the same key by design — the GitHub view and the
  platform view of one commit collapse without any heuristic.
- **Causation chains.** Events whose `correlation_id`/`causation_id` link into
  a group's members join that group — emitters that already thread the trace
  fields (the envelope has carried them since migration 030) get storytelling
  for free.

Data model (in `580_…`, activated by ES4):

- `events.event_groups` — `id (grp_…)`, `org_id`, `group_key` (rendered dedup
  key), `status (open|closed)`, `first_event_id`, `last_event_id`,
  `event_count`, `max_severity`, `first_at`, `last_at`. Partial unique
  `(org_id, group_key) WHERE status = 'open'` — one open story per key; the
  grouping lane closes a group after `inactivity_window` (catalog-tunable,
  default 30m) and a later same-key event opens a fresh one.
- `events.event_group_members` — `(group_id, event_id) PK`, `added_at`.

**Group-aware notification (the dedup payoff):** a rule with throttling
enabled fires on a group's *first* matching event and on severity escalation
within the group — not on every member. The Slack message for a group updates
the story ("3 checks completed · run deployed to staging") rather than posting
three siblings. Groups are a read-model over the immutable log — `event_log`
rows are never mutated, and grouping emits no events about events.

Conservatism rules (R2): no dedupKey → never grouped; keys always embed
`org_id` (cross-tenant grouping is structurally impossible); templates only
reference envelope/payload fields, never fuzzy matching; `correlates` is an
allow-list of sibling types, not similarity search.

## 8. Custom event ingest (ES5)

Datadog parity requires customers to *post* events, not just receive ours:
deploy markers, feature-flag flips, incident notes from their own systems.

- `POST /v1/organizations/{orgId}/events` on api-edge → events-worker (which
  gains its first write route — still authenticated-only; this is *not* a new
  unauthenticated trust path, unlike IG's ingress). API-key or session auth;
  policy `organization.event.ingest`; body `{type: "custom.<suffix>", title,
  severity?, payload?, dedupKey?, occurredAt?}`.
- Namespace-enforced: public ingest can only mint `custom.*` types — platform
  namespaces are unreachable from outside regardless of payload. Caps: payload
  ≤ 32KiB, batched rate limit at the edge (reusing the shipped api-edge rate
  limiter), metered as `custom_events_ingested` through the metering pipeline,
  entitlement `feature.events.custom_ingest` + `limit.custom_events_per_day`
  (412 + upgrade UX on exhaustion).
- Custom events are full citizens: they land on event_log with the standard
  envelope (`source: "customer"`), flow through lanes, match rules, group via
  caller-supplied dedupKey, appear in the explorer, and fan out to B5 webhooks.
- SDK (`orunCloud.events.emit(...)`, `events.list(...)`, rules/channels CRUD)
  and CLI (`orun-cloud events tail --org … --type scm.*` — a poll-based tail
  over the query API) land here.

## 9. Console UX (Datadog standard, U-track discipline)

- **Events explorer** (`/orgs/{slug}/events`): faceted stream — type
  namespace, category, severity, source, project/environment, time range —
  URL-driven (U3), keyset-paginated, with a live poll toggle. Rows render
  catalog titles with severity chips; grouped rows collapse into story cards
  ("Push `abc123` · 4 events · checks ✓ · deployed") expanding to the member
  timeline. Detail drawer: envelope, payload (redaction-respecting), trace
  chain (correlation/causation links walk to related events), "create rule
  from this event" affordance.
- **Notification rules** (`/orgs/{slug}/settings/notifications/rules`): list +
  builder — type picker fed by the catalog (grouped by namespace, with
  descriptions), severity floor, scope selector, attribute filter rows,
  target picker (email / Slack channel / webhook endpoint), throttle control,
  test-fire button (synthesizes a sample event, shows which targets would
  receive it). Recent-firings panel on the rule detail page.
- **Channels** (`/orgs/{slug}/settings/notifications/channels`): add-Slack
  flow (paste URL → encrypted → test send → verified badge), disable/remove,
  delivery health.
- **Dead letters** (org settings, admin-gated): open dead letters with reason,
  replay/discard actions; admin-worker gets the cross-org view (ES7).
- Empty states, skeletons, and Cmd-K entries follow U4/U5; nothing ships
  without the buyer-credibility pass.

## 10. Governance

- **Policy (deny-by-default, fail-closed):** `organization.event.read`
  (viewer+; the explorer), `organization.event.ingest` (API-key scope),
  `organization.notification_rule.write` (admin+; read at viewer+),
  `organization.notification_channel.write` (admin+),
  `organization.dead_letter.replay` (owner/admin). Project-scoped rule
  mutation additionally requires project role (`project_admin+`), mirroring
  repo-link precedent.
- **Entitlements:** `feature.event_routing` (rules at all),
  `feature.notifications.slack`, `feature.events.custom_ingest`,
  `limit.notification_rules`, `limit.notification_channels`,
  `limit.event_retention_days`, `limit.custom_events_per_day`. Gate returns
  `412 precondition_failed` + U7 upgrade UX, materialized per-org as shipped.
- **Audit:** every mutation in §§5–6, §8 (rule/channel lifecycle, dead-letter
  replay, custom ingest is itself the event) emits catalog-registered events
  with audit projections. Notification delivery becomes auditable for the
  first time (the ES0 fix).
- **Multi-org / account:** rules and channels are org(workspace)-scoped in V1.
  Account-level rules ("one Slack channel for every workspace") are deferred
  until WID7's scope-resolution chain is the established pattern — noted in
  risks, not schema-blocked (`org_id` on every row is compatible with an
  account resolver above it).
- **Retention (ES7):** a sweep (events-worker cron, off-peak batch deletes;
  partitioning is the fallback if delete volume bites) enforces
  `limit.event_retention_days` on `event_log` + `audit_entries` heirs —
  with a floor for `category = 'security'` rows regardless of plan (compliance
  is not a plan feature). Dead letters and closed groups age out on fixed
  platform windows.

## 11. What deliberately does NOT exist

- **No new worker, no Queues, no Durable Objects, no KV** in this epic. The
  lane contract is designed so D2 can flip later without touching producers or
  rules.
- **No paging/on-call/escalation.** ES notifies; it does not wake people up.
  TC owns team routing and on-call *defaults* (still surface-don't-page); a
  PagerDuty-class integration would be a channel kind later.
- **No metric monitors.** Nothing here evaluates thresholds over numbers;
  metering owns quantitative signals (it may *emit* threshold-crossing events
  onto the log, which then route like any event).
- **No tenant-authored event types beyond `custom.*`**, no tenant edits to the
  catalog, no payload transformation language, no JSONPath query engine in
  attribute filters (three fixed operators; expressiveness grows by evidence,
  not speculation).
- **No realtime push to the console** (poll-based live mode only) and no
  change to the audit surface — audit remains the compliance lens; the
  explorer is the operational lens over the same log.
- **No inbound intake changes** — GitHub ingress, verification, and
  normalization stay in IG; a second SCM provider's events inherit all of ES
  by landing on the log in the `scm.*` shape.
