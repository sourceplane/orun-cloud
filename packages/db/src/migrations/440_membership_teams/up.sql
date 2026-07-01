-- 440_membership_teams: account-owned Teams as principals (saas-teams TM1).
--
-- Context: membership
-- Epic: saas-teams (TM1) — Teams are account-owned **principals**: named groups
--       of subjects a role can be granted to (à la GitHub org teams), NOT a
--       tenancy level and NOT a resource container. This migration adds the two
--       tables and widens role_assignments so a team can be an assignable
--       subject:
--
--         * membership.teams          — the team entity, owned by the ACCOUNT
--           (the parent org at parent_org_id, or the org itself if it is the
--           account root). A team is account-scoped so it can be granted across
--           every workspace under the account.
--         * membership.team_members   — who is in the team (users / service
--           principals), disambiguated by subject_type.
--         * role_assignments.subject_type gains 'team' — a team becomes a
--           grantable principal with subject_id = the team's public id
--           (team_<base32>). The policy engine stays agnostic; grants are
--           expanded into facts at authorization-context assembly (TM3).
--
-- Design rules (mirror 420_membership_account_rbac):
--   * Additive + idempotent throughout — IF NOT EXISTS for objects; the CHECK is
--     replaced via a guarded DROP-if-exists + ADD DO-block so a re-run never
--     errors and every existing row (user | service_principal) still validates.
--   * Account-scoped: teams.account_org_id references the account org; no FK,
--     consistent with the schema's opaque-id / no-cross-context-FK convention.
--   * Subject references are opaque ids (usr_/sp_ decoded to UUID text or the
--     public id), no FK to the identity context.

-- ── membership.teams ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership.teams (
  id              UUID        PRIMARY KEY,
  account_org_id  UUID        NOT NULL,
  name            TEXT        NOT NULL,
  slug_lower      TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT teams_status_check CHECK (status IN ('active', 'deleted'))
);

-- A team's slug is unique within its owning account (teams span workspaces, so
-- the account is the namespace). Deleted teams free their slug.
CREATE UNIQUE INDEX IF NOT EXISTS teams_account_slug_idx
  ON membership.teams (account_org_id, slug_lower)
  WHERE status <> 'deleted';

CREATE INDEX IF NOT EXISTS teams_account_org_id_idx
  ON membership.teams (account_org_id);

COMMENT ON TABLE membership.teams IS 'Account-owned Teams (saas-teams TM1): named principal-groups a role can be granted to. Not a tenancy level, not a resource container.';
COMMENT ON COLUMN membership.teams.account_org_id IS 'The owning account (parent org, or the org itself if it is the account root). A team is grantable across every workspace under this account.';
COMMENT ON COLUMN membership.teams.slug_lower IS 'Normalized (lower-case) slug for case-insensitive uniqueness within the account.';

-- ── membership.team_members ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership.team_members (
  team_id       UUID        NOT NULL,
  subject_id    TEXT        NOT NULL,
  subject_type  TEXT        NOT NULL DEFAULT 'user',
  status        TEXT        NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT team_members_status_check CHECK (status IN ('active', 'removed')),
  CONSTRAINT team_members_subject_type_check CHECK (subject_type IN ('user', 'service_principal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS team_members_team_subject_idx
  ON membership.team_members (team_id, subject_id);

CREATE INDEX IF NOT EXISTS team_members_subject_id_idx
  ON membership.team_members (subject_id);

CREATE INDEX IF NOT EXISTS team_members_team_id_idx
  ON membership.team_members (team_id);

COMMENT ON TABLE membership.team_members IS 'Team membership facts (saas-teams TM1): connects a subject (user | service_principal) to a team. Subject references are opaque ids, no FK.';

-- ── role_assignments.subject_type: add 'team' ───────────────────────
-- A team becomes an assignable principal; subject_id carries the team's public
-- id (team_<base32>). The subject_type column already disambiguates user vs
-- service_principal; we widen it to admit 'team' as well. Guarded DROP+ADD so a
-- re-run is a no-op and every existing row still validates.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'role_assignments_subject_type_check'
  ) THEN
    ALTER TABLE membership.role_assignments
      DROP CONSTRAINT role_assignments_subject_type_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'role_assignments_subject_type_check'
  ) THEN
    ALTER TABLE membership.role_assignments
      ADD CONSTRAINT role_assignments_subject_type_check
      CHECK (subject_type IN ('user', 'service_principal', 'team'));
  END IF;
END $$;

COMMENT ON COLUMN membership.role_assignments.subject_type IS
  'Subject kind (saas-teams TM2): ''user'', ''service_principal'', or ''team'' '
  '(subject_id = the team''s public id team_<base32>; expanded into the actor''s '
  'facts at authorization-context assembly, TM3).';
