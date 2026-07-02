-- 470_config_secret_manager: secret store v3 — append-only versions + chain scopes (SM1).
--
-- Context: config
-- Epic: saas-secret-manager (SM1, pairs orun-secrets SEC1). Turns the shipped
--       write-only secret storage into the v3 store: config.secret_versions keeps
--       an append-only ciphertext history (rotate stops overwriting in place), and
--       config.secret_metadata adopts the WID7 scope-resolution chain shape —
--       'account' scope_kind, overridable guardrails, personal overlays
--       (personal_owner, environment scope only) — plus the contract-promised
--       last_used_at stamp.
--
-- Design rules (see specs/epics/saas-secret-manager/implementation-plan.md, SM1):
--   * Chain: personal(environment, viewer) -> environment -> project ->
--     workspace(org) -> account -> default. Most specific present head wins.
--   * overridable BOOLEAN (default true): unlike settings (account-only locks,
--     430), a secret may be locked at account OR workspace(org) scope — a
--     deliberate v3 divergence so an org can pin org-wide credentials.
--   * personal_owner UUID (NULL = shared): a personal overlay row, visible to and
--     serving only its owner; environment scope only (CHECK).
--   * The scope-key unique index gains COALESCE(personal_owner, zero-uuid) so a
--     personal overlay coexists with the shared row for the same key.
--
-- Additive + idempotent throughout (mirrors 430_config_account_scope DO-block style).

-- ── secret_versions: append-only ciphertext history ─────────
CREATE TABLE IF NOT EXISTS config.secret_versions (
  secret_id           UUID        NOT NULL REFERENCES config.secret_metadata(id),
  version             INTEGER     NOT NULL CHECK (version >= 1),
  ciphertext_envelope BYTEA       NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by          UUID        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (secret_id, version)
);

COMMENT ON TABLE config.secret_versions IS
  'Append-only ciphertext version history per secret (saas-secret-manager SM1). '
  'NEVER contains plaintext. Rows are only ever appended (rotate) or marked '
  'revoked — the envelope of a past version is never overwritten. Read paths '
  'must never select ciphertext_envelope; only the SM3 resolve/reveal decrypt '
  'path may touch it.';
COMMENT ON COLUMN config.secret_versions.secret_id IS 'Owning config.secret_metadata row.';
COMMENT ON COLUMN config.secret_versions.version IS 'Version number, matches secret_metadata.version at append time (>= 1).';
COMMENT ON COLUMN config.secret_versions.ciphertext_envelope IS 'Encrypted secret payload for this version — NEVER plaintext.';
COMMENT ON COLUMN config.secret_versions.status IS 'active or revoked (a revoked version is kept for audit, never served).';
COMMENT ON COLUMN config.secret_versions.created_by IS 'User or service principal who wrote this version — opaque reference.';

-- Backfill: each existing head envelope becomes its current version.
-- ON CONFLICT DO NOTHING keeps the backfill idempotent on re-run.
INSERT INTO config.secret_versions (secret_id, version, ciphertext_envelope, status, created_by, created_at)
SELECT id,
       version,
       ciphertext_envelope,
       CASE WHEN status = 'revoked' THEN 'revoked' ELSE 'active' END,
       created_by,
       COALESCE(last_rotated_at, created_at)
FROM config.secret_metadata
WHERE ciphertext_envelope IS NOT NULL
ON CONFLICT (secret_id, version) DO NOTHING;

-- ── secret_metadata widening ─────────────────────────────────
ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS personal_owner UUID;

ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS overridable BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

COMMENT ON COLUMN config.secret_metadata.personal_owner IS
  'Personal-overlay owner (saas-secret-manager SM1). NULL = shared row. When set, '
  'this row is a per-user overlay: visible to and serving only this subject, and '
  'only at environment scope (CHECK). Opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.secret_metadata.overridable IS
  'Inheritance mode for the scope-resolution chain (saas-secret-manager SM1). '
  'true (default) = a more-specific scope may override this key. false = a locked '
  'guardrail a lower scope cannot override; writes that would override it are '
  'rejected. Secrets may be locked at account OR organization scope (unlike '
  'settings, which lock at account scope only — deliberate v3 divergence).';
COMMENT ON COLUMN config.secret_metadata.last_used_at IS
  'Stamped when a value is served by the resolve path (SM3). NULL until first use.';

-- ── scope_kind now admits 'account' ──────────────────────────
-- Guarded DROP-if-exists + ADD so the CHECK is replaced idempotently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'secret_metadata_scope_kind_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%account%'
  ) THEN
    ALTER TABLE config.secret_metadata DROP CONSTRAINT secret_metadata_scope_kind_check;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'secret_metadata_scope_kind_check'
  ) THEN
    ALTER TABLE config.secret_metadata
      ADD CONSTRAINT secret_metadata_scope_kind_check
      CHECK (scope_kind IN ('organization', 'project', 'environment', 'account'));
  END IF;
END $$;

-- ── only account- or organization-scope rows may be locked ───
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'secret_metadata_overridable_guard_check'
  ) THEN
    ALTER TABLE config.secret_metadata
      ADD CONSTRAINT secret_metadata_overridable_guard_check
      CHECK (overridable = true OR scope_kind IN ('account', 'organization'));
  END IF;
END $$;

-- ── personal overlays are environment-scope only ─────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'secret_metadata_personal_scope_check'
  ) THEN
    ALTER TABLE config.secret_metadata
      ADD CONSTRAINT secret_metadata_personal_scope_check
      CHECK (personal_owner IS NULL OR scope_kind = 'environment');
  END IF;
END $$;

-- ── scope-key uniqueness now keyed per personal owner ────────
-- Guarded: drop only the pre-v3 definition (no personal_owner in the key tuple),
-- then recreate. Re-running against the new index is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'config' AND indexname = 'secret_metadata_scope_key_idx'
      AND indexdef NOT LIKE '%personal_owner%'
  ) THEN
    DROP INDEX config.secret_metadata_scope_key_idx;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS secret_metadata_scope_key_idx
  ON config.secret_metadata (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), COALESCE(personal_owner, '00000000-0000-0000-0000-000000000000'), secret_key)
  WHERE status IN ('active', 'rotated');
