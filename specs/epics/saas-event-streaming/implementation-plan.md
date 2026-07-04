# saas-event-streaming — Implementation Plan (ES0–ES7)

Status: Draft. Milestones are PR-sized coherent units with one primary outcome
each; the spine is strictly ordered, the tails are detachable.

## ES0 — Foundation (dormant) — ✅ Shipped (#325)

- `packages/contracts/src/event-catalog.ts`: `CatalogEntry`, `EventCategory`,
  `EventSeverity`, `EVENT_CATALOG` covering every currently-emitted type
  (including the webhook lifecycle literals hardcoded in
  `apps/webhooks-worker/src/delivery.ts`), existing per-context constant maps
  re-exported from the registry.
- CI guard in `tests/contracts`: every event type literal passed to
  `appendEvent`/`appendEventWithAudit` across the workspace is registered in
  the catalog; unregistered types fail the build.
- Migration `580_event_streams_foundation` (schema `events`, manifest entry,
  checksum): `subscriber_lanes`, `lane_cursors`, `dead_letters`,
  `notification_rules`, `rule_targets`, `event_groups`, `event_group_members`
  per design §§4–5, §7 — tables only, nothing reads them yet.
- Repo layer `packages/db/src/events/streams.ts` (lanes, cursors, dead
  letters) + `rules.ts` (rules, targets) + `groups.ts`, with unit tests.
- Fix the silent-404 emit: notifications-worker drops
  `src/events-client.ts`'s HTTP POST and writes `notification.*` events via
  `@saas/db/events` like every other context (design §1); confirm/adjust
  `tests/notifications-worker` expectations so delivery is auditable.
- Spec amendments: `components/09-events-audit-observability.md` (router =
  this epic; catalog; lane contract) and `components/14-notifications.md`
  (channel seam incoming; the deferred "rich routing" now has an owner) —
  `Status:` lines name `saas-event-streaming`.

**Done when:** the migration applies cleanly on a fresh database and on stage;
the catalog CI guard passes with every existing emitter registered;
`notification.*` events appear in `event_log`/`audit_entries` in the
notifications-worker test suite; no runtime behavior changes anywhere else
(webhooks fan-out and audit reads byte-identical).

## ES1 — The router: shared lanes + dead letters — In review

- events-worker gains `scheduled()` (cron `* * * * *`, matching the shipped
  drains) + the lane dispatcher: per active lane × org, batch-read past the
  cursor via the existing keyset queries, invoke the lane handler, advance the
  cursor on success, dead-letter a poisoned event after bounded retries
  (backoff ladder identical to the webhooks drain).
- Lane registry seeded: `'webhooks'` (owned by webhooks-worker) and
  `'notifications'` (handler lands in ES2; registered paused).
- webhooks-worker cutover to `events.lane_cursors`: backfill from
  `webhooks.webhook_dispatch_cursor` in one migration
  (`590_webhooks_lane_adoption`), read/write the shared table, drop the old
  one after a verified soak — zero lost or duplicated deliveries (R6 protocol:
  copy → dual-read assert → cutover → drop).
- Dead-letter lifecycle: `event.delivery_failed`, `dead_letter.created`,
  `dead_letter.replayed` emitted (catalog-registered); recursion guard
  generalizes the `webhook.*` skip to `event.*`/`dead_letter.*`.
- Internal replay surface: `POST /v1/organizations/{orgId}/dead-letters/{id}/replay`
  on events-worker + api-edge facade (policy `organization.dead_letter.replay`).
- Lane pause/resume via `subscriber_lanes.status` (operational kill switch).

**Done when:** webhooks fan-out runs entirely on the shared lane contract with
delivery parity proven by the existing webhooks contract tests plus a
cutover-soak assertion; a lane handler that throws on one event dead-letters
that event, advances past it, and the replay route re-processes it
successfully; pausing a lane halts its dispatch within one cron tick.

## ES2 — Notification rules — 🗓️ Planned

- Rules/targets CRUD on events-worker + api-edge facade:
  `GET/POST /v1/organizations/{orgId}/notification-rules`,
  `GET/PATCH/DELETE …/{ruleId}`, `POST …/{ruleId}/test` (synthesizes a sample
  event, returns matched targets without sending). RBAC per design §10;
  entitlements `feature.event_routing` + `limit.notification_rules` (412 +
  upgrade UX).
