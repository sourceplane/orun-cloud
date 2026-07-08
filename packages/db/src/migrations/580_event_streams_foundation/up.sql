-- Event streams foundation (saas-event-streaming ES0).
-- Context: events
-- Idempotent: uses IF NOT EXISTS throughout.
--
-- Spec 09 has always assigned a router/fan-out layer to the events context
-- ("persist once → determine subscribers → forward to delivery lanes → track
-- failures, dead-letter, replay") that was never built; the only consumer of
-- events.event_log today is webhooks-worker's private cron poll over
-- webhooks.webhook_dispatch_cursor — a table whose (org_id, subscriber_lane)
-- key already anticipated multiple lanes. This migration lays the shared
-- substrate that pays that debt: a lane registry + events-owned cursors
-- (webhooks adopts them in ES1), a dead-letter store, org/project-scoped
-- notification rules with targets (evaluated in ES2), and dedup/correlation
-- event groups (activated in ES4). Tables only — nothing reads or writes
-- them until the owning milestones land, so applying this migration changes
-- no runtime behavior anywhere.
--
-- Additive + idempotent; no cross-context foreign keys (dead_letters,
-- event_group_members reference events.event_log — same context).

CREATE SCHEMA IF NOT EXISTS events;

-- ---------------------------------------------------------------------------
-- Lane registry: one row per named subscriber lane (platform-global).
-- A lane is an at-least-once, cursored subscription over event_log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.subscriber_lanes (
  lane_key      TEXT        PRIMARY KEY,
  owner_context TEXT        NOT NULL,
  description   TEXT        NOT NULL DEFAULT '',

  -- Glob prefilter (JSONB array of type globs, e.g. ["scm.*","state.run.*"]).
  -- Empty array = all types.
  type_filter   JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Pausing a lane is the operational kill switch: dispatch halts within one
  -- cron tick; cursors stay put so resume loses nothing.
  status        TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'paused')),

  batch_size    INTEGER     NOT NULL DEFAULT 100
                            CHECK (batch_size > 0 AND batch_size <= 1000),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE events.subscriber_lanes IS
  'Subscriber-lane registry (spec 09 router) — one row per named cursored subscription over event_log.';

-- ---------------------------------------------------------------------------
-- Per-(lane, org) dispatch cursors. The events-owned generalization of
-- webhooks.webhook_dispatch_cursor; the webhooks lane migrates onto this
-- table in ES1 (copy → dual-read soak → cutover).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.lane_cursors (
  lane_key         TEXT        NOT NULL REFERENCES events.subscriber_lanes(lane_key),
  org_id           TEXT        NOT NULL,
  last_event_id    TEXT,
  last_occurred_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lane_key, org_id)
);

COMMENT ON TABLE events.lane_cursors IS
  'Per-(lane, org) keyset cursor into event_log — at-least-once dispatch position.';

-- ---------------------------------------------------------------------------
-- Dead letters: a poisoned event that exhausted its lane retries. A pointer
-- plus forensics — the event row in event_log stays the durable payload.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.dead_letters (
  id              TEXT        PRIMARY KEY,
  lane_key        TEXT        NOT NULL REFERENCES events.subscriber_lanes(lane_key),
  event_id        TEXT        NOT NULL REFERENCES events.event_log(id),
  org_id          TEXT        NOT NULL,

  -- Safe, bounded failure summary (same hygiene as webhook failure_reason:
  -- never raw provider bodies, never secrets).
  reason          TEXT        NOT NULL DEFAULT '',
  attempts        INTEGER     NOT NULL DEFAULT 1,

  status          TEXT        NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open', 'replayed', 'discarded')),

  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One dead letter per (lane, event): retries update the row, never fork it.
  CONSTRAINT dead_letters_lane_event_uq UNIQUE (lane_key, event_id)
);

