# Epic: saas-event-streaming

**The event log stops being an audit trail and becomes the product's nervous
system.** A Datadog-grade event pipeline built on rails the platform already
owns: every bounded context already writes one canonical, tenancy-scoped,
immutable `event_log`, and the GitHub integration already normalizes external
deliveries onto it as `scm.*` events. What is missing is everything downstream
of intake — the router/fan-out layer spec 09 mandates but never got, routing
rules that decide *who cares about which event*, channels beyond email (Slack
first, any webhook already shipped), and the deduplication/correlation layer
that turns a burst of related events (a push, its check runs, the deploy it
triggered) into one meaningful story instead of five noisy pings. This epic
pays the spec-09 router debt and builds the notification product on top of it.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — design complete, ready for review |
| Cluster | **ES** (event streaming & routing — pays spec 09's router debt; consumes B2 email, B5 webhooks, IG2 `scm.*`; delivers the P3/P4 seams) |
| Owner(s) | `apps/events-worker` (the routing brain) + `apps/notifications-worker` (channels) + `apps/webhooks-worker` (lane adoption) + `apps/api-edge` + `packages/db` + `packages/contracts`/`sdk`/`cli` + `apps/web-console-next` |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `components/09-events-audit-observability.md` (owns router/fan-out/dead-letter — unbuilt), `components/14-notifications.md` (email V1, "rich routing deferred"), `components/15-webhooks-integrations.md` (outbound lane, cursor + cron pattern), `components/17-integrations.md` + `saas-integrations` IG2 (`scm.*` on event_log), `030_events_audit_core` envelope (`correlation_id`/`causation_id`/`idempotency_key` present, unconsumed), `090_webhooks_delivery` (`webhook_dispatch_cursor` — the lane seam already named `subscriber_lane`), `110_billing_foundation` entitlement seam |
| Decisions locked | Structural: (1) **no new worker** — the router lives in the `events` bounded context, exactly where spec 09 assigns fan-out/dead-letter; channel *delivery* stays in the channel-owning contexts (notifications: email/Slack; webhooks: customer HTTP). (2) **Lanes over queues** — generalize the shipped webhooks cursor-lane pattern (Postgres cursor + cron drain + attempts + replay) into a shared lane contract; no Cloudflare Queues/DOs in V1, the lane contract *is* the extraction seam to Queues/Kafka later (spec 09's stated intent). (3) **Catalog before routing** — a typed, additive-only event catalog in `packages/contracts` (category, severity, title template, dedup-key template) is the single vocabulary rules, dedup, and the explorer all consume; no routing on unregistered types. (4) **Rules route, channels deliver** — notification rules are org/project-scoped data evaluated centrally in the router; a match enqueues channel work; channel workers own provider mechanics and retries. (5) **Integration events correlate, don't re-ingest** — `scm.*` is already on the bus (IG2); the GitHub work here is joining it with platform events (`state.run.*` by repo+sha) and deduplicating overlap via catalog keys, not new intake. (6) **Slack ships credential-free first** — incoming-webhook URLs (pasted by the customer, stored encrypted like endpoint secrets); the OAuth Slack App is a gated upgrade, not the entry ticket. |
| Gate | The spine ES0–ES7 is **human-independent** (Slack incoming webhooks need no app registration). Only the optional Slack App upgrade (D1 alternative) and the retention/quota pricing tiers (D3) need human decisions — park-and-continue, same posture as IG's D1. |

## Thesis

Datadog's durable insight is that events are only valuable *after* the
pipeline: intake is table stakes; the product is normalization, deduplication,
correlation, routing, and the explorer. This platform is unusually well
positioned to deliver that because intake is already solved — there is exactly
one event bus (`events.event_log`), every mutation in every bounded context
already lands on it with a versioned envelope carrying `correlationId`,
`causationId`, and `idempotencyKey`, and external GitHub deliveries are already
verified, deduped, attributed to a tenant, and normalized onto it as `scm.*`
projections. Today that log fans out to precisely one consumer lane (outbound
webhooks) and notifies through precisely one channel (email, synchronous,
single-attempt). Meanwhile spec 09 has always mandated a router — "persist
once → determine subscribers → forward to delivery lanes → track failures,
dead-letter, replay" — that was never built.

The mechanism: promote events-worker from a read-only audit API into the
**routing brain**. A typed event catalog gives every event a category, a
severity, and a dedup key. A generalized **lane** contract (the
`webhook_dispatch_cursor` pattern, promoted from a webhooks-worker private
detail to a platform primitive) gives any consumer an at-least-once, cursored,
replayable subscription with a dead-letter queue. **Notification rules** —
org/project-scoped, matching on type globs, severity, source, and payload
attributes, with throttle windows — decide who hears about what, and route to
**channels**: email (shipped), Slack (new), and the customer's existing
webhook endpoints (shipped). **Correlation** joins GitHub's view of a commit
with the platform's view of the same commit (`scm.check.completed` ×
`state.run.completed` on repo+sha) into one event group, so the customer gets
one story — "push `abc123` → checks green → deployed to staging" — not five
duplicates. The console gets a Datadog-standard **Events explorer** over the
grouped stream. Everything is entitlement-gated, policy-gated, audited, and
additive: no shipped surface (audit UI, webhook fan-out, email) changes
behavior uninvited.

## How it maps to Datadog (the reference)

| Datadog | Here |
|---------|------|
| Event Management intake (integrations + API) | `event_log` written by every bounded context; `scm.*` via the GitHub App (IG2); `POST /v1/organizations/{orgId}/events` custom ingest (ES5) |
| Event pipeline: normalize + enrich | Versioned envelope (spec 09) + the typed catalog: category, severity, title template per registered type (ES0) |
| Aggregation keys + deduplication | Catalog dedup-key templates rendered per event → `event_groups` with inactivity windows (ES4) |
| Correlation (related events → one case) | `correlationId`/`causationId` chains + cross-source joins (`scm.*` × `state.run.*` on repo+sha) into grouped stories (ES4) |
| Monitors + notification rules (`@slack-…`, `@webhook-…`) | `notification_rules`: type globs + severity + attribute filters + throttle windows → rule targets (ES2) |
| Notification integrations: Slack, email, webhooks | Channel-provider seam in notifications-worker: email (shipped), Slack incoming webhook (ES3), B5 webhook endpoints (shipped, reused as a target kind) |
| Events Explorer | Console Events surface: filters, severity facets, grouped timeline, event detail (ES6) |
| Retention + usage tiers | `limit.event_retention_days`, metered custom ingest, rule/channel count limits via the shipped entitlement seam (ES7) |

## Read order

1. `README.md` (this file) — status + thesis + milestones-at-a-glance.
2. `design.md` — the routing brain, the catalog, the lane contract, rules,
   channels, correlation/dedup, custom ingest, console UX, governance.
3. `implementation-plan.md` — ES0–ES7, each with "done when".
4. `risks-and-open-questions.md` — D1–D4 product decisions (Slack mode,
   substrate, retention pricing, ingest quotas) and R1–R7 engineering risks
   (notification storms, false merges, lane lag, secret handling).

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| ES0 | Foundation (dormant): typed event catalog in `packages/contracts`, `470_event_streams_foundation` migration (lanes, cursors, dead letters, rules, channels, groups), repo layer, fix the silent-404 notifications→events emit, spec 09/14 amendments — no live behavior | 🗓️ Planned |
| ES1 | The router: events-worker cron + shared lane dispatch, webhooks lane adopts the shared cursor contract (backfilled, zero delivery loss), dead-letter capture + `event.delivery_failed`/`dead_letter.created`, replay API | 🗓️ Planned |
| ES2 | Notification rules: CRUD + RBAC + entitlements, multi-segment glob/severity/attribute matching in the router, targets = email + existing B5 webhook endpoints, per-rule throttle windows | 🗓️ Planned |
| ES3 | Channels: provider seam in notifications-worker, Slack incoming-webhook channel (encrypted config, test send), channel CHECK lift `email→email\|slack`, async delivery with cron retry ladder | 🗓️ Planned |
| ES4 | Correlation & dedup: catalog dedup keys → `event_groups`, `scm.*` × `state.run.*` repo+sha join, group-aware notification throttling (notify per story, not per event) | 🗓️ Planned |
| ES5 | Custom event ingest: authenticated `POST /v1/organizations/{orgId}/events` (`custom.*` namespace), API-key scope, metering + rate limits, SDK/CLI surface | 🗓️ Planned |
| ES6 | Console to Datadog standard: Events explorer (facets, grouped timeline, detail drawer), rule builder, channel management + test send, dead-letter ops surface | 🗓️ Planned |
| ES7 | Scale & lifecycle: retention tiers + archival sweep, hot-org lane fairness, storm suppression (per-rule circuit breaker), admin-worker visibility | 🗓️ Planned |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The router/fan-out layer inside the `events` context; the typed event catalog; the shared lane contract + dead-letter + replay; notification rules and their evaluation; the channel-provider seam + Slack (incoming webhook); event dedup/correlation into groups; custom event ingest API; console Events explorer + rules/channels UX; retention/entitlement gating; SDK/CLI; audit of every new mutation | Metric monitors / numeric thresholds / alerting on time-series (this is an *event* pipeline; metering owns numbers); on-call schedules, paging, escalation policies (surface-don't-page is TC's line — ES provides the substrate TC's team targets plug into); a realtime push bus / websockets to the console (explorer is poll/read); inbound intake changes (IG2 owns GitHub ingress; ES consumes what lands on the log); Cloudflare Queues/Kafka adoption (the lane contract is the seam, migration is a later decision — D2); replacing the audit UI (audit stays; the explorer is the operational twin) |

## Relationship to existing work

- **Spec 09 (events/audit/observability)**: this epic *is* the deferred half of
  that contract — router, subscriber registry, dead-letter, `event.delivery_failed`.
  The shipped half (canonical log + audit read API) is consumed unchanged.
- **B2 / spec 14 (notifications)**: email delivery, preferences, and suppression
  are reused as the first channel. Spec 14 explicitly deferred "rich notification
  routing" — ES2/ES3 are that deferral coming due. The broken
  notifications→events emit (POST to a route events-worker never had) is fixed
  in ES0 by writing the log directly via `@saas/db/events` like every other context.
- **B5 / spec 15 (webhooks)**: the proven cursor-lane machinery is promoted to a
  platform primitive; webhooks-worker becomes the first *adopter* of the shared
  contract (ES1) and webhook endpoints become a notification-rule target kind
  (ES2). Delivery mechanics, signing, and replay are untouched.
- **IG / spec 17 (integrations)**: IG2 already lands verified, deduplicated,
  normalized `scm.*` events on the log — ES adds no GitHub intake. ES4 joins
  those events with platform events into single stories; the provider seam means
  GitLab/Bitbucket events inherit routing/correlation for free when their
  adapters land.
- **TC (teams-collaboration)**: TC's "team as notification target" and
  "event→owning-team routing" plug into ES primitives — `rule_targets.target_kind`
  is forward-defined to admit `team` (expand-to-members at enqueue), and TC's
  routing rides the same rule evaluation. ES ships individual/channel targets;
  TC ships the team target kind. No file contention: TC touches membership
  expansion, ES owns the rule engine.
- **P3 (observability) / P4 (notification inbox)** in the holding register: ES
  delivers their platform halves (event explorer, rule/channel substrate). An
  in-app inbox becomes "one more channel kind" when P4 is promoted.
- **BM (orun-backend merge)**: BM's per-run Durable-Object event streams are a
  *coordination* plane, not this bus. `state.run.*` projections land on
  event_log regardless; ES consumes them like any other type. Not a dependency
  either way.
- **saas-multi-org-billing**: rules, channels, retention, and custom-ingest
  volume are entitlement-gated (`feature.*`/`limit.*`), reusing the materialized
  per-org seam and the U7 upgrade UX unchanged.
