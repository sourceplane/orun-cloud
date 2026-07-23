-- 900_integrations_scope_templates: org-curated scope templates
-- (saas-secrets-platform SP4).
--
-- Context: integrations
-- Epic: saas-secrets-platform (SP4, design addendum SP-A6). Scope templates
--       are promoted from code-declared (SP0) to integration-MANAGED at
--       runtime: an org curates named templates in the provider's own space
--       and the substrate serves them through the SP0 capability read with no
--       console/db redeploy.
--
--       A custom template is a named derivation of a code-declared BASE
--       template: the base supplies the mint semantics (permission grammar,
--       custody kind, params, TTL ceiling) — the org supplies identity
--       (template_id), display name, and description. The mint path resolves
--       custom → base at issue time, so a custom template can never exceed
--       what its base grants (deny-by-default is preserved by construction).
--
--       Versioning (SP-A6): edits bump `version`; `status='retired'` hides a
--       template from create surfaces while existing bindings keep resolving
--       (soft-retire). There is no hard delete — retire is the only removal,
--       so a template can never be deleted out from under a live secret.

CREATE TABLE IF NOT EXISTS integrations.scope_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  provider      TEXT NOT NULL,
  -- The id bindings and create surfaces use (same grammar as code templates).
  template_id   TEXT NOT NULL,
  -- The code-declared template supplying mint semantics; custom ⊆ base.
  base_template TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  version       INT  NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE integrations.scope_templates
  DROP CONSTRAINT IF EXISTS scope_templates_status_check;
ALTER TABLE integrations.scope_templates
  ADD CONSTRAINT scope_templates_status_check
  CHECK (status IN ('active', 'retired'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_scope_templates_identity
  ON integrations.scope_templates (org_id, provider, template_id);

CREATE INDEX IF NOT EXISTS ix_integrations_scope_templates_org_provider
  ON integrations.scope_templates (org_id, provider, status);

COMMENT ON TABLE integrations.scope_templates IS
  'Org-curated scope templates (saas-secrets-platform SP4): named derivations '
  'of a code-declared base template. The base supplies mint semantics; the '
  'org supplies identity/display. Soft-retire only — no hard delete.';
