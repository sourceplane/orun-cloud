-- 550_membership_team_owner_handles: owner-handle → team resolver map
-- (teams-ownership TO1).
--
-- Context: membership
-- Epic: teams-ownership (TO1) — bind a catalog entity's git-authored `owner`
--       string to a Team entity WITHOUT writing catalog content. The catalog
--       read-model (state.org_catalog_entities) is derived-never-authored
--       (specs/components/18-state.md): the console may never write it. But it
--       MAY own a mapping from a git owner handle to a team_ id — that map is
--       ORG METADATA, not catalog content, so the invariant holds and the
--       projection is never touched (Backstage's group:team → entity-ref model).
--
--         * membership.team_owner_handles — account-authored alias map:
--             owner_handle (the string as it appears in git `owner:`) → team_id
--             (the team's public id, team_<hex>). Account-scoped and
--             account-unique (case-insensitive), so one handle resolves to at
--             most one team account-wide (consistent across every workspace).
--
--       By default `owner_handle` == the team's handle (TF1), so most teams need
--       NO row here — resolution first tries `owner == teams.handle` and this
--       table only captures ALIASES (legacy strings, `group:payments` forms,
--       renames, several strings pointing at one team). Read-time resolution
--       (TO2) never denormalizes a team_id onto the catalog projection.
--
-- Design rules (mirror 440_membership_teams / 530/540):
--   * Additive + idempotent — CREATE TABLE / INDEX IF NOT EXISTS.
--   * team_id is an opaque public id (team_<hex>) text, no FK (schema convention).

CREATE TABLE IF NOT EXISTS membership.team_owner_handles (
  account_org_id  UUID        NOT NULL,
  owner_handle    TEXT        NOT NULL,
  team_id         TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One owner handle maps to at most one team per account (case-insensitive).
-- The upsert path keys on this index (last-writer-wins, audited in the worker).
CREATE UNIQUE INDEX IF NOT EXISTS team_owner_handles_account_handle_idx
  ON membership.team_owner_handles (account_org_id, lower(owner_handle));

-- Reverse lookup: every alias pointing at a team (TO5 coverage / cleanup on
-- team delete).
CREATE INDEX IF NOT EXISTS team_owner_handles_team_id_idx
  ON membership.team_owner_handles (team_id);

COMMENT ON TABLE membership.team_owner_handles IS
  'Account-authored owner-handle → team_ alias map (teams-ownership TO1): resolves a git-authored catalog `owner:` string to a team entity at read time. ORG METADATA, not catalog content — the state.org_catalog_entities projection is never written (18-state intact). Most teams resolve by owner==handle and need no row here; this captures aliases only.';
COMMENT ON COLUMN membership.team_owner_handles.owner_handle IS
  'The owner string as authored in git (e.g. ''payments'' or a legacy alias), matched case-insensitively.';
COMMENT ON COLUMN membership.team_owner_handles.team_id IS
  'The team''s immutable public id (team_<hex>) the handle resolves to.';
