import type { MigrationManifest } from "./types.js";

export const manifest: MigrationManifest = {
  version: 1,
  migrations: [
    {
      id: "000_control_baseline",
      context: "control",
      path: "000_control/up.sql",
      checksum:
        "2a5d7f30684c99e3ff441ca8a2c38038dedd1bab4db4a40e92cd36bb22be297f",
      description:
        "Baseline control migration — creates the migration tracking schema",
    },
    {
      id: "010_identity_core",
      context: "identity",
      path: "010_identity_core/up.sql",
      checksum:
        "f8db63c83e2b1b29e6d0b9b133a7db490e2adcfdf26bfc6ce55c63c8a629075d",
      description:
        "Identity persistence foundation — users, auth identities, login challenges, sessions",
    },
    {
      id: "020_membership_core",
      context: "membership",
      path: "020_membership_core/up.sql",
      checksum:
        "50da482998db74431866aa5285737026239a28618017019320ee7bb20e49381d",
      description:
        "Membership persistence foundation — organizations, members, invitations, role assignments",
    },
    {
      id: "030_events_audit_core",
      context: "events",
      path: "030_events_audit_core/up.sql",
      checksum:
        "388aa634380200595ff3a3d15c638e696bf9b93e46330327e84ef10cec8a3f58",
      description:
        "Events/audit persistence foundation — canonical event log and audit entry projections",
    },
    {
      id: "040_projects_core",
      context: "projects",
      path: "040_projects_core/up.sql",
      checksum:
        "d7cb842130856986157629965fd9afba6b36e737e73b125884b64976d2f8b7f6",
      description:
        "Projects persistence foundation — projects and environments tables with tenant isolation",
    },
    {
      id: "050_identity_security_events",
      context: "identity",
      path: "050_identity_security_events/up.sql",
      checksum:
        "a1bb9f50075ea93e389feb7c7282bdbd5b5ebf6671f789b0f7a707110ae74ca2",
      description:
        "Identity-owned security-event source facts — pre-organization user activity log",
    },
    {
      id: "060_identity_api_keys",
      context: "identity",
      path: "060_identity_api_keys/up.sql",
      checksum:
        "834e71e40f729cdf1cd4db32a4071b62c09fd63c9ea4bbf0c035c15c94ff99a1",
      description:
        "Identity-owned service principals and API keys — org-bound automation actors and credential persistence",
    },
    {
      id: "070_config_settings_flags",
      context: "config",
      path: "070_config_settings_flags/up.sql",
      checksum:
        "be2b60f0ddb6f342a8c9038db602e142a34d36ffa7f7a17f4d218231087d6562",
      description:
        "Config persistence foundation — scoped settings, feature flags, and secret metadata",
    },
    {
      id: "080_webhooks_core",
      context: "webhooks",
      path: "080_webhooks_core/up.sql",
      checksum:
        "bfffc592f82028dd06865833bfd5e8124dbfe51e2e02aecccea4b14b42e9f2a6",
      description:
        "Webhook persistence foundation — endpoints, subscriptions, and delivery attempts",
    },
    {
      id: "090_webhooks_delivery",
      context: "webhooks",
      path: "090_webhooks_delivery/up.sql",
      checksum:
        "a881356b376afd2cccbf326a9bfb7e393e073cd88b3923a38d34907457c39021",
      description:
        "Webhook delivery runtime — fixes event_id type, adds dispatch cursor and delivery indexes",
    },
    {
      id: "100_metering_foundation",
      context: "metering",
      path: "100_metering_foundation/up.sql",
      checksum:
        "d02693e6ec3d76193d58b9038a211c877adbf1c141e4f40d9ca8bb7a78c90930",
      description:
        "Metering persistence foundation — usage records, rollups, quota definitions, and quota violations",
    },
    {
      id: "110_billing_foundation",
      context: "billing",
      path: "110_billing_foundation/up.sql",
      checksum:
        "980564a806e89c0039f012f7c0ec49267920aea549b394c5af3712722e4b9f8f",
      description:
        "Billing persistence foundation — provider-neutral plans, billing customers, subscriptions, invoices, and entitlements",
    },
    {
      id: "120_notifications_core",
      context: "notifications",
      path: "120_notifications_core/up.sql",
      checksum:
        "868cc1092b4b385b6ed3d203efe5302191865131bb98d0e9f5fe5ad6d16f01bb",
      description:
        "Notifications persistence foundation — preferences, notifications, attempts, suppressions",
    },
    {
      id: "130_webhook_secret_rotation_grace",
      context: "webhooks",
      path: "130_webhook_secret_rotation_grace/up.sql",
      checksum:
        "4c5474e7b5ca228adc18ca09b7cd2387938efab8f1e55b675fd4aee6e3ec4e5a",
      description:
        "Dual-secret rotation window — adds previous_secret_{ciphertext,version,expires_at} for grace-period delivery signing",
    },
    {
      id: "140_support_action_records",
      context: "support",
      path: "140_support_action_records/up.sql",
      checksum:
        "50262de186b5ec91797e25532b56cf69028f3975dcc58751c07de6ef1517f190",
      description:
        "Support persistence foundation — append-only audited support-action ledger owned by the admin-support worker",
    },
    {
      id: "150_entitlement_decision_observations",
      context: "billing",
      path: "150_entitlement_decision_observations/up.sql",
      checksum:
        "ba7a1a00ad723752e1bdedc8bcd47c210b24ae18bd3245cb71af84432aefa7f8",
      description:
        "Entitlement-decision observability — append-only, counts-only observation table (org × entitlement key × outcome) owned by the billing context",
    },
    {
      id: "160_identity_user_last_org",
      context: "identity",
      path: "160_identity_user_last_org/up.sql",
      checksum:
        "d102ce426114b032407f6e03ee2e02de65ccb25e4f42df25b340e5a641829dc6",
      description:
        "Per-user last-viewed organization preference (nullable slug hint on identity.users) backing the console's cross-device default landing",
    },
    {
      id: "170_membership_org_parent",
      context: "membership",
      path: "170_membership_org_parent/up.sql",
      checksum:
        "8af612994d6ad4f76e416ec034cdcfc9e2e416bed04c4fde405481627b4093b2",
      description:
        "Optional parent-organization pointer (nullable parent_org_id on membership.organizations) — the dormant seam for the saas-multi-org-billing epic; NULL = standalone, no behavior change",
    },
    {
      id: "180_integrations_foundation",
      context: "integrations",
      path: "180_integrations_foundation/up.sql",
      checksum:
        "e86ac972013587fcd3b04be5c1daa1306a456990ebbb9d30e9b5d79770772497",
      description:
        "Integrations persistence foundation (IG0, dormant) — provider-agnostic connections, GitHub installation facts, repo links with branch→environment maps, the durable inbound-delivery inbox, and the encrypted installation-token cache",
    },
    {
      id: "190_integrations_delivery_attribution",
      context: "integrations",
      path: "190_integrations_delivery_attribution/up.sql",
      checksum:
        "535487194c9c4a129e013282a5f51a5c3e6e2afb3f15c5a0b5f1028e0c5af73f",
      description:
        "Connection pointer on the inbound-delivery inbox (nullable connection_id + partial index) — lets the per-connection delivery log scope precisely; attributed by the IG2 cron drain",
    },
    {
      id: "200_work_foundation",
      context: "work",
      path: "200_work_foundation/up.sql",
      checksum:
        "4dc27f6bea3b2fa04d6733e518d9602379839f44194b91c8595152ddb8491d97",
      description:
        "Work-plane persistence foundation (orun-work W0) — event-sourced Initiatives/Epics/Tasks: items, the append-only events log, typed relation links, the rebuildable status projection, sync cursors, and the per-project sequence allocator (the Postgres equivalent of the spec's Durable Object)",
    },
    {
      id: "210_resources_runtime_foundation",
      context: "resources",
      path: "210_resources_runtime_foundation/up.sql",
      checksum:
        "ef116af683d67dee6f023f243b4bbb3805bf1be0c33933bddaa49925c148da78",
      description:
        "Resources + runtime persistence foundation (saas-resources-runtime P2) — manifested project resources (kind/spec/status with a reconciled phase) and the runtime deployments + steps that drive them, with a one-active-deployment-per-resource guard",
    },
    {
      id: "220_state_foundation",
      context: "state",
      path: "220_state_foundation/up.sql",
      checksum:
        "fbefda1f93351952a4ca55a348091d451ae2deddc4d632400d0321397a321a8e",
      description:
        "State persistence foundation (saas-orun-platform OP0, dormant) — run coordination (runs + run_jobs with leases), the content-addressed object index, append-only log chunks, catalog heads + the catalog read-model, and Orun workspace links; all org/project-denormalized with tenant-safe composite FKs",
    },
    {
      id: "230_identity_cli_sessions",
      context: "identity",
      path: "230_identity_cli_sessions/up.sql",
      checksum:
        "ddc3c1df7d7f1b61a3ba26e10d954deb64b9aaddaccaa44fcbbe03220d1d7e1d",
      description:
        "CLI session auth foundation (saas-orun-platform OP1) — extends identity.sessions with a 'cli' kind plus a rotating-refresh token family (reuse ⇒ family revoke) and adds identity.cli_login_grants, the short-lived single-use grant table backing the browser-loopback and RFC-8628 device flows; hashed secrets only",
    },
    {
      id: "240_identity_cli_refresh_grace",
      context: "identity",
      path: "240_identity_cli_refresh_grace/up.sql",
      checksum:
        "b337bd1fc9d0e78f58e8d824f71ad6f405b649d40d2d6a5622d291e8257595b3",
      description:
        "CLI refresh-token reuse-grace interval (saas-orun-platform OP1 hardening, risk R11) — adds identity.sessions.grace_successor_ciphertext (AES-256-GCM envelope of the successor refresh token) + grace_expires_at, so a replay of a just-rotated token within a short window is re-issued the same successor idempotently instead of revoking the whole family",
    },
    {
      id: "250_state_refs",
      context: "state",
      path: "250_state_refs/up.sql",
      checksum:
        "b3bc8da388c96f27e1a7038b7f0aac332c293e34ff53db43c59e0e5f549b5c69",
      description:
        "Hosted RefStore (saas-orun-platform v2 OV1) — state.refs, the L2 mutable CAS pointer layer (name → ObjectID) over the immutable object graph, one row per (org, project, name) with a composite FK to state.objects; widens state.objects.kind to admit the object model's structural kinds (blob, tree) so the hosted plane stores the content-addressed objects the CLI's RemoteStore uploads",
    },
    {
      id: "260_state_link_provider",
      context: "state",
      path: "260_state_link_provider/up.sql",
      checksum:
        "561ed45ee873ac7771b48db1216f319cdef3f0716f68b834fc36ce1946483368",
      description:
        "Workspace link provider identity (saas-orun-platform v2 OV2.1, additive) — adds rename-stable provider/provider_repo_id/provider_owner_id/provider_owner_login to state.workspace_links plus a partial federation index on (provider, provider_repo_id), so Orun workspace links and the GitHub App's repo links converge on a repo's stable id (never owner/name); the strict (org,project) bijection index is deferred to a post-backfill flip",
    },
    {
      id: "270_state_link_ci_settings",
      context: "state",
      path: "270_state_link_ci_settings/up.sql",
      checksum:
        "ac39e41767083297242652f360cb5c5659b7ebf5c21b78afca6215b1daa16f28",
      description:
        "Per-link CI trust settings (saas-orun-platform v2 OV3, additive) — adds oidc_enabled/api_key_enabled and the optional OIDC gate columns allowed_ref_pattern/allowed_environments to state.workspace_links; the workspace link is the CI trust binding, these tighten it per-link (DV4 drops the separate oidc_trust_bindings table). Permissive defaults preserve link-as-trust semantics",
    },
    {
      id: "280_events_scm_ingest_index",
      context: "events",
      path: "280_events_scm_ingest_index/up.sql",
      checksum:
        "a30bd40f429c58dabfa03c4de76641b599ca27fa6b328e60ddcc61f0870d5d3d",
      description:
        "Keyset index for the OV4 scm.* ingestion consumer — a partial index on events.event_log (occurred_at, id) WHERE type LIKE 'scm.%', so the state-worker bridge drains source-control events globally in bounded O(batch) batches without scanning the whole event log",
    },
    {
      id: "290_state_scm_triggers",
      context: "state",
      path: "290_state_scm_triggers/up.sql",
      checksum:
        "63f4e59ff639bd61210d486aaff21b146d8d7ac601ad8b7a9198de90cab89473",
      description:
        "scm.* trigger projection + ingestion cursor (saas-orun-platform v2 OV4) — state.triggers records a normalized TriggerOccurrence per source-control event (idempotent by the source events.event_log id), the durable activity/PR feed precursor to object-graph materialization; state.scm_ingest_cursor is the consumer's bounded-work high-water mark",
    },
    {
      id: "300_state_link_bijection",
      context: "state",
      path: "300_state_link_bijection/up.sql",
      checksum:
        "c5b496478752af2af8b7e738ca7d4c63db5cb9de09083ca54f014a93cc41f7a6",
      description:
        "Project == repo bijection flip (saas-orun-platform v2 OV2.2) — the reverse of uq_state_workspace_link_remote: a partial unique index for at most one active workspace link per (org, project), preceded by a self-healing backfill that unlinks older duplicate active links (keep newest), so the strict flip never fails on existing data",
    },
    {
      id: "310_events_run_result_index",
      context: "events",
      path: "310_events_run_result_index/up.sql",
      checksum:
        "5b23b3734983022b906bc8367be1bf405b939d287572e2d69ef368159f953277",
      description:
        "Keyset index for the run-result write-back driver (saas-orun-platform v2 OV5 / saas-integrations IG9) — partial index event_log_run_result_idx (occurred_at, id) WHERE type IN the two terminal run results, mirroring event_log_scm_ingest_idx, so the state-worker write-back drain is O(batch) regardless of total event volume",
    },
    {
      id: "320_state_run_writeback_cursor",
      context: "state",
      path: "320_state_run_writeback_cursor/up.sql",
      checksum:
        "9b802f9d107cecfeedd4f58ec9eba11b1a5ec6ef4b943b2f02d550bcc5f9bb11",
      description:
        "High-water mark for the OV5/IG9 run-result write-back driver — single-row state.run_writeback_cursor (occurred_at, event_id) of the last terminal run event posted back to GitHub, advanced per-event so a crash never re-posts a non-idempotent Check Run; mirrors state.scm_ingest_cursor",
    },
    {
      id: "330_state_org_catalog_index",
      context: "state",
      path: "330_state_org_catalog_index/up.sql",
      checksum:
        "1c60ce2e5fba7e590be1075b107b8828c097556f3770983fe9dcd8147f5e369f",
      description:
        "Org-global catalog projection read model (saas-orun-platform v2 OV6) — state.org_catalog_entities merges every project's catalog into one org-wide graph, one row per entity per (source project, environment) scope with provenance (project, env, commit, head digest); namespaced by source to stay collision-free so repo/env are filters, not partitions; derived idempotently from the snapshot, never authored",
    },
    {
      id: "340_projects_environment_activity",
      context: "projects",
      path: "340_projects_environment_activity/up.sql",
      checksum:
        "77b2e20ea449e3908fed84c9ce45c3a724dffa1c3b0027e5d3eb550abc87e416",
      description:
        "Environment lifecycle liveness (saas-orun-platform v2 OV9) — adds projects.environments.last_active_at (bumped on every activity touch, backfilled to updated_at, defaults now()) plus a partial index on (last_active_at) WHERE status='active' to drive the stale-environment archival sweep; an active environment unpushed past the retention window archives reversibly (a fresh push revives it). Dormant until the OV9.2 cron",
    },
    {
      id: "350_state_run_last_seq",
      context: "state",
      path: "350_state_run_last_seq/up.sql",
      checksum:
        "247dee804462d813a4bd277c71c3759cf2cc87050320eb840801d86adb5826e3",
      description:
        "Projector high-water mark (saas-orun-backend-merge BM3) — adds state.runs.last_seq (BIGINT, default 0), the per-run seq the projector guards its writes on so projecting the RunCoordinator DO's fold into Postgres is idempotent under replay/out-of-order delivery. Dormant until the projector runs on the DO backend.",
    },
    {
      id: "360_state_runs_org_index",
      context: "state",
      path: "360_state_runs_org_index/up.sql",
      checksum:
        "e347d6f2d5b6ab661b064282ea2821147db0a1039ac86bb978ba5232664df373",
      description:
        "Org-global runs feed keyset index (console Activities surface) — adds idx_state_runs_org (org_id, created_at DESC, id DESC), the org-scoped twin of idx_state_runs_project, so the all-repos run history merged across every project is index-ordered for keyset pagination. The project-narrowed feed keeps using idx_state_runs_project.",
    },
    {
      id: "370_state_catalog_portal_fields",
      context: "state",
      path: "370_state_catalog_portal_fields/up.sql",
      checksum:
        "d7b077f3a3b3d1db062199891a99f5acf1281761574467cb53ab2b258ead84d2",
      description:
        "Git-authored portal fields on the org catalog projection (saas-catalog-portal CP4) — adds nullable description / system / language and a tags JSONB to state.org_catalog_entities, plus idx_state_org_catalog_entities_system. Projected from the snapshot (orun objcatalog CPF0), derived never authored; additive so older rows read null and the console degrades.",
    },
    {
      id: "380_integrations_repo_single_claim",
      context: "integrations",
      path: "380_integrations_repo_single_claim/up.sql",
      checksum:
        "2614b9526786ad93b1633df862b79d6cb9f71d0ba61ab082a87badbf955ddb81",
      description:
        "One active claim per repo per connection (saas-integration-tenancy IT2) — adds the partial unique uq_integrations_repo_claim (connection_id, repo_external_id) WHERE status='active' so two workspaces under one shared (account-owned) connection cannot both hold an active link to the same repo. Complements the existing per-project unique; additive + idempotent; back-compatible since every existing org is standalone.",
    },
    {
      id: "390_integrations_connection_scope",
      context: "integrations",
      path: "390_integrations_connection_scope/up.sql",
      checksum:
        "2223f09c944e563965e543eea406699664d022a88d60dab3a39bda71c08b2d10",
      description:
        "Connection ownership scope (saas-integration-tenancy IT7) — adds connections.scope ('account'|'workspace') default 'account' with a CHECK. 'account' is the shared, resolve-up connection; 'workspace' is a workspace's own GitHub account, owned at the workspace and never resolved up. Additive + idempotent; the backfill is a no-op so existing rows are unchanged.",
    },
    {
      id: "400_integrations_admission",
      context: "integrations",
      path: "400_integrations_admission/up.sql",
      checksum:
        "67b0152ecc65d48e8dc23faa71873b8ee0dc9fd68a4cca4ce9d3fe6707037091",
      description:
        "Admission control & share mode (saas-integration-tenancy IT8) — adds connections.share_mode ('auto'|'granted') default 'auto' with a CHECK, plus the integrations.connection_grants allow-list (one active grant per connection+workspace). 'auto' is today's implicit sharing; 'granted' requires an active grant. Additive + idempotent; back-compatible since the default is 'auto'.",
    },
    {
      id: "410_membership_org_public_ref",
      context: "membership",
      path: "410_membership_org_public_ref/up.sql",
      checksum:
        "5dcfaeb2cb44bc25103071c4f4917c863dd42f662809aad05d0fd67b990e49ce",
      description:
        "Durable public Workspace ID (saas-workspace-id WID2) — adds the immutable membership.organizations.public_ref column ('ws_<8 Crockford-base32>', e.g. ws_3KF9TQ2P) with a unique index, plus the membership.gen_workspace_ref() SQL helper used as the column default. The default backfills existing rows during the rewrite and is a deploy-safety backstop; the canonical mint is the create-organization handler. Additive + idempotent.",
    },
    {
      id: "420_membership_account_rbac",
      context: "membership",
      path: "420_membership_account_rbac/up.sql",
      checksum:
        "b9aab01a0c1c4516c36a00059a550469cef449532740621ea39a2ebf58d02907",
      description:
        "Account-scoped RBAC (saas-workspace-id WID6, Stage 1a of the Account layer) — widens membership.role_assignments' CHECK constraints so a role can be granted at account scope and cascade to every workspace under the account: scope_kind gains 'account' (joining 'organization'/'project') and role gains 'account_owner'/'account_admin'/'account_billing_admin'. The cascade is resolved in membership-worker's authorization-context assembly (account facts remapped onto the target org id), not the DB. Additive + idempotent (constraints replaced via guarded DROP+ADD); back-compatible since every existing row keeps validating.",
    },
    {
      id: "430_config_account_scope",
      context: "config",
      path: "430_config_account_scope/up.sql",
      checksum:
        "8540ae233af2e2321305a0a29506c6643ae5158c794a230c7fd609baa56ec6d7",
      description:
        "Account-level config scope + overridable guardrail (saas-workspace-id WID7) — adds config.settings.overridable BOOLEAN default true, extends the scope_kind CHECK to admit 'account', and guards that only account-scope rows may be locked (overridable=false). Backs the scope-resolution chain (environment->project->workspace->account->default): an account value is inherited by every workspace unless it is a locked guardrail, which workspaces cannot override. Piloted on config.settings; feature_flags/secret_metadata may adopt later. Additive + idempotent.",
    },
    {
      id: "440_membership_teams",
      context: "membership",
      path: "440_membership_teams/up.sql",
      checksum:
        "c509a7453c1abd486741dd2fbc037820734feac26a9c106a7e963323c7ac10ed",
      description:
        "Account-owned Teams as principals (saas-teams TM1) — adds membership.teams (id, account_org_id, name, slug_lower, status; unique (account_org_id, slug_lower) for non-deleted) and membership.team_members (team_id, subject_id, subject_type, status; unique (team_id, subject_id)), and widens membership.role_assignments' subject_type CHECK to admit 'team' so a team becomes a grantable principal (subject_id = team_<base32>). Teams are account-scoped (not a tenancy level, not a resource container); grants are expanded into facts at authorization-context assembly (TM3). Additive + idempotent (guarded DROP+ADD for the CHECK); back-compatible since every existing user/service_principal row keeps validating.",
    },
    {
      id: "450_membership_invitation_email_index",
      context: "membership",
      path: "450_membership_invitation_email_index/up.sql",
      checksum:
        "f05ac0636c8c9398a8e260d12494975d24add15fd71dae5b72642cd06b7c8c0d",
      description:
        "Email-scoped invitation discovery — adds a standalone index membership.organization_invitations (email_lower) so a signed-in user can look up every pending invitation for their verified email across all organizations. The invitation-created email carries no token link ('sign in with this email address to view and accept the invitation'); the existing composite (org_id, email_lower) index cannot serve an email-only lookup. Additive + idempotent (CREATE INDEX IF NOT EXISTS); back-compatible.",
    },
    {
      id: "460_state_repo_facet",
      context: "state",
      path: "460_state_repo_facet/up.sql",
      checksum:
        "85b0e6d0b407b37439431206d98ceae745bcabacb64785f87014663497509395",
      description:
        "Repo self-description facet + doc_ref pointers (saas-workspace-overview WO4). Adds state.org_catalog_entities.doc_ref JSONB (a nullable {path,ref,sha,digest} pointer to the entity's docs.overview blob in CAS — digest is the content address, the body is read from R2 by digest; no state.objects.kind change since docs ride the existing blob kind) and creates state.repo_facet (org_id, source_project_id PK; display_name, description, owner, default_branch, links, tags, doc_ref, entity_ref, head_digest, source_commit, synced_at) — one row per (org, project) projected from the declared Repo entity, keyed by project so the Git Repos list + Workspace Overview identity join by project. Derived, never authored; delete-then-upsert on catalog.head.advanced. Additive + idempotent.",
    },
    {
      id: "470_config_secret_manager",
      context: "config",
      path: "470_config_secret_manager/up.sql",
      checksum:
        "e6596e911770611b13ca6a8c86372d9af8cc47e70e92dc07879900fdc4a838b5",
      description:
        "Secret store v3 (saas-secret-manager SM1, pairs orun-secrets SEC1) — creates config.secret_versions, the append-only per-secret ciphertext history keyed (secret_id, version) with status active/revoked (rotate stops overwriting envelopes in place; each existing head envelope is backfilled as its current version, ON CONFLICT DO NOTHING), and widens config.secret_metadata onto the WID7 scope-resolution chain shape: personal_owner UUID (NULL = shared; a per-user overlay, environment scope only via CHECK), overridable BOOLEAN default true (lockable at account OR organization scope — deliberate divergence from settings' account-only locks), last_used_at TIMESTAMPTZ (stamped by the SM3 resolve), scope_kind CHECK widened to admit 'account', and the scope-key unique index rebuilt to include COALESCE(personal_owner, zero-uuid) so a personal overlay coexists with the shared row. Additive + idempotent.",
    },
    {
      id: "480_config_secret_deks",
      context: "config",
      path: "480_config_secret_deks/up.sql",
      checksum:
        "07fab66d95cd22ba51b61d5439c6d168016ab77c751f95bdc02a5b52e4393550",
      description:
        "Wrapped workspace data-encryption keys (saas-secret-manager SM2, pairs orun-secrets SD-2′) — creates config.secret_deks keyed (org_id, generation >= 1): each workspace's DEK stored WRAPPED under the KEK (the config-worker SECRET_KEK binding; Cloudflare Secrets Store deferred to saas-secrets-sync SS4) as a JSON {v, iv, ct} document in BYTEA, with state active/retiring/shredded (the cryptoshred/rotate unit). A v:2 ciphertext envelope names its row via keyId ws:<org_id>:<generation>; generation 1 is minted on a workspace's first KEK-era write via race-safe INSERT ... ON CONFLICT DO NOTHING. No raw key material ever lands in Postgres. Additive + idempotent.",
    },
    {
      id: "490_work_teardown",
      context: "work",
      path: "490_work_teardown/up.sql",
      checksum:
        "6a78f3a70c13ca561228710dc0ef96d43767b65d42f39f0f55cc2e6ed8e05666",
      description:
        "Drop the v1 work-plane schema (orun-work v1 scrapped before any product surface consumed it — no route, worker, SDK, or console ever read these tables). Removes the work schema created by 200_work_foundation (items/events/links/status/cursors/sequences) via DROP SCHEMA ... CASCADE, alongside the removal of the @saas/db/work library. The v2 design (two append-only logs, lifecycle as a derived query, no stored status) lands its own schema under fresh migrations; see the orun repo specs/orun-work/ (v2), specs/archive/orun-work-v1/ (frozen v1), and specs/epics/orun-work/ here.",
    },
    {
      id: "500_config_secret_policies",
      context: "config",
      path: "500_config_secret_policies/up.sql",
      checksum:
        "2f15f1ea8552d1de6de6528b5b8be7ec4b1fa0c602194cf53b3a30edbc17412d",
      description:
        "Tier-tagged SecretPolicy documents (saas-secret-manager SM3, pairs orun-secrets SEC2) — creates config.secret_policies (id UUID PK, org_id, project_id NULL = workspace-wide, name, tier composition/stack/intent, source provenance, document JSONB, document_hash content-address, created_at) with a unique index on (org_id, COALESCE(project_id, zero-uuid), tier, name). The Layer-2 condition store the lease-bound resolve evaluates in a config-worker pure lib; a document's tenancy scope comes from (org_id, project_id), push is idempotent by document_hash, and the JSONB body NEVER carries a secret value. Additive + idempotent.",
    },
    {
      id: "510_config_secret_syncs",
      context: "config",
      path: "510_config_secret_syncs/up.sql",
      checksum:
        "583e8bb995b83daf35580dd876bb846d34d25dc1c0c6353ab7553bcbc863d9b8",
      description:
        "Materialization provenance (saas-secret-manager SM5, pairs orun-secrets SEC6) — creates config.secret_syncs (id UUID PK, secret_id FK to secret_metadata, org_id/project_id/environment_id recording scope, version, target adapter id, entity_ref provisioned entity, run_id deploy ULID, status synced/superseded/orphaned CHECK default synced, synced_at). Records what a deploy run's materialize step pushed where, at which version, so the catalog facet answers 'is the running entity on the latest rotation?' and drift is detectable. References/metadata ONLY — no secret value (Invariant 10). Indexes: (org_id, COALESCE(project_id, zero), COALESCE(environment_id, zero), secret_id) for the catalog join, (entity_ref, target) for the per-entity view, and a partial UNIQUE (secret_id, target, entity_ref) WHERE status='synced' so a new sync supersedes the prior. Additive + idempotent.",
    },
    {
      id: "520_config_secret_rotation_reminder",
      context: "config",
      path: "520_config_secret_rotation_reminder/up.sql",
      checksum:
        "8576f09371698749a73d3e80b5e2fac181d900bc9aff8d28e9c89e0dc02304f9",
      description:
        "Rotation/expiry reminder bookkeeping (saas-secret-manager SEC7, pairs orun-secrets SD-3) — adds config.secret_metadata.last_reminded_at TIMESTAMPTZ (NULL = never reminded), the idempotency stamp the rotation/expiry cron writes after emitting a secret.rotation_due / secret.expiring event so a still-overdue secret is not re-notified every tick. Adds a partial index (last_reminded_at) WHERE status='active' AND (rotation_policy IS NOT NULL OR expires_at IS NOT NULL) so the periodic due-scan is O(candidates). Reminder bookkeeping over metadata only — no secret value. Additive + idempotent.",
    },
    {
      id: "530_membership_teams_foundation",
      context: "membership",
      path: "530_membership_teams_foundation/up.sql",
      checksum:
        "8e206b84026e0fb6a035bd995c1c364f1a7dbe62065c5de1ccfd2a23cb202dad",
      description:
        "Promote a Team into a first-class entity (teams-foundation TF1) — adds membership.teams.handle (account-unique, case-insensitive, mentionable — e.g. 'payments' → @payments; nullable so TM-era teams stay valid), description, and avatar_ref (opaque; NULL renders initials+colour client-side). A partial unique index teams_account_handle_idx (account_org_id, lower(handle)) WHERE handle IS NOT NULL AND status <> 'deleted' enforces per-account uniqueness among live teams and frees a deleted team's handle. Grants/owner-maps/routing bind to the immutable team_<hex> id, never the mutable handle. Additive + idempotent over 440_membership_teams.",
    },
    {
      id: "540_membership_team_roles",
      context: "membership",
      path: "540_membership_team_roles/up.sql",
      checksum:
        "24e8cfb37a227da07ad82021c20d3d78cb4687d35a43bfedbe8ac03c8aadd74c",
      description:
        "Team-management roles (teams-foundation TF2) — adds membership.team_members.team_role (DEFAULT 'team_member', CHECK team_role IN ('team_admin','team_member') via a guarded DO-block) so a team is self-managed: a team_admin manages the team object + roster, distinct from the platform roles the team is granted via role_assignments (a roster edit never escalates the team's power). Every TM-era row backfills to 'team_member'. Additive + idempotent over 440_membership_teams.",
    },
    {
      id: "550_membership_team_owner_handles",
      context: "membership",
      path: "550_membership_team_owner_handles/up.sql",
      checksum:
        "52a6d48ca298f4d0d78623ab3629bd3ab95f0264820ffa56e5cb870c72131bee",
      description:
        "Owner-handle → team resolver map (teams-ownership TO1) — creates membership.team_owner_handles (account_org_id, owner_handle, team_id text = team_<hex>, timestamps) with an account-unique case-insensitive index on lower(owner_handle) and a team_id index. Binds a git-authored catalog `owner:` string to a team entity as ORG METADATA (never catalog content — 18-state intact); resolution is read-time (TO2) and defaults to owner==team.handle, so this table captures aliases only. Additive + idempotent.",
    },
    {
      id: "560_work_foundation_v2",
      context: "work",
      path: "560_work_foundation_v2/up.sql",
      checksum:
        "0db67ca1ebe87eb890c4c48812c90985c876ba80cc384b44dbd33b8dcaf1ff24",
      description:
        "The work lens — two append-only logs (orun-work v2 WP0). Recreates the work schema (v1 dropped by 490_work_teardown) as: work.specs + work.tasks (droppable fold caches of the coordination log — intent envelopes only), work.events (the authored coordination log: closed 9-kind vocabulary with NO lifecycle-write kind, mandatory typed actor, per-workspace seq = the sync cursor), work.observations (the world-authored fact log: closed 6-kind vocabulary, named versioned source, dedupe_key idempotency), and work.sequences (task-key PREFIX-n + the two log counters). No status/lifecycle/gate/released column exists anywhere — lifecycle is a derived query (WP-3); workspace-scoped tenancy, no project partition (WP-7). Additive + idempotent.",
    },
    {
      id: "570_state_catalog_projection",
      context: "state",
      path: "570_state_catalog_projection/up.sql",
      checksum:
        "014eecc8aa5349b45702f861fe3ed6ece094dff0a3767cb22042329c067523b6",
      description:
        "Durable catalog-projection outbox (saas-workspace-overview projection reliability). Creates state.catalog_projection (org_id, project_id, environment; projected_digest, projected_at, attempts, last_error, updated_at) recording the last head digest whose read-model projection committed, with a unique index on (org_id, project_id, COALESCE(environment,'')). The cron catalog-projection-sweep drives from state.catalog_heads LEFT JOIN this table and re-projects any scope whose projected_digest lags its current head — the reliable backstop for the on-advance ctx.waitUntil projection that can be torn down when state-worker is invoked over a service binding (leaving org_catalog_entities + repo_facet frozen). A scope stale before this table existed is detected on the first pass (projected_digest NULL) — no backfill. Additive + idempotent.",
    },
    {
      id: "580_event_streams_foundation",
      context: "events",
      path: "580_event_streams_foundation/up.sql",
      checksum:
        "e6c317e08a17ae53f4f6e18009e0b4492db3331a048f52fac1bdcb2824c69039",
      description:
        "Event streams foundation (saas-event-streaming ES0) — lays the shared substrate for the spec-09 router that was never built: events.subscriber_lanes (the lane registry — a lane is a named, at-least-once, cursored subscription over event_log; pausing one is the operational kill switch), events.lane_cursors (per-(lane, org) keyset dispatch positions — the events-owned generalization of webhooks.webhook_dispatch_cursor, which the webhooks lane adopts in ES1), events.dead_letters (poisoned deliveries as pointer + forensics with a (lane, event) uniqueness so retries update rather than fork), events.notification_rules + events.rule_targets (org/project-scoped routing rules with mandatory throttle fields, evaluated from ES2; target_kind forward-defined for team/inbox), and events.event_groups + events.event_group_members (the dedup/correlation read-model — one open story per (org, rendered dedup key) via a partial unique index, activated in ES4). Tables only; nothing reads or writes them until the owning milestones land. Additive + idempotent; no cross-context FKs.",
    },
    {
      id: "590_webhooks_lane_adoption",
      context: "events",
      path: "590_webhooks_lane_adoption/up.sql",
      checksum:
        "0bdabe9ef1ea1e4adf0719138956326547ff0626ef4c7c880e71f52b6106aa97",
      description:
        "Webhooks lane adoption (saas-event-streaming ES1) — seeds the subscriber-lane registry with the two launch lanes ('webhooks' active, owned by webhooks-worker with delivery mechanics unchanged; 'notifications' PAUSED until the ES2 rules engine lands) and backfills events.lane_cursors from webhooks.webhook_dispatch_cursor (one-time one-directional copy INTO the events context per the R6 cutover protocol: copy -> dual-read -> cutover -> drop later; the legacy table stays intact as the runtime read-through fallback and rollback path). Idempotent via ON CONFLICT DO NOTHING throughout; no cross-context foreign keys.",
    },
    {
      id: "600_notification_rule_throttle",
      context: "events",
      path: "600_notification_rule_throttle/up.sql",
      checksum:
        "0f356cd02a0ec20588aa8f40f34c5596a3f8608a2ab48a7b809d4c1ab3e15f84",
      description:
        "Notification-rule throttle state + notifications lane activation (saas-event-streaming ES2) — creates events.rule_throttle_state (one row per rule; fixed window anchored at first fire; fired_count consumed via a single atomic upsert so overlapping cron ticks cannot double-admit — the ledger behind the mandatory throttle_window_seconds/throttle_max rule fields, R1 storm control) and flips the 'notifications' subscriber lane from its seeded PAUSED state to active now that the ES2 rules engine gives the lane a handler. Operators keep the pause switch via subscriber_lanes.status. Additive + idempotent; same-context FK only.",
    },
    {
      id: "610_notification_channels",
      context: "notifications",
      path: "610_notification_channels/up.sql",
      checksum:
        "e60a7ee8d80931638963f9917e78cbe2aff5897dfb16e6f099ed3d3f1f64deb0",
      description:
        "Notification channels + async-retry scaffolding (saas-event-streaming ES3) — creates notifications.notification_channels (per-org channel config; config_ciphertext holds an AES-GCM CiphertextEnvelope of a bearer credential like a Slack incoming-webhook URL, write-only and never returned on CRUD reads, mirroring webhooks.webhook_endpoints.secret_ciphertext), lifts the channel CHECK from ('email') to ('email','slack') across the three channel-bearing tables (preferences, notifications, suppressions; attempts has no channel column), and adds next_retry_at + attempt_count to notifications plus a partial retry index so the new notifications-worker cron can drain and re-send failed rows on the webhooks-style backoff ladder (synchronous enqueue send = attempt 1). Additive + idempotent (DROP CONSTRAINT IF EXISTS before re-add, ADD COLUMN IF NOT EXISTS); no cross-context FKs.",
    },
    {
      id: "620_state_catalog_docs",
      context: "state",
      path: "620_state_catalog_docs/up.sql",
      checksum:
        "d4540e32c92f559482c4fe03a0ec6864810472c20486f45f81796c5fad717aeb",
      description:
        "Org-wide catalog doc index (saas-catalog-docs CD3) — creates state.catalog_docs: one row per attached (digest-bearing) doc of every catalog entity (the reserved overview + the ordered docs.pages set from CLI CD1/CD2), keyed (org, project, env, entity_ref, doc_key) with denormalized entity kind/name for the Docs-hub browse, role/title/path/commit provenance, the CAS digest the console renders the body by, and (org, digest) + (org, kind, role) + keyset indexes. Projected in the same delete-then-upsert pass as org_catalog_entities and swept by the migration-570 outbox. Derived, never authored; additive + idempotent.",
    },
    {
      id: "630_event_grouping",
      context: "events",
      path: "630_event_grouping/up.sql",
      checksum:
        "56bed9b11b6f860bc296358c3a6626a6df0f9424359be6e64a7e187e7c6b4018",
      description:
        "Event grouping activation + group-aware notification ledger (saas-event-streaming ES4) — seeds the 'grouping' subscriber lane (active; the events-worker grouping handler renders catalog dedup keys and maintains events.event_groups as an open-story-per-key read-model) and creates events.rule_group_notifications, the notifications lane's own (rule_id, group_key) high-water-severity ledger that fires a rule on a group's first matching event and on severity escalation but not on every member (one story, not five pings). The ledger is owned solely by the notifications lane, so group-aware firing is race-free regardless of lane dispatch order. Additive + idempotent (ON CONFLICT DO NOTHING seed, CREATE TABLE IF NOT EXISTS); same-context FK only.",
    },
    {
      id: "640_event_lifecycle",
      context: "events",
      path: "640_event_lifecycle/up.sql",
      checksum:
        "1e5ad371b35b2b8b1d38ad7ccc92ed97ad798b801b91197c27ae8cef75e9b5a3",
      description:
        "Event lifecycle — retention-sweep support + per-rule storm breaker (saas-event-streaming ES7). Adds storm-breaker state to events.notification_rules (suppressed_at/suppressed_reason — the auto-suppression overlay on top of the operator status column, a rule fires only when status='enabled' AND suppressed_at IS NULL, the read maps suppressed_at back onto the 'suppressed' status; saturated_window_count/last_saturated_at — the consecutive-saturation bookkeeping the throttle admission path maintains, reset on admit, incremented on deny, tripping auto-suppression past a threshold, cleared after a cooldown). Adds a partial notification_rules_suppressed_idx for the cooldown re-enable scan + admin storm audit, and two retention cutoff-scan partial indexes not already covered by the ES0/ES4 indexes: dead_letters_terminal_updated_idx (terminal-status age scan for the fixed-window dead-letter sweep) and event_groups_closed_at_idx (closed_at age scan for the closed-group sweep). event_log / audit_entries cutoff deletes reuse the existing (org_id, occurred_at) indexes; the design §10 security-category floor is enforced in the delete predicate, not the schema. Additive + idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, no DROP); same-context references only.",
    },
    {
      id: "650_agents_foundation",
      context: "agents",
      path: "650_agents_foundation/up.sql",
      checksum:
        "76daff1f0510762a25b00c22c029686c1018365e04d579db8035e96b74d6eff7",
      description:
        "Agent-session control plane foundation (saas-agents AG5/AG6) — the DORMANT schema the control plane projects onto (no worker consumes it until AG6). Creates schema agents with: agent_profiles (a workspace's binding of an orun agent TYPE to a membership service principal with a MANDATORY responsible owner; capability overrides narrow-only; UNIQUE(org_id,name)); agent_sessions (one hosted run of the orun runtime — state is an INFRASTRUCTURE fact via a CHECK'd 10-value vocabulary, categorically distinct from the derived work rung; carries the sealed AgentSessionSnapshot id + lease_expires_at for the reclaim sweep; partial lease index over non-terminal states); session_events (the control-plane RELAY mirror of the runtime's append-only log for console snapshot/replay — closed 11-kind vocabulary with no status/lifecycle kind, dedupe UNIQUE(session_id,seq), bulk payloads by R2 ref); autonomy_policies (per-spec/workspace autonomy level + caps, agent-plane config not work truth). Workspace-scoped (org_id). Additive + idempotent (CREATE ... IF NOT EXISTS throughout); references only its own schema.",
    },
    {
      id: "660_work_v3_intent_plane",
      context: "work",
      path: "660_work_v3_intent_plane/up.sql",
      checksum:
        "4a5fe3e146eec3e4b28f1425f358278044ae9f9227c8c79c5e62ba14d68e9f23",
      description:
        "The project surface's intent plane (orun-work-v3 PM0) — work.doc_revisions (append-only content-addressed cloud document bodies; digest form equals the imported doc_ref so both sources share one column, V3-2), work.initiatives (the third item kind's droppable envelope cache, rebuilt from the coordination log alone), work.cycles + work.views (authored intent nouns; handlers arrive PM3/PM2), the coordination-log kind CHECK regenerated to the 19-kind closed vocabulary (every addition intent or conversation, V3-1 — STILL no lifecycle-write kind, WP-3; the observation CHECK is untouched), and nullable folded-intent cache columns on work.tasks (priority/estimate/cycle_key, folded by the PM2 mutators). Nothing stores a rung, progress, or burn-up — derived only (V3-3). Additive + idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS; the CHECK swap is DROP IF EXISTS + ADD).",
    },
    {
      id: "670_identity_oauth_grants",
      context: "identity",
      path: "670_identity_oauth_grants/up.sql",
      checksum:
        "6af5b91fd8c66c0a9917d9a4b1ab767b0540b03dee8db30787cb3ee92602d56c",
      description:
        "OAuth 2.1 authorization codes for MCP clients (saas-mcp-server MCP3) — extends identity.cli_login_grants with a third 'oauth' flow instead of a new table (risks R5: no second token plane). The authorization code hashes into the existing cli_code_hash column (same single-use redeem semantics as the loopback cli_code); new nullable columns oauth_client_id / oauth_redirect_uri / oauth_code_challenge bind the code to its vetted public client (D1 Option A allow-list in code), exact redirect_uri, and PKCE S256 challenge. Flow + flow-secrets CHECKs regenerated (DROP IF EXISTS + ADD) to admit the oauth branch. Redeeming a code mints an ordinary cli-kind session labeled mcp:<clientId> via client_host — rotation, reuse detection, and console revocation unchanged. Additive + idempotent.",
    },
    {
      id: "680_agents_provider_connections",
      context: "agents",
      path: "680_agents_provider_connections/up.sql",
      checksum:
        "e5bcfc06fa6df5fa2cdede2690d88c21b56e485402b84915ee99f73a13031f11",
      description:
        "BYO provider accounts (saas-agents AG12, design §10): agents.provider_connections — a workspace connects its own Daytona account (sandbox compute) and Anthropic key (model credential). The row carries provider (CHECK daytona|anthropic), workspace-unique name, NON-SECRET config JSONB, secret_ref (the key itself lives in the secret manager under the reserved agents/providers/* namespace — config-worker stays the only decrypt path), a last4 key_hint, and a CHECK'd verification status (unverified|verified|invalid) + last_verified_at + redacted status_reason maintained by cheap read-only provider pings. Workspace-scoped; UNIQUE(org_id,provider,name). Additive + idempotent.",
    },
    {
      id: "690_work_v3_board_intent",
      context: "work",
      path: "690_work_v3_board_intent/up.sql",
      checksum:
        "008a19a8b470fa6098b24f9523a443d6144c6c5e506815f1444fd845855d6916",
      description:
        "Folded board-intent cache columns (orun-work-v3 PM2): work.tasks gains tags JSONB (sorted free-form workspace labels, folded from labeled/unlabeled) and relations JSONB ([{rel: blocks|parent|relates, target}], folded from related/unrelated — the fold derives Blocked from open `blocks` relations exactly as from contract Deps, a flag never a rung). Both columns are droppable envelope caches rebuilt from the coordination log alone (invariant 1). 660 already carries priority/estimate/cycle_key and work.views. Additive + idempotent (ADD COLUMN IF NOT EXISTS).",
    },
    {
      id: "700_work_v4_hierarchy",
      context: "work",
      path: "700_work_v4_hierarchy/up.sql",
      checksum:
        "139d4698f8ba6694c5fd34d63c475696418b353e0b3e6ac71a2a6e6583be1da8",
      description:
        "The planning hierarchy's intent plane (orun-work-v4 WH1): work.designs (the Design noun \u2014 doc chain + sealed context {catalog, coordSeq, obsSeq} + structured proposal; droppable envelope cache) and work.milestones (the epic-scoped checkpoint ladder, V4-D; droppable fold cache of milestone_edited). The events kind CHECK regenerates to the 27-kind closed vocabulary \u2014 the four decision kinds (approved/approval_revoked/design_adopted/superseded) are human-only at the model layer (V4-2); still no delivery-lifecycle-write kind (WP-3) and the observation CHECK is untouched (V4-1). Envelope property columns land as pure intent: work.tasks.milestone_key, work.specs.initiative_key + target_date, work.initiatives.owner + target_date + success_criteria. NO STORED FACT: no intent-state, approval, progress, or health column exists \u2014 all fold at read (V4-3/V4-4). work.doc_revisions.spec_key now carries any documented subject key (designs share the digest form \u2014 V4-6). Additive + idempotent.",
    },
    {
      id: "710_work_v4_snapshots",
      context: "work",
      path: "710_work_v4_snapshots/up.sql",
      checksum:
        "e86e279f0fdf3a8f06162c853c3af35b538db71dd1619593f09b4dba3f6ced7d",
      description:
        "Sealed epic briefs (orun-work-v4 WH4): work.snapshots — the content-addressed store for the canonical EpicSnapshot bytes the approve mutator seals in the same transaction as the approved event (id = sha256 of body, exactly the doc_revisions pattern for document bodies). Append-only intent-plane content, keyed by digest; orun epic pull fetches the bytes and verifies sha256(body) == id, so the approval IS the dispatch artifact. No stored fact: a snapshot structurally cannot carry a rung, assignee, or pin (asserted at seal time). Additive + idempotent.",
    },
    {
      id: "720_work_events_kind_check_repair",
      context: "work",
      path: "720_work_events_kind_check_repair/up.sql",
      checksum:
        "188a849936526852b9e643dc3a580166851c293be1df0a8864cd4e274da042e9",
      description:
        "Repair: the coordination-log kind CHECK becomes ONE constraint again. 560 created work.events with an inline unnamed CHECK (auto-named events_kind_check); the 660 and 700 vocabulary regenerations dropped the WRONG name (work_events_kind_check, a silent no-op) before adding it, so production enforced BOTH the original 9-kind v2 CHECK and the 27-kind v4 CHECK — every kind added since v2 (doc_edited, prioritized, …, milestone_edited, approved, …) was rejected at insert. Found by the WH6 dogfood import's milestone phase (the first real v3+/v4 write through the Postgres path). Drops both names, re-adds the canonical 27-kind work_events_kind_check — enforcement plumbing only, the vocabulary is exactly 700's: still no delivery-lifecycle-write kind (WP-3), observation CHECK untouched (V4-1). Idempotent as a unit.",
    },
    {
      id: "730_integration_hub_foundation",
      context: "integrations",
      path: "730_integration_hub_foundation/up.sql",
      checksum:
        "081229f8e288270e05a3fb172490f3a3c3c76cbbee9bc252c592e29b1f3ddf4f",
      description:
        "Integration-hub substrate (saas-integration-hub IH0), dormant: provider_credentials (parent-credential custody — Slack bot / Cloudflare parent / Supabase refresh tokens as write-only AES-256-GCM envelopes, one row per connection+kind, zeroized on revoke), minted_credentials (the credential-broker ledger — template/params/purpose/actor/run attribution/TTL/provider_ref, NEVER values; keyset per org+connection, partial live-mint index for the IH9 orphan sweep), and the per-provider facts tables slack_workspaces (team_id UNIQUE — the Slack tenancy keystone, the installation_id rule), cloudflare_accounts (verified parent grant + token health), supabase_orgs (org facts + cached project refs). No live behavior. Additive + idempotent.",
    },
  ],
};