-- 430_config_account_scope: account-level config scope + overridable guardrail (WID7).
--
-- Context: config
-- Epic: saas-workspace-id (WID7) — the scope-resolution chain. Generalizes the
--       existing config nesting (organization/project/environment) with a new
--       'account' rung so a value set at the account is inherited by every
--       workspace under it (resolve-up at read time; the account stays the single
--       source of truth).
--
-- Design rules (see specs/epics/saas-workspace-id/design.md §8.1):
--   * Chain: environment -> project -> workspace(org) -> account -> default.
--     Most specific present value wins; fall back upward.
--   * overridable BOOLEAN (default true): a workspace value overrides an account
--     value UNLESS the account value is overridable=false (a guardrail / SCP-style
--     locked ceiling), in which case writes that would override it are rejected.
--   * Only an 'account'-scope row may be locked (overridable=false); all other
--     rungs are always overridable=true.
--   * Piloted on config.settings; feature_flags / secret_metadata can adopt the
--     same columns + resolver later (deferred follow-up).
--
-- Additive + idempotent throughout (mirrors 400_integrations_admission DO-block style).

-- ── overridable flag ────────────────────────────────────────
ALTER TABLE config.settings
  ADD COLUMN IF NOT EXISTS overridable BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN config.settings.overridable IS
  'Inheritance mode for the scope-resolution chain (saas-workspace-id WID7). '
  'true (default) = a more-specific scope may override this value. false = a '
  'locked account-scope guardrail (SCP-style ceiling) a workspace cannot override; '
  'writes that would override it are rejected. Only account-scope rows may be locked.';

-- ── scope_kind now admits 'account' ─────────────────────────
-- Guarded DROP-if-exists + ADD so the CHECK is replaced idempotently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settings_scope_kind_check'
  ) THEN
    ALTER TABLE config.settings DROP CONSTRAINT settings_scope_kind_check;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settings_scope_kind_check'
  ) THEN
    ALTER TABLE config.settings
      ADD CONSTRAINT settings_scope_kind_check
      CHECK (scope_kind IN ('organization', 'project', 'environment', 'account'));
  END IF;
END $$;

-- ── only account-scope rows may be locked ───────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settings_overridable_guard_check'
  ) THEN
    ALTER TABLE config.settings
      ADD CONSTRAINT settings_overridable_guard_check
      CHECK (overridable = true OR scope_kind = 'account');
  END IF;
END $$;
