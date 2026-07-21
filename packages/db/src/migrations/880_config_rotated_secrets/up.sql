-- 880_config_rotated_secrets: provider-rotation producer binding (RS0).
--
-- Context: config
-- Epic: saas-integration-hub / sub-epics/provider-rotated-secrets (RS0). A
--       secret can be an ordinary `source = 'static'` stored ciphertext whose
--       ROTATION is produced by the integrations credential broker: on the SM6
--       rotation schedule the engine (RS2) mints a fresh scoped provider token
--       from a connected parent and appends it as a new version. This is the
--       proven, stored-and-rotated sibling of IH7's dynamic `brokered` model —
--       and unlike brokered it resolves exactly like any static secret (the
--       decrypt path is untouched) and can serve long-lived consumers.
--
--       What this migration adds is the ROTATION PRODUCER binding: how to mint
--       the next value (provider + connection + template + params), an optional
--       grace overlap, and an optional delivery target for consumers that HOLD
--       the value (RS2's re-deliver step, reusing the runner materialize path).
--       The WHEN of rotation stays on the shipped SM6 columns (rotation_policy,
--       expires_at, last_rotated_at) — this only adds the WHAT/HOW.
--
-- Guard rails (named ADD CONSTRAINTs — the 720 lesson; brokered's 820 style):
--   * The producer core is all-or-nothing: rotation_provider is present IFF
--     rotation_connection_id AND rotation_template are present. params, grace,
--     and deliver_target are optional adjuncts.
--   * A provider-rotated secret must be `source = 'static'`: a brokered secret
--     stores no value, so there is nothing to rotate in place. Rotation and
--     brokered are mutually exclusive.
--   * grace seconds, when present, is non-negative.
--
-- Additive + idempotent as a unit.

-- ── secret_metadata: provider-rotation producer binding ──────
ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS rotation_provider text;

ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS rotation_connection_id uuid;

ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS rotation_template text;

ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS rotation_params jsonb;

ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS rotation_grace_seconds integer;

ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS rotation_deliver_target text;

COMMENT ON COLUMN config.secret_metadata.rotation_provider IS
  'Provider-rotation producer (RS0): integration provider slug (e.g. cloudflare) '
  'the next value is minted from on the SM6 rotation schedule. NULL = not '
  'provider-rotated (a plain static or brokered secret). Present IFF '
  'rotation_connection_id and rotation_template are present.';
COMMENT ON COLUMN config.secret_metadata.rotation_connection_id IS
  'Provider-rotation producer (RS0): raw uuid of the integrations connection the '
  'next value is minted against. Opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.secret_metadata.rotation_template IS
  'Provider-rotation producer (RS0): credential broker scope template (e.g. '
  'workers-deploy) the minted token is scoped by.';
COMMENT ON COLUMN config.secret_metadata.rotation_params IS
  'Provider-rotation producer (RS0): optional JSON params for the template mint '
  '(e.g. zoneIds for a dns template). NULL when the template takes no params.';
COMMENT ON COLUMN config.secret_metadata.rotation_grace_seconds IS
  'Provider-rotation producer (RS0): overlap window (seconds) during which the '
  'prior minted token stays valid after a rotation before it is revoked, so '
  'in-flight work and not-yet-redeployed consumers keep working. NULL = engine '
  'default (RS-D2).';
COMMENT ON COLUMN config.secret_metadata.rotation_deliver_target IS
  'Provider-rotation producer (RS0): optional materialize target (e.g. '
  'cloudflare-worker:script-name) the rotated value is re-delivered into for '
  'long-lived consumers that HOLD the value (RS2 re-deliver, reusing the runner '
  'materialize path). NULL = resolve-per-run consumers only; no delivery.';

-- ── producer core is all-or-nothing ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'secret_metadata_rotation_binding_guard_check'
  ) THEN
    ALTER TABLE config.secret_metadata
      ADD CONSTRAINT secret_metadata_rotation_binding_guard_check
      CHECK ((rotation_provider IS NOT NULL) = (rotation_connection_id IS NOT NULL AND rotation_template IS NOT NULL));
  END IF;
END $$;

-- ── a provider-rotated secret must be static (nothing to rotate if brokered) ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'secret_metadata_rotation_static_check'
  ) THEN
    ALTER TABLE config.secret_metadata
      ADD CONSTRAINT secret_metadata_rotation_static_check
      CHECK (rotation_provider IS NULL OR source = 'static');
  END IF;
END $$;

-- ── grace seconds is non-negative when present ───────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'secret_metadata_rotation_grace_check'
  ) THEN
    ALTER TABLE config.secret_metadata
      ADD CONSTRAINT secret_metadata_rotation_grace_check
      CHECK (rotation_grace_seconds IS NULL OR rotation_grace_seconds >= 0);
  END IF;
END $$;

-- ── the RS2 engine scans provider-rotated secrets per org ────
CREATE INDEX IF NOT EXISTS secret_metadata_rotation_provider_idx
  ON config.secret_metadata (org_id)
  WHERE rotation_provider IS NOT NULL;
