-- 230_identity_cli_sessions: CLI session auth foundation (saas-orun-platform OP1).
--
-- Context: identity
-- Epic: saas-orun-platform (OP1 — CLI session auth). Extends the web-only
--       session model with a first-class `cli` session kind plus a rotating
--       refresh-token family, and adds the short-lived login-grant table that
--       backs the browser-loopback and RFC-8628 device flows. The platform owns
--       its own device flow (hard cut from GitHub's pre-GA device flow).
--
-- Design rules (see specs/epics/saas-orun-platform/design.md §3.1 and
-- state-api-contract.md §1):
--   * `identity.sessions` is web-only today (id, user_id, token_hash, expires_at,
--     revoked_at). This migration:
--       - adds `kind` ('web' | 'cli'); existing rows default to 'web'.
--       - adds a rotating-refresh family: refresh_token_hash + family columns
--         (refresh_family_id, refresh_generation, replaced_by) and revoked_reason.
--         Single-use rotation: the live generation holds the current refresh hash;
--         redeeming it mints the next generation and points `replaced_by` at it.
--         Presenting a superseded (already-rotated) refresh ⇒ family revoke.
--       - adds CLI provenance columns (host label, last_used_at already exists as
--         last_seen_at) for the console "Sessions & devices" surface.
--   * `identity.cli_login_grants` is the short-lived grant table for BOTH flows:
--       - loopback: a `cli_code` (hashed) the CLI redeems after console approval.
--       - device:   a `device_code` (hashed, machine-polled) + `user_code`
--         (hashed, human-entered at the console approval page).
--     A grant is single-use: status moves pending → approved → redeemed (or
--     denied/expired). On redeem it references the minted `identity.sessions` row.
--   * Identity context owns these tables; subject/org references are opaque
--     (no cross-context FK), mirroring 060_identity_api_keys. Only `session_id`
--     FKs stay inside identity.
--   * Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout for
--     Supabase autocommit safety.

-- ── Extend identity.sessions: kind + rotating-refresh family ──────────────────

ALTER TABLE identity.sessions
  ADD COLUMN IF NOT EXISTS kind               TEXT        NOT NULL DEFAULT 'web';

ALTER TABLE identity.sessions
  ADD COLUMN IF NOT EXISTS refresh_token_hash TEXT;

ALTER TABLE identity.sessions
  ADD COLUMN IF NOT EXISTS refresh_family_id  UUID;

ALTER TABLE identity.sessions
  ADD COLUMN IF NOT EXISTS refresh_generation INTEGER     NOT NULL DEFAULT 0;

ALTER TABLE identity.sessions
  ADD COLUMN IF NOT EXISTS replaced_by        UUID;

ALTER TABLE identity.sessions
  ADD COLUMN IF NOT EXISTS revoked_reason     TEXT;

ALTER TABLE identity.sessions
  ADD COLUMN IF NOT EXISTS client_host        TEXT;

ALTER TABLE identity.sessions
  ADD COLUMN IF NOT EXISTS refresh_expires_at TIMESTAMPTZ;

-- 'web' | 'cli'. Older rows are web sessions (covered by the column default).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_kind_check'
  ) THEN
    ALTER TABLE identity.sessions
      ADD CONSTRAINT sessions_kind_check CHECK (kind IN ('web', 'cli'));
  END IF;
END $$;

