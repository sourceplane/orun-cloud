-- 540_membership_team_roles: team-management roles (teams-foundation TF2).
--
-- Context: membership
-- Epic: teams-foundation (TF2) — a Team gains its OWN membership role so it can be
--       self-managed without an account admin for every roster change. This is the
--       *team-management* authority plane, deliberately distinct from the *platform*
--       roles a team is granted via role_assignments:
--
--         * team_admin  — may rename the team, edit its profile, and add/remove
--                         members (and change a member's team_role).
--         * team_member — a plain member; receives every role the team is granted
--                         but cannot manage the team object.
--
--       A team_admin curates the roster but CANNOT change what the team is granted
--       (that stays gated by the grantor's scope authority, saas-teams TM2) — so a
--       roster edit can never escalate the team's power. An account admin (WID6)
--       remains a superset over both planes.
--
-- Design rules (mirror 420_membership_account_rbac / 440_membership_teams):
--   * Additive + idempotent — ADD COLUMN IF NOT EXISTS with a DEFAULT so every
--     existing TM-era membership row backfills to 'team_member'.
--   * The CHECK is added via a guarded pg_constraint existence check so a re-run
--     never errors and every existing (backfilled) row validates.

ALTER TABLE membership.team_members
  ADD COLUMN IF NOT EXISTS team_role TEXT NOT NULL DEFAULT 'team_member';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'team_members_team_role_check'
  ) THEN
    ALTER TABLE membership.team_members
      ADD CONSTRAINT team_members_team_role_check
      CHECK (team_role IN ('team_admin', 'team_member'));
  END IF;
END $$;

COMMENT ON COLUMN membership.team_members.team_role IS
  'Team-management role (teams-foundation TF2): ''team_admin'' (manage the team object + roster) or ''team_member'' (plain member). Distinct from the platform roles the team is granted via role_assignments — a team_admin curates membership but never what the team can do.';
