-- 820_config_brokered_secrets: brokered-secret metadata discriminator (IH7).
--
-- Context: config
-- Epic: saas-integration-hub (IH7) — a secret can be created with kind
--       'brokered': instead of a stored ciphertext its value is minted
--       just-in-time from the integrations credential broker at resolve. The
--       binding POINTER (connectionId/template/params) rides the existing
--       version envelope (config.secret_versions.ciphertext_envelope, as JSON
--       {"v":"brokered","provider":{...}}) — no schema change needed there.
--       What this migration adds is the metadata-level discriminator plus
--       display-only binding facts, so list/chain reads can render broker
--       provenance ("brokered · cloudflare · workers-deploy") without ever
--       touching the envelope.
--
-- Guard rails:
--   * source ∈ ('static', 'brokered'); every pre-existing row is 'static'.
--   * Binding facts are all-or-nothing WITH the discriminator: a brokered row
--     carries all three, a static row carries none.
--   * A personal overlay (personal_owner set, SM1) can never be brokered —
--     broker authority is bound at shared scopes only.
--
-- Named ADD CONSTRAINTs throughout (the 720 lesson: inline CHECKs get
-- auto-names we don't want); additive + idempotent as a unit.

-- ── secret_metadata: discriminator + display-only binding facts ──
ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'static';

ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS binding_provider text;

ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS binding_connection_id uuid;

ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS binding_template text;

COMMENT ON COLUMN config.secret_metadata.source IS
  'Value provenance discriminator (saas-integration-hub IH7). static (default) = '
  'the value is a stored ciphertext version. brokered = no stored value; the head '
  'envelope is a binding pointer and the value is minted just-in-time from the '
  'integrations credential broker at resolve.';
COMMENT ON COLUMN config.secret_metadata.binding_provider IS
  'Display-only broker binding fact (IH7): provider slug (e.g. cloudflare) for '
  'list/chain rendering. Authoritative binding lives in the version envelope.';
COMMENT ON COLUMN config.secret_metadata.binding_connection_id IS
  'Display-only broker binding fact (IH7): raw uuid of the integrations '
  'connection the value is minted against. Opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.secret_metadata.binding_template IS
  'Display-only broker binding fact (IH7): credential template name (e.g. '
  'workers-deploy) for list/chain rendering.';

-- ── source is a closed enum ──────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'secret_metadata_source_check'
  ) THEN
    ALTER TABLE config.secret_metadata
      ADD CONSTRAINT secret_metadata_source_check
      CHECK (source IN ('static', 'brokered'));
  END IF;
END $$;

-- ── binding facts are all-or-nothing with the discriminator ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'secret_metadata_binding_guard_check'
  ) THEN
    ALTER TABLE config.secret_metadata
      ADD CONSTRAINT secret_metadata_binding_guard_check
      CHECK ((source = 'brokered') = (binding_provider IS NOT NULL AND binding_connection_id IS NOT NULL AND binding_template IS NOT NULL));
  END IF;
END $$;

-- ── a personal overlay can never be brokered ─────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'secret_metadata_brokered_personal_check'
  ) THEN
    ALTER TABLE config.secret_metadata
      ADD CONSTRAINT secret_metadata_brokered_personal_check
      CHECK (source = 'static' OR personal_owner IS NULL);
  END IF;
END $$;

-- ── entitlement gate: count live brokered bindings per org ───
CREATE INDEX IF NOT EXISTS secret_metadata_brokered_org_idx
  ON config.secret_metadata (org_id)
  WHERE source = 'brokered';
