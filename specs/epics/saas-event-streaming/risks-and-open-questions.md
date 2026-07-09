# saas-event-streaming — Risks & Open Questions

Status: Draft. D1–D4 are product/human-gated decisions (none block the spine);
R1–R7 are engineering risks owned by named milestones.

## Human-gated decisions

### D1 — Slack delivery mode: incoming webhooks vs OAuth Slack App

Incoming webhooks are credential-free for the platform (the customer pastes a
URL scoped to one channel), ship in ES3 with zero human setup, and match the
"park-and-continue" posture. A first-party Slack App (OAuth install, channel
picker, threads, message updates, interactivity) is strictly richer but needs
an app registered per environment (client id/secret, signing secret), a public
OAuth callback, and Slack directory review if listed — the same class of gate
as IG's GitHub App registration.

**Default recommendation:** ship incoming webhooks in ES3 behind the
`ChannelProvider` seam; treat the Slack App as a follow-up provider
(`slack_app`) registered when a human supplies credentials — an additive
channel kind, not a migration. Group-story *message updating* (ES4's nicest
rendering) degrades gracefully to append-posts under incoming webhooks.

**⬆ Promoted:** the `slack_app` follow-up is now owned by
[`saas-integration-hub`](../saas-integration-hub/) (IH1–IH3), exactly in the
shape recommended here — an additive channel kind behind this seam, with
credential custody in integrations-worker.

### D2 — Streaming substrate: stay on cron + Postgres lanes, or adopt Cloudflare Queues

The house pattern (webhooks, integrations drains) is cron + Postgres cursors;
it is operationally proven here, transactional with the log, and replayable by
construction. Queues would cut worst-case latency from ~60s to seconds and
shed polling load, but adds a new platform dependency, per-message (not
per-cursor) semantics, and a second delivery-state store to reconcile.

**Default recommendation:** lanes (cron + Postgres) for the whole epic. The
lane contract (named lane, ordered cursor, at-least-once handler, dead-letter)
is deliberately isomorphic to a Queues consumer or Kafka consumer group;
revisit only if measured lane lag (ES7 metric) exceeds budget at real tenant
scale. A minutely cron is Datadog-grade for *notifications*; it is not a
realtime bus and does not pretend to be.

### D3 — Retention windows and plan tiers

`limit.event_retention_days` defaults (e.g. free 30d / pro 90d / enterprise
365d+), whether closed groups outlive their member events, and whether the
security-category floor (kept regardless of plan) is 400d or "forever" are
pricing/compliance calls, not engineering ones. Same for
`limit.notification_rules` / `limit.notification_channels` counts per tier.

**Default recommendation:** ship ES7 with conservative placeholder tiers
(30/90/365, security floor 400d, 10 rules + 3 channels on free) wired through
the entitlement seam so changing the answer is a config edit, not a migration.

### D4 — Custom ingest quotas and data posture

`limit.custom_events_per_day` per tier, the payload cap (32KiB proposed), and
the PII stance (custom payloads are customer-authored: do we document
"no regulated data in event payloads" as ToS, offer redaction paths on ingest,
or both?) need a product/legal pass before ES5 is *announced* — not before it
is built.

**Default recommendation:** build ES5 behind `feature.events.custom_ingest`
defaulting off; enable per-tier after the quota/PII decision. Support
`redactPaths` on ingest from day one (the envelope already carries it), which
makes the eventual policy answer implementable either way.

## Engineering risks

### R1 — Notification storms / fan-out amplification (severity: critical; owner ES2, breaker ES7)

A hot event family (e.g. a flapping check on a busy repo) times a broad rule
(`scm.*` → Slack) into channel spam, provider rate-limiting, and tenant trust
damage — the classic first failure of every event product. Mitigations are
layered by design: per-rule throttle windows are mandatory fields (ES2, not
optional polish), group-aware firing collapses stories (ES4), the per-rule
circuit breaker auto-suppresses saturated rules with an admin notice (ES7),
and lane pause is the global kill switch (ES1). The epic is not "announced"
until the breaker exists (sequencing note).

