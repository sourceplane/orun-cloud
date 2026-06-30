-- 420_membership_account_rbac: account-scoped RBAC (saas-workspace-id WID6).
--
-- Context: membership
-- Epic: saas-workspace-id (WID6) — Stage 1a of the Account layer (design §8.2).
--       An admin portal means "administer workspaces I am not a member of",
--       which breaks today's invariant (the policy engine denies unless the
--       actor holds a role in the *specific* org). This migration widens
--       membership.role_assignments so a role can be granted at account scope
--       and cascade to every workspace under that account:
--
--         * scope_kind gains 'account' (joining 'organization' and 'project').
--           An account-scoped row lives on the ACCOUNT org (the parent at
--           parent_org_id IS NULL) and authorizes every workspace beneath it.
--         * role gains 'account_owner' / 'account_admin' /
--           'account_billing_admin' — account-wide authority (full owner set,
--           the admin set, and billing-only respectively).
--
--       The cascade itself is resolved in membership-worker's
--       authorization-context assembly (account facts are remapped onto the
--       target org id), NOT by the DB. This migration only widens the CHECK
--       constraints so the rows can exist.
--
-- Design rules (mirror 400_integrations_admission):
--   * Additive + idempotent throughout. Re-running is safe.
--   * Constraints are replaced via DROP-if-exists + ADD, each guarded by a
--     pg_constraint existence check so a re-run never errors.
--   * Back-compatible: every existing row is 'organization'/'project' with an
--     existing role, so the widened CHECK admits them unchanged.

-- ── scope_kind: add 'account' ───────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'role_assignments_scope_kind_check'
  ) THEN
    ALTER TABLE membership.role_assignments
      DROP CONSTRAINT role_assignments_scope_kind_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'role_assignments_scope_kind_check'
  ) THEN
    ALTER TABLE membership.role_assignments
      ADD CONSTRAINT role_assignments_scope_kind_check
      CHECK (scope_kind IN ('organization', 'project', 'account'));
  END IF;
END $$;

-- ── role: add the account roles ─────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'role_assignments_role_check'
  ) THEN
    ALTER TABLE membership.role_assignments
      DROP CONSTRAINT role_assignments_role_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'role_assignments_role_check'
  ) THEN
    ALTER TABLE membership.role_assignments
      ADD CONSTRAINT role_assignments_role_check
      CHECK (role IN (
        'owner', 'admin', 'builder', 'viewer', 'billing_admin',
        'project_admin', 'project_builder', 'project_viewer',
        'account_owner', 'account_admin', 'account_billing_admin'
      ));
  END IF;
END $$;

COMMENT ON COLUMN membership.role_assignments.scope_kind IS
  'Scope of the role assignment (saas-workspace-id WID6): ''organization'' '
  '(this org), ''project'' (a project within this org, scope_ref = project id), '
  'or ''account'' (held on the account/parent org; cascades to authority on '
  'every workspace under the account via the policy engine''s account-role '
  'permission catalog, remapped at authorization-context assembly).';
