// The seeded org every suite in this component runs against (saas-mcp-server
// MCP8). Each fixture is TYPED AS its `@saas/contracts` DTO, so a contract
// field rename is a compile error HERE first, and the runtime contract-pin
// tests then catch any tool that silently drops the renamed field.
//
// `@saas/testing` was checked first (plan requirement): its fixtures cover
// only `TenantContext`/`HealthResponse` — none of the MCP tool DTOs — so the
// seeded org lives locally, typed straight against the contracts.

import type { AuthUser } from "@saas/contracts/auth";
import type {
  PublicFeatureFlag,
  PublicSecretMetadata,
  PublicSetting,
} from "@saas/contracts/config";
import type { PublicAuditEntry, PublicEvent } from "@saas/contracts/events";
import type { PublicOrganization } from "@saas/contracts/membership";
import type {
  CheckQuotaResponse,
  GetUsageSummaryResponse,
} from "@saas/contracts/metering";
import type { CatalogDoc, OrgCatalogEntity, Run, RunJob } from "@saas/contracts/state";
import type { OrunCloud } from "@saas/sdk";

// ── Identity / orientation ──────────────────────────────────────────────────

export const WORKSPACE = "org_acme";
export const PROJECT = "prj_billing";
export const RUN_ID = "01J0000000000000000000RUN1";
export const FAILING_JOB_ID = "deploy";

export const user: AuthUser = {
  id: "usr_1",
  email: "dev@acme.test",
  displayName: "Acme Dev",
};

export const organization: PublicOrganization = {
  id: WORKSPACE,
  name: "Acme",
  slug: "acme",
  workspaceRef: "ws_acme",
  kind: "account",
  createdAt: "2026-01-01T00:00:00Z",
};

// ── Catalog (the moat: git-derived, provenance-correct) ─────────────────────

export const billingWorkerEntity: OrgCatalogEntity = {
  orgId: WORKSPACE,
  entityRef: "component:default/billing-worker",
  kind: "Component",
  name: "billing-worker",
  owner: "team-payments",
  lifecycle: "production",
  relations: [{ type: "dependsOn", targetRef: "component:default/api-edge" }],
  sourceProjectId: PROJECT,
  sourceEnvironment: null,
  sourceCommit: "abc1234",
  headDigest: "sha256:head1",
};

export const apiEdgeEntity: OrgCatalogEntity = {
  orgId: WORKSPACE,
  entityRef: "component:default/api-edge",
  kind: "Component",
  name: "api-edge",
  owner: "team-platform",
  lifecycle: "production",
  relations: [],
  sourceProjectId: "prj_edge",
  sourceEnvironment: null,
  sourceCommit: "def5678",
  headDigest: "sha256:head1",
};

export const catalogEntities: OrgCatalogEntity[] = [billingWorkerEntity, apiEdgeEntity];

export const billingWorkerOverviewDoc: CatalogDoc = {
  orgId: WORKSPACE,
  projectId: PROJECT,
  sourceEnvironment: null,
  entityRef: billingWorkerEntity.entityRef,
  entityKind: "Component",
  entityName: "billing-worker",
  docKey: "overview",
  title: "billing-worker overview",
  role: "overview",
  path: "docs/overview.md",
  commitSha: "abc1234",
  digest: "sha256:doc1",
  sizeBytes: 64,
  position: 0,
  headDigest: "sha256:head1",
  syncedAt: "2026-06-01T00:00:00Z",
};

export const overviewDocBody =
  "# billing-worker\n\nOwned by team-payments. Bills the things.\n";

// ── Runs + jobs + logs (delivery plane) ─────────────────────────────────────

export const failedRun: Run = {
  runId: RUN_ID,
  orgId: WORKSPACE,
  projectId: PROJECT,
  environment: "prod",
  status: "failed",
  planDigest: "sha256:plan1",
  source: "ci",
  git: { commit: "abc1234", ref: "refs/heads/main", dirty: false },
  createdBy: { id: "sp_ci", kind: "service_principal", displayName: "ci" },
  createdAt: "2026-07-01T12:00:00Z",
  startedAt: "2026-07-01T12:00:05Z",
  finishedAt: "2026-07-01T12:03:00Z",
  jobCounts: { queued: 0, running: 0, succeeded: 1, failed: 1 },
};

export const runJobs: RunJob[] = [
  {
    runId: RUN_ID,
    jobId: "build",
    orgId: WORKSPACE,
    projectId: PROJECT,
    component: "billing-worker",
    deps: [],
    status: "succeeded",
    runnerId: null,
    leaseExpiresAt: null,
    attempt: 1,
    errorText: null,
    startedAt: "2026-07-01T12:00:05Z",
    finishedAt: "2026-07-01T12:01:00Z",
  },
  {
    runId: RUN_ID,
    jobId: FAILING_JOB_ID,
    orgId: WORKSPACE,
    projectId: PROJECT,
    component: "billing-worker",
    deps: ["build"],
    status: "failed",
    runnerId: null,
    leaseExpiresAt: null,
    attempt: 1,
    errorText: "deploy step exited 1",
    startedAt: "2026-07-01T12:01:05Z",
    finishedAt: "2026-07-01T12:03:00Z",
  },
];

export const failingJobLogs =
  "wrangler deploy billing-worker\nTypeError: fetch failed — API_EDGE_URL unset\nexit status 1\n";

// ── Governance (audit + events) ─────────────────────────────────────────────

