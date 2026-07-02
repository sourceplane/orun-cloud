-- Email-scoped invitation discovery (saas invitation login flow).
--
-- The invitation-created email tells the recipient to "sign in with this email
-- address to view and accept the invitation" — no token link is delivered. That
-- flow needs a lookup of every pending invitation for a given email across all
-- organizations, keyed on email_lower alone.
--
-- The existing composite index `org_invitations_email_lower_idx (org_id,
-- email_lower)` cannot serve that query: its leading column is org_id, which the
-- /v1/me/invitations discovery path does not know. Add a standalone email_lower
-- index so the per-user lookup is index-backed instead of a full scan.
--
-- Additive + idempotent: creating an index changes no existing row and re-running
-- is a no-op (IF NOT EXISTS). Back-compatible with every prior migration.
CREATE INDEX IF NOT EXISTS org_invitations_email_lower_only_idx
  ON membership.organization_invitations (email_lower);
