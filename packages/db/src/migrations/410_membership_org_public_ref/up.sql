-- 410_membership_org_public_ref: durable public Workspace ID (WID2).
--
-- Context: membership
-- Epic: saas-workspace-id (WID2) — every organization gets a short, immutable,
--       public Workspace ID of the form `ws_<8 Crockford-base32>` (e.g.
--       `ws_3KF9TQ2P`), stored in a dedicated `public_ref` column. Unlike the
--       mutable `slug`, this handle is safe to commit, quote to support, and
--       paste into the CLI forever; unlike `org_<hex>` it is short and
--       non-overloaded. See specs/epics/saas-workspace-id/design.md §2–§3.
--
-- Design rules:
--   * Minted in the app's create-organization path (the single org-creation
--     transaction in apps/membership-worker) and ONLY there — the codec
--     `generateWorkspaceRef()` lives in packages/db/src/ids.
--   * The DB default below is a deploy-safety backstop, NOT the primary mint:
--     it backfills every existing row during the ADD COLUMN rewrite and protects
--     any stray insert that omits the value, so the column can be NOT NULL from
--     the first moment.
--   * Crockford base32 alphabet (uppercase, excludes I, L, O, U).
--
-- Additive + idempotent throughout.

-- Workspace-ref generator: 'ws_' + 8 random Crockford-base32 chars. VOLATILE so
-- the column default produces a fresh value per row (the ADD COLUMN rewrite
-- backfills existing rows, and any default-driven insert gets a distinct id).
CREATE OR REPLACE FUNCTION membership.gen_workspace_ref()
RETURNS TEXT
LANGUAGE sql
VOLATILE
AS $$
  SELECT 'ws_' || string_agg(
    substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1),
    ''
  )
  FROM generate_series(1, 8);
$$;

ALTER TABLE membership.organizations
  ADD COLUMN IF NOT EXISTS public_ref TEXT NOT NULL DEFAULT membership.gen_workspace_ref();

CREATE UNIQUE INDEX IF NOT EXISTS organizations_public_ref_idx
  ON membership.organizations (public_ref);

COMMENT ON COLUMN membership.organizations.public_ref IS
  'Immutable public Workspace ID (saas-workspace-id WID2): ws_<8 Crockford-base32>, '
  'e.g. ws_3KF9TQ2P. Minted once at organization creation, never reissued — safe to '
  'commit, quote, and paste forever (unlike the mutable slug). The column default is a '
  'deploy-safety backstop; the canonical mint is the create-organization handler.';
