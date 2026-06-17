-- 270_state_link_ci_settings: per-link CI trust settings (OV3).
--
-- Context: state
-- Epic: saas-orun-platform v2 (OV3 — credential-agnostic CI auth). The
--       workspace_link IS the CI trust binding (design-v2 §4): once an
--       authorized org member links a repo, CI from that repo resolves to the
--       link's (org, project). These columns let the binding be tightened
--       per-link without a separate oidc_trust_bindings table (DV4 drops it).
--
--       The OIDC exchange (POST /v1/auth/oidc/exchange) and the sk_ API-key
--       path both gate on these settings: which auth methods are allowed, and
--       (for OIDC) which refs/environments may mint a workflow token.
--
-- Additive ONLY: every column has a safe default (both methods enabled; null
-- ref-pattern / null environments = "all", i.e. the link's trust is the gate).
-- Tightening is opt-in via the console; the permissive default preserves the
-- "the link is the trust binding" semantics.

-- Which CI credential methods this link accepts.
ALTER TABLE state.workspace_links ADD COLUMN IF NOT EXISTS oidc_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE state.workspace_links ADD COLUMN IF NOT EXISTS api_key_enabled BOOLEAN NOT NULL DEFAULT true;

-- Optional OIDC tightening. allowed_ref_pattern is a glob/prefix over the GitHub
-- Actions `ref` claim (e.g. 'refs/heads/main', 'refs/heads/*'); NULL = any ref.
-- allowed_environments is a JSON array of environment names; NULL = any env.
ALTER TABLE state.workspace_links ADD COLUMN IF NOT EXISTS allowed_ref_pattern TEXT;
ALTER TABLE state.workspace_links ADD COLUMN IF NOT EXISTS allowed_environments JSONB;

COMMENT ON COLUMN state.workspace_links.allowed_ref_pattern IS 'OIDC gate: glob over the Actions ref claim; NULL = any ref (the link itself is the trust binding).';
COMMENT ON COLUMN state.workspace_links.allowed_environments IS 'OIDC gate: JSON array of allowed environment names; NULL = any environment.';
