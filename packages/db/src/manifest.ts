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
  ],
};
