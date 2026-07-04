-- 530_membership_teams_foundation: promote a Team into a first-class entity
-- (teams-foundation TF1).
--
-- Context: membership
-- Epic: teams-foundation (TF1) — `saas-teams` (TM1) gave a team just enough to be
--       a grantable principal: (id, account_org_id, name, slug_lower, status).
--       TF makes the team a thing the product can *point at* — a mentionable
--       handle and a profile — so ownership (TO), the team page (TH), and
--       mentions (TC) have something real to bind to. This migration is purely
--       additive over 440_membership_teams:
--
--         * membership.teams.handle       — a short, account-unique, mentionable
--           key (e.g. 'payments' → @payments). Nullable so every TM-era team
--           stays valid; set/renamed via the team-profile CRUD. Grants and every
--           cross-surface reference bind to the immutable team_<hex> public id,
--           NEVER the handle, so a rename never rewrites a grant (TF3).
--         * membership.teams.description  — free-text profile blurb.
--         * membership.teams.avatar_ref   — opaque avatar reference; NULL falls
--           back to deterministic initials+colour rendered client-side (TF-D).
--
-- Design rules (mirror 420_membership_account_rbac / 440_membership_teams):
--   * Additive + idempotent throughout — IF NOT EXISTS for every object, so a
--     re-run is a no-op and every existing team row stays valid (handle NULL).
--   * Account-scoped uniqueness: a handle is unique per ACCOUNT (teams span
--     workspaces, so the account is the namespace), case-insensitive, and only
--     among live teams — a deleted team frees its handle (mirrors the slug idx).

-- ── membership.teams: handle + profile columns ──────────────────────
ALTER TABLE membership.teams
  ADD COLUMN IF NOT EXISTS handle       TEXT,
  ADD COLUMN IF NOT EXISTS description  TEXT,
  ADD COLUMN IF NOT EXISTS avatar_ref   TEXT;

-- Account-unique, case-insensitive handle among live teams. Partial (handle IS
-- NOT NULL) so the many TM-era handle-less rows don't collide on NULL, and
-- (status <> 'deleted') so a deleted team frees its handle — exactly the
-- teams_account_slug_idx shape.
CREATE UNIQUE INDEX IF NOT EXISTS teams_account_handle_idx
  ON membership.teams (account_org_id, lower(handle))
  WHERE handle IS NOT NULL AND status <> 'deleted';

COMMENT ON COLUMN membership.teams.handle IS
  'Account-unique, case-insensitive, mentionable key (teams-foundation TF1), e.g. ''payments'' → @payments. Nullable (TM-era teams have none). Grants/owner-maps/routing bind to the immutable team_<hex> id, never this mutable handle.';
COMMENT ON COLUMN membership.teams.description IS
  'Free-text team profile blurb (teams-foundation TF1).';
COMMENT ON COLUMN membership.teams.avatar_ref IS
  'Opaque avatar reference (teams-foundation TF1); NULL renders deterministic initials+colour client-side.';