export const auditEntry: PublicAuditEntry = {
  id: "aud_1",
  eventId: "evt_1",
  orgId: WORKSPACE,
  projectId: PROJECT,
  environmentId: null,
  actorType: "user",
  actorId: "usr_1",
  eventType: "config.flag.updated",
  source: "config-worker",
  category: "config",
  description: "Feature flag checkout.new_flow updated",
  subject: { kind: "feature_flag", id: "flag_1", name: "checkout.new_flow" },
  occurredAt: "2026-07-08T10:00:00Z",
  requestId: "req_fixture",
  correlationId: null,
  payload: { enabled: true },
};

export const publicEvent: PublicEvent = {
  id: "evt_1",
  type: "state.run.failed",
  version: 1,
  source: "state-worker",
  severity: "error",
  category: "delivery",
  title: "Run failed",
  occurredAt: "2026-07-01T12:03:00Z",
  actor: { type: "system", id: "system" },
  orgId: WORKSPACE,
  projectId: PROJECT,
  environmentId: null,
  subject: { kind: "run", id: RUN_ID, name: null },
  requestId: "req_fixture",
  correlationId: null,
  causationId: null,
  payload: { status: "failed" },
};

// ── Config plane (settings, flags, secret METADATA) ─────────────────────────

export const setting: PublicSetting = {
  id: "set_1",
  orgId: WORKSPACE,
  projectId: null,
  environmentId: null,
  scopeKind: "organization",
  key: "ci.default_branch",
  value: "main",
  description: null,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
};

export const featureFlag: PublicFeatureFlag = {
  id: "flag_1",
  orgId: WORKSPACE,
  projectId: null,
  environmentId: null,
  scopeKind: "organization",
  flagKey: "checkout.new_flow",
  enabled: true,
  value: null,
  description: null,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-07-08T10:00:00Z",
};

export const secretMetadata: PublicSecretMetadata = {
  id: "sec_1",
  orgId: WORKSPACE,
  projectId: null,
  environmentId: null,
  scopeKind: "organization",
  secretKey: "STRIPE_API_KEY",
  displayName: "Stripe API key",
  status: "active",
  version: 3,
  rotationPolicy: "90d",
  lastRotatedAt: "2026-05-01T00:00:00Z",
  expiresAt: null,
  createdBy: "usr_1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
};

// ── Metering (usage + quota; the "near quota" seed) ─────────────────────────

export const usageSummary: GetUsageSummaryResponse = {
  metric: "state.runs",
  totalQuantity: 92,
  totalRecords: 92,
  rollups: [
    {
      id: "roll_1",
      orgId: WORKSPACE,
      projectId: null,
      environmentId: null,
      metric: "state.runs",
      bucketType: "day",
      bucketStart: "2026-07-08T00:00:00Z",
      quantity: 92,
      recordCount: 92,
      createdAt: "2026-07-08T00:00:00Z",
      updatedAt: "2026-07-08T23:00:00Z",
    },
  ],
};

export const quotaCheck: CheckQuotaResponse = {
  allowed: true,
  metric: "state.runs",
  limit: 100,
  used: 92,
  remaining: 8,
  period: "month",
  enforcement: "soft",
  reason: null,
};

// ── The stubbed SDK the seeded org is served through ────────────────────────

interface StateCursorLike {
  createdAt: string;
  id: string;
}

function matches(entity: OrgCatalogEntity, q?: string): boolean {
  if (q === undefined) return true;
  return entity.name.includes(q) || entity.entityRef.includes(q);
}

/**
 * A stub `OrunCloud` serving exactly the seeded org above — the same
 * plain-object-of-methods pattern as `packages/mcp/src/__tests__/helpers.ts`
 * (tools only ever touch the SDK methods they call). No network, fully
 * deterministic; shared by the contract pins, the local conformance matrix,
 * and the eval harness.
 */
export function seededSdk(): OrunCloud {
  const noCursor: StateCursorLike | null = null;
  const stub = {
    auth: {
      getProfile: async () => ({ user }),
    },
    workspaces: {
      list: async () => ({ organizations: [organization] }),
    },
    state: {
      listOrgCatalogEntities: async (
        _org: string,
        query?: { q?: string; owner?: string; kind?: string },
      ) => ({
        entities: catalogEntities.filter(
          (e) =>
            matches(e, query?.q) &&
            (query?.owner === undefined || e.owner === query.owner) &&
            (query?.kind === undefined || e.kind === query.kind),
        ),
        nextCursor: noCursor,
      }),
      listCatalogDocs: async () => ({
        docs: [billingWorkerOverviewDoc],
        nextCursor: noCursor,
      }),
      readCatalogDoc: async () => overviewDocBody,
      listRuns: async () => ({ runs: [failedRun], nextCursor: noCursor }),
      listOrgRuns: async () => ({ runs: [failedRun], nextCursor: noCursor }),
      getRun: async () => ({ run: failedRun }),
      listRunJobs: async () => ({ jobs: runJobs }),
      readRunJobLogs: async () => ({
        content: failingJobLogs,
        nextSeq: 3,
        complete: true,
      }),
    },
    events: {
      listAuditEntriesPage: async () => ({ entries: [auditEntry], cursor: null }),
      listEventsPage: async () => ({ events: [publicEvent], cursor: null }),
      getEvent: async () => ({ event: publicEvent }),
    },
    config: {
      listSettings: async () => ({ settings: [setting] }),
      listFeatureFlags: async () => ({ featureFlags: [featureFlag] }),
      listSecretMetadata: async () => ({ secrets: [secretMetadata] }),
    },
    metering: {
      getUsageSummary: async () => usageSummary,
      checkQuota: async () => quotaCheck,
    },
  };
  return stub as unknown as OrunCloud;
}