- Matching engine in the `'notifications'` lane handler: multi-segment glob →
  `min_severity` (catalog ladder) → org/project scope → conjunctive attribute
  filters (`eq|neq|in`), cheapest-first; per-rule throttle windows enforced via
  a small `rule_throttle_state` upsert.
- Targets V1: `email` (address) and `webhook_endpoint` (existing B5 endpoint —
  the rule enqueues a delivery attempt through the shipped webhooks machinery
  rather than a second HTTP path). `slack_channel` kind is schema-live but
  rejected until ES3.
- Enqueue path: one notification per surviving `(rule, target)` via
  `packages/notifications-client` with deterministic
  `idempotencyKey = hash(ruleId, targetId, eventId)` — cron overlap cannot
  double-send.
- `notification_rule.created|updated|deleted` events + audit; SDK/CLI rule
  CRUD deferred to ES5 (one surface at a time).

**Done when:** a rule matching `scm.pull_request.*` with `min_severity: info`
and an email target delivers exactly one email per matching event on stage
(idempotent under forced cron overlap); attribute filters and project scoping
are covered by worker tests; a throttled rule provably caps at
`throttle_max` per window; the entitlement gate 412s beyond the plan limit.

## ES3 — Channels: provider seam + Slack — 🗓️ Planned

- Migration `590_notification_channels`: `notification_channels` table +
  channel CHECK lift (`'email'` → `'email','slack'`) across the four
  notification tables (design §6).
- `ChannelProvider` seam in `apps/notifications-worker/src/channels/`
  (registry pattern per the shipped provider registries); email refactored
  behind it unchanged; `slack_incoming_webhook` provider: Block Kit rendering
  (catalog title, severity color, scope line, console deep link), URL stored
  AES-GCM-encrypted (write-only, never echoed/logged — R4), `verify()` = test
  send.
- Channels CRUD via api-edge → notifications-worker:
  `GET/POST /v1/organizations/{orgId}/notification-channels`,
  `PATCH/DELETE …/{channelId}`, `POST …/{channelId}/test`. RBAC + entitlements
  (`feature.notifications.slack`, `limit.notification_channels`).
- Async delivery: notifications-worker gains cron; enqueue returns after row
  insert; drain delivers `queued` rows through providers with the
  30s·4^n ladder into `notification_attempts`; email inherits retries.
- `rule_targets.target_kind = 'slack_channel'` unblocked;
  `notification_channel.*` lifecycle events + audit.

**Done when:** pasting a Slack incoming-webhook URL, test-sending, attaching
the channel to a rule, and receiving a formatted Block Kit message for a live
`scm.push` works end-to-end on stage; a transient provider failure retries on
the ladder and lands `sent` with the attempt trail recorded; the URL is
irrecoverable via any API response, log line, or event payload.

## ES4 — Correlation & dedup — 🗓️ Planned

- Catalog dedup-key templates authored for the correlated families first:
  `scm.push` / `scm.check.completed` / `state.run.completed|failed` sharing
  `(orgId, repoFullName, headSha)`-shaped keys; `correlates` allow-lists set.
- `'grouping'` lane (runs before `'notifications'` in the dispatch order):
  renders keys, upserts `event_groups` (partial-unique open group per
  `(org_id, group_key)`), appends members, escalates `max_severity`, closes
  groups on inactivity window; causation-chain join per design §7.
- Group-aware notification: throttled rules fire on first membership and on
  severity escalation, not per member; Slack renders the story card
  (member count, latest state) with a group deep link.
- Read API: `GET /v1/organizations/{orgId}/event-groups` + `…/{groupId}`
  (members timeline), policy `organization.event.read`.
- Conservatism guards (R2) enforced in code: no key → no group; org id always
  embedded in the rendered key; `correlates` allow-list checked before
  causation joins across types.

**Done when:** on stage, a push to a linked repo whose run completes produces
one open group containing the `scm.push`, `scm.check.completed`, and
`state.run.completed` events, a rule targeting Slack posts once (not three
times) and updates on escalation, and the group closes after the inactivity
window; worker tests cover false-merge guards (different sha ⇒ different
group; missing dedupKey ⇒ ungrouped).

## ES5 — Custom event ingest + SDK/CLI — 🗓️ Planned

