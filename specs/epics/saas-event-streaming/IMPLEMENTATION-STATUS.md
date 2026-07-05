# saas-event-streaming — Implementation Status

As-built record. Epic authored 2026-07-02 from the current-state audit of the
eventing stack (events/notifications/webhooks/integrations workers).

## Summary

| ID | Status |
|----|--------|
| ES0 — Foundation (catalog, `580_event_streams_foundation`, repo layer, notifications emit fix, spec 09/14 amendments) | ✅ Shipped (#325) |
| ES1 — Router: shared lanes + dead letters + webhooks cutover | ✅ Shipped (#331) |
| ES2 — Notification rules | ✅ Shipped (#334) |
| ES3 — Channels: provider seam + Slack incoming webhook + async retry | In review |
| ES4 — Correlation & dedup (event groups) | 🗓️ Planned |
| ES5 — Custom event ingest + SDK/CLI | 🗓️ Planned |
| ES6 — Console: Events explorer + rules/channels UX | 🗓️ Planned |
| ES7 — Scale & lifecycle (retention, fairness, storm breaker) | 🗓️ Planned |

## Notes

- 2026-07-02: Epic authored. Current-state findings baked into the design:
  spec 09's router/subscriber/dead-letter layer confirmed unbuilt; the
  `webhook_dispatch_cursor` table already keyed by `subscriber_lane` (the seam
  ES1 promotes); notifications-worker's `notification.*` emits confirmed to
  POST to a route events-worker does not expose (silent 404 — absorbed as the
  ES0 fix, tracked as R7); envelope `correlation_id`/`causation_id`/
  `idempotency_key` present since `030_events_audit_core` and unconsumed;
  notification channel CHECKs hard-locked to `'email'` across all four tables
  (`120_notifications_core`).
- 2026-07-02: Migration numbers `470`/`480`/`490` were reserved against head `460_state_repo_facet`; parallel work consumed 470-570, so ES0 landed as `580_event_streams_foundation` (follow-ons renumbered `590`/`600`).
- 2026-07-04: ES0 shipped (#325) — catalog + CI guard live, migration 580
  applied on stage and prod via db-migrate (CI lanes green), notification.*
  events now auditable. Both latent defects from the audit are closed.
- 2026-07-04: ES1 landed the webhooks cursor cutover as migration
  `590_webhooks_lane_adoption` (renumbered from the planned 600 — parallel
  work made 590 the next free slot; the ES3 channels migration takes the next
  free number at its landing). Dual-read fallback kept the legacy
  webhook_dispatch_cursor table intact per R6; the drop is a follow-up
  migration after the soak. The dispatcher ships dark (no events-owned lane
  handler until ES2; 'notifications' lane seeded paused).
- 2026-07-04: ES1 shipped (#331) — dispatcher live (dark), webhooks cursor on
  the shared lane table with dual-read fallback, dead-letter list/replay
  surface end-to-end.
- 2026-07-04: ES2 scope amendment — `webhook_endpoint` rule targets deferred
  to ES3. Implementation audit showed B5's webhook_delivery_attempts requires
  a NOT NULL subscription_id with (subscription, event, attempt) uniqueness
  and subscription-keyed replay; a subscription-less rule delivery would need
  invasive changes to the shipped delivery plane. Under "rules route,
  channels deliver", a webhook endpoint becomes a channel-kind delivery in
  ES3's provider seam instead (own retry mechanics via the notifications
  cron). ES2 ships email targets live; slack_channel/webhook_endpoint kinds
  are schema-live, CRUD-rejected. Entitlements seeded: feature.event_routing
  all tiers, limit.notification_rules 10/50/200/unlimited (D3 defaults);
  events-worker added to billing's internal-caller allow-list; notifications
  lane flipped active by 600_notification_rule_throttle.
- 2026-07-05: ES2 shipped (#334) — rules engine live on the router; email
  targets deliver; slack_channel/webhook_endpoint schema-live but CRUD-rejected.
  Rebased through a parallel policy-engine change (owner action count).
- 2026-07-05: ES3 in review — channel-provider seam in notifications-worker
  with the Slack incoming-webhook provider (Block Kit, D1 default: no OAuth
  app, credential-free). Migration `610_notification_channels` creates the
  encrypted-config channel table (config_ciphertext = AES-GCM envelope, never
  returned on CRUD reads — R4), lifts the channel CHECK to ('email','slack')
  on the three channel-bearing tables, and adds next_retry_at + attempt_count
  for the async retry cron (30s·4^(n-1), 5 attempts). Channels CRUD + test-send
  on notifications-worker (org-scoped, policy organization.notification_channel
  .read/write, feature.notifications.slack + limit.notification_channels
  entitlements) behind a new api-edge facade; notifications-worker gained
  membership/policy/billing bindings (no dep cycle — verified via orun plan).
  slack_channel rule targets unblocked end-to-end; webhook_endpoint still
  deferred. Slack URLs are irrecoverable: write-only ciphertext, network
  errors reduced to a fixed non-secret reason.
- Decision gates D1–D4 are open with defaults recommended; none block the
  spine (see `risks-and-open-questions.md`).
