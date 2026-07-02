-- 480_config_secret_deks: wrapped workspace data-encryption keys (SM2).
--
-- Context: config
-- Epic: saas-secret-manager (SM2, pairs orun-secrets SEC1 / SD-2′). The key
--       hierarchy behind the v:2 ciphertext envelope: each workspace (org)
--       gets a 32-byte data-encryption key (DEK), generation starting at 1,
--       stored here WRAPPED under the KEK (SECRET_KEK — a config-worker
--       secret binding; the Cloudflare Secrets Store binding is deferred to
--       saas-secrets-sync SS4). The KEK never lives in Postgres; unwrapped
--       DEK bytes exist only in Worker memory during an operation.
--
-- Design rules (see specs/epics/saas-secret-manager/implementation-plan.md, SM2):
--   * A v:2 envelope names its key as keyId "ws:<org-uuid>:<generation>";
--     (org_id, generation) is the primary key here — the cryptoshred/rotate unit.
--   * First write per workspace creates generation 1 via INSERT ... ON CONFLICT
--     DO NOTHING + re-SELECT (race-safe get-or-create in the repository).
--   * state: 'active' (serving new writes) -> 'retiring' (decrypt-only during
--     re-encryption) -> 'shredded' (wrapped bytes destroyed; cryptoshred).
--
-- Additive + idempotent (mirrors 430/470 guarded style).

CREATE TABLE IF NOT EXISTS config.secret_deks (
  org_id      UUID        NOT NULL,
  generation  INTEGER     NOT NULL CHECK (generation >= 1),
  wrapped_dek BYTEA       NOT NULL,
  state       TEXT        NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retiring', 'shredded')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, generation)
);

COMMENT ON TABLE config.secret_deks IS
  'Per-workspace data-encryption keys (saas-secret-manager SM2), stored WRAPPED '
  'under the KEK (AES-256-GCM). NEVER contains raw key material: wrapped_dek is '
  'the JSON wrap document {v, iv, ct}. The KEK lives in the config-worker '
  'SECRET_KEK binding, never in Postgres. A v:2 ciphertext envelope names its '
  'row via keyId ws:<org_id>:<generation>.';
COMMENT ON COLUMN config.secret_deks.org_id IS 'The workspace (organizations row) this DEK encrypts for. Opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.secret_deks.generation IS 'DEK generation (>= 1); bumped by rotation. Part of the envelope keyId.';
COMMENT ON COLUMN config.secret_deks.wrapped_dek IS 'DEK ciphertext wrapped under the KEK — JSON {v, iv, ct}, never raw bytes.';
COMMENT ON COLUMN config.secret_deks.state IS 'active (serving writes), retiring (decrypt-only), or shredded (cryptoshredded — wrapped bytes unusable).';