- `POST /v1/organizations/{orgId}/events` (api-edge → events-worker's first
  write route): `custom.*` namespace enforced server-side, payload ≤ 32KiB,
  edge rate limit, policy `organization.event.ingest`, entitlements
  `feature.events.custom_ingest` + `limit.custom_events_per_day`, metered as
  `custom_events_ingested`.
- Explorer read API: `GET /v1/organizations/{orgId}/events` + `…/{eventId}`
  (typed filters: type glob, category, severity, source, project/environment,
  time range; keyset pagination; redaction-respecting) — the operational twin
  of the shipped audit query.
- SDK: `events.emit`, `events.list`, `events.get`, `eventGroups.list`,
  `notificationRules.*`, `notificationChannels.*`.
- CLI: `orun-cloud events emit|list|tail` (tail = poll loop over the query
  API), `orun-cloud notification-rules list|create|test`.
- Custom events verified as full citizens: route through lanes, match rules,
  group via caller-supplied `dedupKey`, fan out to B5 webhooks.

**Done when:** `orun-cloud events emit --type custom.deploy --title "v42 to
prod"` appears in the explorer API, triggers a matching Slack rule, and is
visible in metering rollups; namespace escape attempts
(`--type billing.invoice_paid`) are rejected 400; quota exhaustion 412s with
the upgrade payload.

## ES6 — Console to Datadog standard — 🗓️ Planned

- Events explorer page (`/orgs/{slug}/events`): faceted, URL-driven (U3),
  keyset-paginated stream with live-poll toggle; group story cards expanding
  to member timelines; detail drawer with envelope, payload, trace-chain
  links, and "create rule from this event".
- Rules surface (`settings/notifications/rules`): list, builder (catalog-fed
  type picker, severity floor, scope, attribute filter rows, target picker,
  throttle), test-fire preview, recent-firings panel.
- Channels surface (`settings/notifications/channels`): add-Slack paste flow
  with test send + verified badge, health column (last delivery/failure).
- Dead-letter ops view (org settings, admin-gated): reasons, replay/discard.
- Empty states, skeletons, Cmd-K entries per U4/U5; SDK client wiring per U10.

**Done when:** a buyer walkthrough — connect GitHub, push, watch the grouped
story appear in the explorer, build a Slack rule from the event, receive the
message — needs zero API calls outside the console, and every new page passes
the U-track empty/loading/error states review.

## ES7 — Scale & lifecycle — 🗓️ Planned

- Retention sweep (events-worker cron, off-peak batches) enforcing
  `limit.event_retention_days` on `event_log`/`audit_entries` with the
  security-category floor (design §10); fixed platform windows for dead
  letters and closed groups; partitioning fallback documented with trigger
  thresholds.
- Hot-org fairness: per-tick org batch caps + lane lag metric
  (`occurred_at` − cursor age) surfaced to admin-worker; alert event
  `event.lane_lagging` when lag exceeds budget (routes like any event — the
  pipeline monitors itself).
- Storm suppression: per-rule circuit breaker (auto-disable after sustained
  `throttle_max` saturation, `notification_rule.suppressed` event + console
  banner + one meta-notification to org admins), mirroring the webhook
  auto-disable discipline.
- Admin-worker surfaces: cross-org lane health, dead-letter counts, rule storm
  audit.
- Load validation: synthetic 10k-event burst on stage stays within lane-lag
  budget and produces zero duplicate notifications.

**Done when:** retention provably deletes only past-window, non-security rows
(test fixture matrix); the synthetic burst meets the lag budget with fairness
caps engaged; a deliberately pathological rule trips the breaker, notifies
admins once, and re-enables cleanly.

## Sequencing note

**ES0 → ES1 → ES2 → ES3** is the strict spine: catalog before router, router
before rules, rules before the channel that makes them shine. **ES4** needs
ES2 (group-aware throttling assumes rules) but not ES3. **ES5** detaches after
ES1 (custom events only need the log + lanes; SDK/CLI ride whenever). **ES6**
starts after ES2 and lands surface-by-surface alongside ES3–ES5. **ES7** is
the hardening tail but its storm breaker should land before ES is announced.
Every milestone is human-independent; the only parked items live in
`risks-and-open-questions.md` (D1's Slack App variant, D3's pricing tiers) and
nothing on the spine waits for them. No file contention with TC (rule engine
here, team-target expansion there) or BM (different plane).