CREATE INDEX IF NOT EXISTS dead_letters_org_created_idx
  ON events.dead_letters (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS dead_letters_open_idx
  ON events.dead_letters (lane_key, created_at)
  WHERE status = 'open';

COMMENT ON TABLE events.dead_letters IS
  'Poisoned lane deliveries — pointer + forensics; the event payload stays in event_log.';

-- ---------------------------------------------------------------------------
-- Notification rules: org/project-scoped routing decisions ("which events,
-- under which conditions, reach which targets, how often"). Evaluated by the
-- notifications lane handler from ES2.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.notification_rules (
  id                      TEXT        PRIMARY KEY,
  org_id                  TEXT        NOT NULL,
  project_id              TEXT,
  name                    TEXT        NOT NULL,
  status                  TEXT        NOT NULL DEFAULT 'enabled'
                                      CHECK (status IN ('enabled', 'disabled', 'suppressed')),

  -- Match clauses. event_types: JSONB array of multi-segment globs
  -- ("scm.pull_request.*"). sources: JSONB array or NULL (any source).
  -- attribute_filters: JSONB array of {path, op, value} conjuncts or NULL.
  event_types             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  min_severity            TEXT        NOT NULL DEFAULT 'info'
                                      CHECK (min_severity IN ('info', 'notice', 'warning', 'error', 'critical')),
  sources                 JSONB,
  attribute_filters       JSONB,

  -- Storm control is a mandatory field, not optional polish (design §5, R1).
  throttle_window_seconds INTEGER     NOT NULL DEFAULT 300
                                      CHECK (throttle_window_seconds >= 0),
  throttle_max            INTEGER     NOT NULL DEFAULT 10
                                      CHECK (throttle_max > 0),

  created_by              TEXT        NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_rules_org_name_uq UNIQUE (org_id, name)
);

CREATE INDEX IF NOT EXISTS notification_rules_org_created_idx
  ON events.notification_rules (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS notification_rules_enabled_idx
  ON events.notification_rules (org_id)
  WHERE status = 'enabled';

COMMENT ON TABLE events.notification_rules IS
  'Org/project-scoped event→notification routing rules with mandatory throttle windows.';

-- ---------------------------------------------------------------------------
-- Rule targets: where a matched rule delivers. target_kind is forward-defined
-- to admit team (TC) and inbox (P4) without schema change — the CHECK lists
-- only the kinds a lane handler can currently deliver; widening it is an
-- additive ALTER in the milestone that ships the new kind.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.rule_targets (
  id          TEXT        PRIMARY KEY,
  rule_id     TEXT        NOT NULL REFERENCES events.notification_rules(id) ON DELETE CASCADE,
  org_id      TEXT        NOT NULL,
  target_kind TEXT        NOT NULL
                          CHECK (target_kind IN ('email', 'slack_channel', 'webhook_endpoint')),
  -- email: the address; slack_channel: notification_channels public id
  -- (ES3); webhook_endpoint: webhooks endpoint public id. Cross-context
  -- references are by public id, never FK (bounded contexts).
  target_ref  TEXT        NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rule_targets_rule_kind_ref_uq UNIQUE (rule_id, target_kind, target_ref)
);

CREATE INDEX IF NOT EXISTS rule_targets_rule_idx
  ON events.rule_targets (rule_id);

COMMENT ON TABLE events.rule_targets IS
  'Delivery targets for a notification rule — email address, Slack channel, or webhook endpoint.';

-- ---------------------------------------------------------------------------
-- Event groups: the dedup/correlation read-model (one open story per
-- (org, rendered dedup key)). Rows here never mutate event_log; grouping is
-- an overlay. Activated by the grouping lane in ES4.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.event_groups (
  id             TEXT        PRIMARY KEY,
  org_id         TEXT        NOT NULL,
  group_key      TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open', 'closed')),
  first_event_id TEXT        NOT NULL,
  last_event_id  TEXT        NOT NULL,
  event_count    INTEGER     NOT NULL DEFAULT 1,
  max_severity   TEXT        NOT NULL DEFAULT 'info'
                             CHECK (max_severity IN ('info', 'notice', 'warning', 'error', 'critical')),
  first_at       TIMESTAMPTZ NOT NULL,
  last_at        TIMESTAMPTZ NOT NULL,
  closed_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One open story per key: the partial unique is the correlation invariant.
CREATE UNIQUE INDEX IF NOT EXISTS event_groups_open_key_uq
  ON events.event_groups (org_id, group_key)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS event_groups_org_last_idx
  ON events.event_groups (org_id, last_at DESC, id DESC);

COMMENT ON TABLE events.event_groups IS
  'Dedup/correlation groups — one open story per (org, rendered dedup key); a read-model overlay, never a mutation of event_log.';

CREATE TABLE IF NOT EXISTS events.event_group_members (
  group_id TEXT        NOT NULL REFERENCES events.event_groups(id) ON DELETE CASCADE,
  event_id TEXT        NOT NULL REFERENCES events.event_log(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, event_id)
);

COMMENT ON TABLE events.event_group_members IS
  'Membership of events in a dedup/correlation group.';
