# saas-event-streaming — Implementation Status

As-built record. Epic authored 2026-07-02 from the current-state audit of the
eventing stack (events/notifications/webhooks/integrations workers); nothing
has shipped yet.

## Summary

| ID | Status |
|----|--------|
| ES0 — Foundation (catalog, `580_event_streams_foundation`, repo layer, notifications emit fix, spec 09/14 amendments) | 🗓️ Planned |
| ES1 — Router: shared lanes + dead letters + webhooks cutover | 🗓️ Planned |
| ES2 — Notification rules | 🗓️ Planned |
| ES3 — Channels: provider seam + Slack incoming webhook + async retry | 🗓️ Planned |
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
- Decision gates D1–D4 are open with defaults recommended; none block the
  spine (see `risks-and-open-questions.md`).
