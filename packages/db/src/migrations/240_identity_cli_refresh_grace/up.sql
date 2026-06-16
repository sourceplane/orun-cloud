-- 240_identity_cli_refresh_grace (saas-orun-platform OP1 hardening — risk R11).
--
-- Reuse-grace interval for the rotating CLI refresh-token family (Option A).
--
-- Rotating refresh tokens are single-use: presenting an already-rotated token is
-- treated as reuse (RFC-9700) and revokes the WHOLE family. That is correct for
-- a genuine replay, but it also fires on benign races the client cannot prevent —
-- a lost rotation response that the client retries with its (now-spent) token, or
-- two near-simultaneous redemptions of the same token. Those spuriously revoked
-- active sessions ("the token expires instantly").
--
-- The grace interval makes a replay of a JUST-rotated token, within a short
-- window, IDEMPOTENT: the predecessor row keeps an encrypted copy of the
-- successor refresh token plus a grace deadline, and the replay is re-issued the
-- SAME successor instead of revoking the family. A replay after the window — or
-- of a row revoked for any reason other than the normal 'superseded' rotation —
-- still revokes.
--
--   grace_successor_ciphertext : AES-256-GCM envelope (JSON) of the successor
--     refresh token. The key is held by the worker (derived from a worker
--     secret), never stored in the database, so a DB dump alone cannot read it.
--     Only honored while grace_expires_at is in the future; NULL when the grace
--     feature is disabled (no key configured).
--   grace_expires_at           : end of the grace window for this rotation.

ALTER TABLE identity.sessions
  ADD COLUMN IF NOT EXISTS grace_successor_ciphertext TEXT;

ALTER TABLE identity.sessions
  ADD COLUMN IF NOT EXISTS grace_expires_at TIMESTAMPTZ;
