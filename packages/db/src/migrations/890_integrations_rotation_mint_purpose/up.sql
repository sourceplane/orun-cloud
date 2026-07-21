-- 890_integrations_rotation_mint_purpose: 'rotation' joins the mint-purpose
-- enum (provider-rotated-secrets RS1).
--
-- Context: integrations
-- Epic: saas-integration-hub / sub-epics/provider-rotated-secrets (RS1). A
--       provider-rotated secret (880) stores its value as an ordinary static
--       ciphertext and re-mints it from a connected parent credential — at
--       create (RS1's one deliberate mint stored as v1) and on the SM6
--       schedule (the RS2 engine). Those mints are ledgered like every other
--       broker issuance, but they are neither a user-facing 'api' mint nor a
--       lease-bound 'secret_resolve': they carry no run/job attribution and
--       their TTL is the rotation interval semantics, not a resolve TTL.
--       'rotation' names them so the ledger, the IH9 orphan sweep, and the
--       SI3/SI5 deprecation metrics can tell the three apart.
--
-- Guarded CHECK swap (the 720 lesson: inline column CHECKs are auto-named
-- {table}_{column}_check); idempotent as a unit. Purely widening — every
-- existing row ('api', 'secret_resolve') stays valid.

ALTER TABLE integrations.minted_credentials
  DROP CONSTRAINT IF EXISTS minted_credentials_purpose_check;
ALTER TABLE integrations.minted_credentials
  ADD CONSTRAINT minted_credentials_purpose_check
  CHECK (purpose IN ('api', 'secret_resolve', 'rotation'));

COMMENT ON COLUMN integrations.minted_credentials.purpose IS
  'Why the credential was minted: api (user/service-principal mint via the '
  'public broker route), secret_resolve (lease-bound brokered-secret resolve, '
  'IH7), or rotation (a provider-rotated secret''s stored value being produced '
  'at create or by the rotation engine, provider-rotated-secrets RS1/RS2).';
