-- 710_work_v4_snapshots: sealed epic briefs (orun-work-v4 WH4).
--
-- Context: work
-- Epic: orun-work v4 (specs/epics/orun-work-v4/) — additive over 700.
--
-- Approval seals (design §3): the approve mutator freezes the epic's INTENT
-- (envelope + milestone ladder + ladderHash + task contracts + log cursors)
-- into a canonical, content-addressed EpicSnapshot IN THE SAME TRANSACTION
-- as the `approved` event, and stamps the snapshot id into the event's
-- payload. This table is the content-addressed store for those canonical
-- bytes — append-only, keyed by digest, exactly like work.doc_revisions is
-- for document bodies. `orun epic pull` fetches the bytes and verifies
-- sha256(body) == id — the approval IS the dispatch artifact.
--
-- NO STORED FACT: a snapshot is intent-plane content by type (no rung, no
-- assignee, no pin can appear in it — asserted at seal time); this is
-- content storage, not state.

CREATE TABLE IF NOT EXISTS work.snapshots (
  org_id      UUID NOT NULL,
  id          TEXT NOT NULL,                 -- 'sha256:<hex>' of body
  kind        TEXT NOT NULL DEFAULT 'EpicSnapshot',
  subject     TEXT NOT NULL,                 -- the epic key
  body        TEXT NOT NULL,                 -- canonical JSON bytes (what the id hashes)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_work_snapshots_subject
  ON work.snapshots (org_id, subject, created_at);