### R2 — False merges in dedup/correlation (severity: high; owner ES4)

Over-aggressive grouping that merges unrelated events destroys trust faster
than duplicates do — a wrong story is worse than a noisy one. Guards are
structural: dedup keys are catalog-authored templates only (no similarity
heuristics), keys always embed the org id, types without keys never group,
causation joins are gated by the `correlates` allow-list, and the false-merge
cases (same repo different sha, same sha different org) are named test
fixtures in the ES4 "done when".

### R3 — Lane lag on hot orgs (severity: medium; owner ES1, measured ES7)

One org's burst can starve others within a cron tick, and cursor lanes add up
to a minute of baseline latency. Per-tick per-org batch caps, the
`type_filter` prefilter (lanes skip rows they cannot match), the lane-lag
metric with its self-routing alert event, and the D2 escape hatch bound the
damage. Accepted posture: this is a notification pipeline with ~1min
worst-case freshness, stated openly in docs.

### R4 — Slack webhook URLs are bearer credentials (severity: high; owner ES3)

An incoming-webhook URL grants post access to a customer channel. It is
handled exactly like webhook endpoint secrets: AES-GCM under
`SECRET_ENCRYPTION_KEY`, write-only API (never echoed after create), excluded
from logs, events, and audit payloads, test-send responses reveal delivery
status only. Channel delete zeroizes the ciphertext row.

### R5 — Event taxonomy drift (severity: medium; owner ES0)

The catalog only works if it is actually total: an emitter shipping an
unregistered type silently escapes routing, severity, and the explorer's
vocabulary. The ES0 CI guard (every `appendEvent` literal must be registered)
makes drift a build failure, and additive-only rules keep old rules/groups
valid forever. Residual risk: dynamically-constructed type strings evade the
grep-based guard — convention (literal types only) is asserted in review and
the guard fails on non-literal arguments rather than skipping them.

### R6 — Webhooks lane cutover (severity: medium; owner ES1)

Moving the shipped, production-hot webhooks cursor onto `events.lane_cursors`
risks skipped or duplicated deliveries for every tenant at once. Protocol:
migration copies cursors; webhooks-worker dual-reads and asserts equality for
a soak window (stage then prod); cutover flips reads; the legacy table drops
only after the soak proves parity. The existing webhooks contract tests plus a
dedicated cutover assertion are the gate, and delivery idempotency keys make
an accidental overlap harmless (duplicate-attempt rows, not duplicate sends).

### R7 — The notifications→events emit fix changes observable behavior (severity: low; owner ES0)

Today `notification.*` events vanish (404 into the void); after ES0 they
appear in event_log and audit. That is the *specified* behavior (spec 14) but
it changes audit volume and could surprise tests or downstream consumers
matching `*` webhooks subscriptions. Mitigation: land the fix with catalog
registration and a release note; `notification.*` is excluded from the
`'notifications'` lane's own rule matching by the recursion guard (no
self-notification loops).

## Explicitly deferred

- Account(workspace-spanning)-level rules and channels — after WID7's
  scope-resolution chain is established; schema is compatible (org-scoped rows
  under a future resolver).
- `team` and `inbox` target kinds — owned by TC and P4 respectively;
  `rule_targets.target_kind` admits them without migration.
- Slack App provider (D1 alternative), Microsoft Teams / Discord providers —
  additive `ChannelProvider` implementations.
- Realtime console push (websocket/SSE tail) — explorer live mode stays
  poll-based until a platform-wide realtime decision exists.
- Cloudflare Queues/Kafka substrate swap — D2, evidence-gated on the ES7 lag
  metric.
- Payload transformation / templating language for webhook targets, JSONPath
  attribute queries — expressiveness grows by demonstrated need.
- Metric monitors and threshold alerting — metering may emit
  threshold-crossing *events*; evaluation of numbers is out of scope here.