-- Refresh-token hash is the auth-time lookup key. Each generation keeps its own
-- (distinct, random) hash even after rotation/revoke so a replayed token still
-- resolves to its row and reuse is detectable (replaced_by/revoked_at gate
-- validity). Partial unique because web sessions carry NULL.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_refresh_token_hash_idx
  ON identity.sessions (refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;

-- Family revoke + reuse detection sweep across a token family.
CREATE INDEX IF NOT EXISTS sessions_refresh_family_idx
  ON identity.sessions (refresh_family_id)
  WHERE refresh_family_id IS NOT NULL;

-- "Sessions & devices" listing: a user's CLI sessions, newest first.
CREATE INDEX IF NOT EXISTS sessions_user_kind_idx
  ON identity.sessions (user_id, kind, created_at DESC);

COMMENT ON COLUMN identity.sessions.kind IS 'Session kind: web (console) or cli (Orun CLI). Older rows are web.';
COMMENT ON COLUMN identity.sessions.refresh_token_hash IS 'SHA-256 hash of this generation''s rotating refresh token (cli sessions). Kept after rotation/revoke so reuse is detectable; validity is gated by replaced_by/revoked_at.';
COMMENT ON COLUMN identity.sessions.refresh_family_id IS 'Token-family id shared across all rotations of one CLI login; reuse of a rotated token revokes the whole family.';
COMMENT ON COLUMN identity.sessions.refresh_generation IS 'Monotonic rotation counter within the family (0 for web sessions).';
COMMENT ON COLUMN identity.sessions.replaced_by IS 'When this session row was rotated, the id of the successor session row.';
COMMENT ON COLUMN identity.sessions.revoked_reason IS 'Why the session was revoked: logout | reuse_detected | console_revoke | superseded.';
COMMENT ON COLUMN identity.sessions.client_host IS 'Reported CLI host label (e.g. "macbook-pro") for the console device list.';
COMMENT ON COLUMN identity.sessions.refresh_expires_at IS 'Absolute refresh-token expiry (~30 days); independent of the short access-token expiry.';

-- ── CLI login grants (loopback + device flows, design §3.1) ───────────────────
-- Short-lived, single-use. Created by /v1/auth/cli/start (loopback) or
-- /v1/auth/cli/device/start (device). Hashed secrets only; raw codes live with
-- the CLI / are typed by the user. On redeem, `session_id` points at the minted
-- CLI session.

CREATE TABLE IF NOT EXISTS identity.cli_login_grants (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flow             TEXT        NOT NULL
                     CHECK (flow IN ('loopback', 'device')),
  -- loopback: the one-time cli_code the CLI redeems after approval.
  cli_code_hash    TEXT,
  -- device: machine-polled secret + human-entered short code.
  device_code_hash TEXT,
  user_code_hash   TEXT,
  -- Reported CLI host (display on the approval page).
  client_host      TEXT,
  status           TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'denied', 'redeemed', 'expired')),
  -- Set once a console-authenticated user approves the grant (opaque user id).
  approved_by      TEXT,
  approved_at      TIMESTAMPTZ,
  -- The CLI session minted on redeem (stays within identity context).
  session_id       UUID        REFERENCES identity.sessions(id),
  redeemed_at      TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A row is exactly one flow: loopback carries cli_code, device carries both
  -- device_code + user_code.
  CONSTRAINT cli_login_grants_flow_secrets_check CHECK (
    (flow = 'loopback' AND cli_code_hash IS NOT NULL
                       AND device_code_hash IS NULL AND user_code_hash IS NULL)
    OR
    (flow = 'device'   AND device_code_hash IS NOT NULL AND user_code_hash IS NOT NULL
                       AND cli_code_hash IS NULL)
  )
);

-- Single-use redeem lookups (loopback cli_code; device poll device_code; console
-- approval user_code). Partial uniques so a NULL secret never collides.
CREATE UNIQUE INDEX IF NOT EXISTS cli_login_grants_cli_code_idx
  ON identity.cli_login_grants (cli_code_hash)
  WHERE cli_code_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cli_login_grants_device_code_idx
  ON identity.cli_login_grants (device_code_hash)
  WHERE device_code_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cli_login_grants_user_code_idx
  ON identity.cli_login_grants (user_code_hash)
  WHERE user_code_hash IS NOT NULL;

-- GC sweep of expired/pending grants.
CREATE INDEX IF NOT EXISTS cli_login_grants_expires_idx
  ON identity.cli_login_grants (expires_at);

COMMENT ON TABLE identity.cli_login_grants IS 'Short-lived single-use CLI login grants for the browser-loopback and RFC-8628 device flows. Hashed secrets only.';
COMMENT ON COLUMN identity.cli_login_grants.flow IS 'loopback (browser 127.0.0.1) or device (headless RFC-8628).';
COMMENT ON COLUMN identity.cli_login_grants.cli_code_hash IS 'SHA-256 hash of the loopback one-time cli_code the CLI redeems after console approval.';
COMMENT ON COLUMN identity.cli_login_grants.device_code_hash IS 'SHA-256 hash of the device-flow machine-polled device_code.';
COMMENT ON COLUMN identity.cli_login_grants.user_code_hash IS 'SHA-256 hash of the device-flow short user_code the human enters at the console approval page.';
COMMENT ON COLUMN identity.cli_login_grants.approved_by IS 'Opaque id of the console-authenticated user who approved the grant.';
COMMENT ON COLUMN identity.cli_login_grants.session_id IS 'The identity.sessions row minted when the grant was redeemed.';
