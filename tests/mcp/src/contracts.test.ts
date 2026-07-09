// Contract pins (saas-mcp-server MCP8, risk R4: coupling drift between tools
// and contracts). `packages/mcp` already pins each tool's schemas at COMPILE
// time (`satisfies` against `@saas/contracts` types); this suite adds the
// RUNTIME half for the highest-value DTO couplings: fixture DTOs — typed as
// the contracts types in `fixtures.ts`, so a contract rename is a compile
// error there first — flow through each tool's happy path, and the structured
// output must preserve the load-bearing fields. A renamed/dropped field that
// a tool silently swallows fails here.

import { DEFAULT_LIMITS, executeTool, getTool } from "@saas/mcp";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  auditEntry,
  billingWorkerEntity,
  billingWorkerOverviewDoc,
  failedRun,
  FAILING_JOB_ID,
  failingJobLogs,
  featureFlag,
  organization,
  PROJECT,
  publicEvent,
  quotaCheck,
  RUN_ID,
  runJobs,
  secretMetadata,
  seededSdk,
  setting,
  usageSummary,
  user,
  WORKSPACE,
} from "./fixtures.js";

async function run(name: string, input: unknown): Promise<Record<string, unknown>> {
  const tool = getTool(name);
  if (tool === undefined) throw new Error(`tool ${name} is not registered`);
  const result: CallToolResult = await executeTool(tool, input, {
    sdk: seededSdk(),
    limits: DEFAULT_LIMITS,
  });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

describe("contract pins: catalog entity (OrgCatalogEntity)", () => {
  it("catalog_search preserves the entity DTO verbatim", async () => {
    const data = await run("catalog_search", { workspace: WORKSPACE, owner: "team-payments" });
    expect(data).toEqual({
      entities: [billingWorkerEntity],
      meta: { cursor: null },
    });
  });

  it("catalog_get_entity preserves identity, owner, relations, and provenance", async () => {
    const data = await run("catalog_get_entity", {
      workspace: WORKSPACE,
      entityRef: billingWorkerEntity.entityRef,
    });
    expect(data).toEqual({ entities: [billingWorkerEntity] });
    const entity = (data["entities"] as Array<Record<string, unknown>>)[0]!;
    // Load-bearing fields, asserted individually so a drop names the field.
    expect(entity["entityRef"]).toBe(billingWorkerEntity.entityRef);
    expect(entity["owner"]).toBe(billingWorkerEntity.owner);
    expect(entity["relations"]).toEqual(billingWorkerEntity.relations);
    expect(entity["sourceProjectId"]).toBe(billingWorkerEntity.sourceProjectId);
  });

  it("catalog_read_doc preserves the doc index row (CatalogDoc)", async () => {
    const data = await run("catalog_read_doc", {
      workspace: WORKSPACE,
      entityRef: billingWorkerEntity.entityRef,
    });
    expect(data).toEqual({
      docs: [billingWorkerOverviewDoc],
      meta: { cursor: null },
    });
  });
});

describe("contract pins: runs + jobs (Run, RunJob, ReadLogResponse)", () => {
  it("runs_get preserves the run projection and every plan-DAG job", async () => {
    const data = await run("runs_get", {
      workspace: WORKSPACE,
      project: PROJECT,
      runId: RUN_ID,
    });
    expect(data).toEqual({ run: failedRun, jobs: runJobs });
    const runDto = data["run"] as Record<string, unknown>;
    expect(runDto["status"]).toBe("failed");
    expect(runDto["jobCounts"]).toEqual(failedRun.jobCounts);
    expect(runDto["git"]).toEqual(failedRun.git);
    const failing = (data["jobs"] as Array<Record<string, unknown>>).find(
      (job) => job["jobId"] === FAILING_JOB_ID,
    )!;
    expect(failing["status"]).toBe("failed");
    expect(failing["errorText"]).toBe("deploy step exited 1");
  });

  it("runs_list preserves the run rows and the cursor envelope", async () => {
    const data = await run("runs_list", { workspace: WORKSPACE });
    expect(data).toEqual({ runs: [failedRun], meta: { cursor: null } });
  });

  it("runs_read_logs preserves content and the live-tail cursor fields", async () => {
    const data = await run("runs_read_logs", {
      workspace: WORKSPACE,
      project: PROJECT,
      runId: RUN_ID,
      jobId: FAILING_JOB_ID,
    });
    expect(data).toEqual({
      content: failingJobLogs,
      truncated: false,
      truncatedBytes: 0,
      nextSeq: 3,
      complete: true,
    });
  });
});

describe("contract pins: events + audit (PublicEvent, PublicAuditEntry)", () => {
  it("events_search preserves the typed event DTO verbatim", async () => {
    const data = await run("events_search", { workspace: WORKSPACE });
    expect(data).toEqual({ events: [publicEvent], meta: { cursor: null } });
    const event = (data["events"] as Array<Record<string, unknown>>)[0]!;
    expect(event["type"]).toBe(publicEvent.type);
    expect(event["severity"]).toBe(publicEvent.severity);
    expect(event["subject"]).toEqual(publicEvent.subject);
  });

  it("audit_search preserves the audit entry DTO verbatim", async () => {
    const data = await run("audit_search", { workspace: WORKSPACE });
    expect(data).toEqual({ auditEntries: [auditEntry], meta: { cursor: null } });
    const entry = (data["auditEntries"] as Array<Record<string, unknown>>)[0]!;
    expect(entry["actorId"]).toBe(auditEntry.actorId);
    expect(entry["eventType"]).toBe(auditEntry.eventType);
    expect(entry["occurredAt"]).toBe(auditEntry.occurredAt);
  });
});

describe("contract pins: config plane (PublicSetting, PublicFeatureFlag, PublicSecretMetadata)", () => {
  it("config_read preserves settings and flags at the resolved scope", async () => {
    const data = await run("config_read", { workspace: WORKSPACE });
    expect(data).toEqual({
      scope: "organization",
      settings: [setting],
      featureFlags: [featureFlag],
    });
    const flag = (data["featureFlags"] as Array<Record<string, unknown>>)[0]!;
    expect(flag["flagKey"]).toBe(featureFlag.flagKey);
    expect(flag["enabled"]).toBe(featureFlag.enabled);
  });

  it("secrets_list preserves the metadata DTO — and never anything value-shaped", async () => {
    const data = await run("secrets_list", { workspace: WORKSPACE });
    expect(data).toEqual({ secrets: [secretMetadata] });
    const secret = (data["secrets"] as Array<Record<string, unknown>>)[0]!;
    expect(secret["secretKey"]).toBe(secretMetadata.secretKey);
    expect(secret["version"]).toBe(secretMetadata.version);
    // The transport-independent invariant (design §7 / risk R3).
    expect(JSON.stringify(data)).not.toMatch(/"(value|ciphertext|plaintext)"/);
  });
});

describe("contract pins: metering (GetUsageSummaryResponse, CheckQuotaResponse)", () => {
  it("usage_summary passes the summary DTO through whole", async () => {
    const data = await run("usage_summary", { workspace: WORKSPACE, metric: "state.runs" });
    expect(data).toEqual(usageSummary);
  });

  it("quota_check passes the quota DTO through whole", async () => {
    const data = await run("quota_check", { workspace: WORKSPACE, metric: "state.runs" });
    expect(data).toEqual(quotaCheck);
  });
});

describe("contract pins: orientation (AuthUser, PublicOrganization)", () => {
  it("whoami preserves the user and workspace DTOs", async () => {
    const data = await run("whoami", {});
    expect(data).toEqual({ user, workspaces: [organization] });
    const workspace = (data["workspaces"] as Array<Record<string, unknown>>)[0]!;
    expect(workspace["slug"]).toBe(organization.slug);
    expect(workspace["workspaceRef"]).toBe(organization.workspaceRef);
  });
});
