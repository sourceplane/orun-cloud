// MCP4 resources: catalog://{workspace}/{entityKey} + runs://{workspace}/{project}/{runId}

import { describe, expect, it, vi } from "vitest";

import { decodeEntityKey, encodeEntityKey } from "../resources.js";
import { createMcpServer } from "../server.js";

import { connectedClient, forbidden, stubSdk } from "./helpers.js";

const entity = {
  orgId: "org_1",
  entityRef: "component:default/api",
  kind: "Component",
  name: "api",
  owner: "team-a",
  lifecycle: "production",
  relations: [{ type: "dependsOn", targetRef: "component:default/db" }],
  sourceProjectId: "prj_a",
  sourceEnvironment: null,
  sourceCommit: "abc1234",
  headDigest: "sha256:head",
};

const doc = {
  orgId: "org_1",
  projectId: "prj_a",
  sourceEnvironment: null,
  entityRef: "component:default/api",
  entityKind: "Component",
  entityName: "api",
  docKey: "overview",
  title: "API overview",
  role: "overview",
  path: "docs/overview.md",
  commitSha: null,
  digest: "sha256:doc",
  sizeBytes: 12,
  position: 0,
  headDigest: "sha256:head",
  syncedAt: "2026-01-01T00:00:00Z",
};

const run = {
  runId: "01RUN",
  orgId: "org_1",
  projectId: "prj_a",
  environment: "prod",
  status: "failed",
  planDigest: "sha256:plan",
  source: "ci",
  git: { commit: "abc1234", ref: "refs/heads/main", dirty: false },
  createdBy: { id: "usr_1", kind: "user", displayName: "dev@x.test" },
  createdAt: "2026-01-01T00:00:00Z",
  startedAt: "2026-01-01T00:00:01Z",
  finishedAt: "2026-01-01T00:05:00Z",
  jobCounts: { queued: 0, running: 0, succeeded: 1, failed: 1 },
};

const jobs = [
  {
    runId: "01RUN",
    jobId: "build",
    orgId: "org_1",
    projectId: "prj_a",
    component: "component:default/api",
    deps: [],
    status: "succeeded",
    runnerId: null,
    leaseExpiresAt: null,
    attempt: 1,
    errorText: null,
    startedAt: "2026-01-01T00:00:01Z",
    finishedAt: "2026-01-01T00:02:00Z",
  },
  {
    runId: "01RUN",
    jobId: "deploy",
    orgId: "org_1",
    projectId: "prj_a",
    component: "component:default/api",
    deps: ["build"],
    status: "failed",
    runnerId: null,
    leaseExpiresAt: null,
    attempt: 2,
    errorText: "helm upgrade failed",
    startedAt: "2026-01-01T00:02:00Z",
    finishedAt: "2026-01-01T00:05:00Z",
  },
];

function catalogStub() {
  return {
    state: {
      listOrgCatalogEntities: vi.fn().mockResolvedValue({
        entities: [entity, { ...entity, entityRef: "component:default/api-gateway" }],
        nextCursor: null,
      }),
      listCatalogDocs: vi.fn().mockResolvedValue({ docs: [doc], nextCursor: null }),
      readCatalogDoc: vi.fn().mockResolvedValue("This service fronts the API."),
    },
  };
}

const catalogUri = `catalog://ws_1/${encodeEntityKey(entity.entityRef)}`;

/** Narrow a resources/read result to its single markdown text payload. */
function markdownOf(result: { contents: unknown[] }): string {
  const first = result.contents[0] as { mimeType?: string; text?: string } | undefined;
  if (first?.mimeType !== "text/markdown" || typeof first.text !== "string") {
    throw new Error("expected a single text/markdown content block");
  }
  return first.text;
}

describe("entityKey codec", () => {
  it("round-trips any entityRef through a single URL-safe path segment", () => {
    for (const ref of ["component:default/api", "api:acme/repo/v2+β", "x"]) {
      const key = encodeEntityKey(ref);
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeEntityKey(key)).toBe(ref);
    }
  });

  it("rejects non-base64url keys", () => {
    expect(() => decodeEntityKey("not/base64!")).toThrowError(/base64url/);
  });
});

describe("resource templates over the protocol", () => {
  it("advertises exactly the two design §6 templates as text/markdown", async () => {
    const client = await connectedClient(createMcpServer({ sdk: stubSdk({}) }));
    const listed = await client.listResourceTemplates();
    expect(
      listed.resourceTemplates.map((t) => [t.name, t.uriTemplate, t.mimeType]).sort(),
    ).toEqual([
      ["catalog_entity", "catalog://{workspace}/{entityKey}", "text/markdown"],
      ["run_summary", "runs://{workspace}/{project}/{runId}", "text/markdown"],
    ]);
    await client.close();
  });

  it("enumerates nothing on resources/list (empty-list posture — no org-wide sweep)", async () => {
    const client = await connectedClient(createMcpServer({ sdk: stubSdk({}) }));
    const listed = await client.listResources();
    expect(listed.resources).toEqual([]);
    await client.close();
  });

  it("stays registered under readOnly (resources are read-only by construction)", async () => {
    const client = await connectedClient(
      createMcpServer({ sdk: stubSdk({}), readOnly: true }),
    );
    const listed = await client.listResourceTemplates();
    expect(listed.resourceTemplates.length).toBe(2);
    await client.close();
  });
});

describe("catalog entity resource", () => {
  it("renders identity, relations, provenance, docs, and the overview body", async () => {
    const stub = catalogStub();
    const client = await connectedClient(createMcpServer({ sdk: stubSdk(stub) }));
    const result = await client.readResource({ uri: catalogUri });
    const text = markdownOf(result);
    expect(text).toContain("# component:default/api — api");
    expect(text).toContain("**Owner:** team-a");
    expect(text).toContain("**Lifecycle:** production");
    expect(text).toContain("dependsOn → `component:default/db`");
    expect(text).toContain("Project `prj_a`");
    expect(text).toContain("| overview | API overview | overview | `docs/overview.md` | `sha256:doc` |");
    expect(text).toContain("This service fronts the API.");
    // Same emulation path as catalog_get_entity (risk D2) + entity-scoped docs.
    expect(stub.state.listOrgCatalogEntities).toHaveBeenCalledWith("ws_1", {
      q: entity.entityRef,
      limit: 100,
    });
    expect(stub.state.listCatalogDocs).toHaveBeenCalledWith("ws_1", {
      entityRef: entity.entityRef,
      limit: 100,
    });
    expect(stub.state.readCatalogDoc).toHaveBeenCalledWith("ws_1", "sha256:doc");
    await client.close();
  });

  it("byte-caps the overview body with the explicit truncation marker", async () => {
    const stub = catalogStub();
    stub.state.readCatalogDoc = vi.fn().mockResolvedValue("x".repeat(100));
    const client = await connectedClient(
      createMcpServer({ sdk: stubSdk(stub), limits: { maxTextBytes: 10 } }),
    );
    const result = await client.readResource({ uri: catalogUri });
    expect(markdownOf(result)).toContain("[truncated — 90 more bytes");
    await client.close();
  });

  it("skips the overview section when the entity has no overview doc", async () => {
    const stub = catalogStub();
    stub.state.listCatalogDocs = vi.fn().mockResolvedValue({ docs: [], nextCursor: null });
    const client = await connectedClient(createMcpServer({ sdk: stubSdk(stub) }));
    const result = await client.readResource({ uri: catalogUri });
    const text = markdownOf(result);
    expect(text).toContain("No catalog docs.");
    expect(text).not.toContain("## Overview");
    expect(stub.state.readCatalogDoc).not.toHaveBeenCalled();
    await client.close();
  });

  it("maps a missing entity to not_found in the protocol error message", async () => {
    const stub = catalogStub();
    stub.state.listOrgCatalogEntities = vi
      .fn()
      .mockResolvedValue({ entities: [], nextCursor: null });
    const client = await connectedClient(createMcpServer({ sdk: stubSdk(stub) }));
    await expect(client.readResource({ uri: catalogUri })).rejects.toThrowError(
      /not_found: no catalog entity with ref "component:default\/api"/,
    );
    await client.close();
  });

  it("maps a malformed entityKey to validation_failed", async () => {
    const client = await connectedClient(createMcpServer({ sdk: stubSdk(catalogStub()) }));
    await expect(
      client.readResource({ uri: "catalog://ws_1/n%t-base64" }),
    ).rejects.toThrowError(/validation_failed/);
    await client.close();
  });

  it("carries the platform code + requestId on SDK errors (forbidden)", async () => {
    const stub = {
      state: {
        listOrgCatalogEntities: vi.fn().mockRejectedValue(forbidden()),
        listCatalogDocs: vi.fn().mockResolvedValue({ docs: [], nextCursor: null }),
      },
    };
    const client = await connectedClient(createMcpServer({ sdk: stubSdk(stub) }));
    await expect(client.readResource({ uri: catalogUri })).rejects.toThrowError(
      /forbidden: Forbidden \(requestId: req_test\)/,
    );
    await client.close();
  });
});

describe("run summary resource", () => {
  it("renders the run header, provenance, and the per-job status table", async () => {
    const stub = {
      state: {
        getRun: vi.fn().mockResolvedValue({ run }),
        listRunJobs: vi.fn().mockResolvedValue({ jobs }),
      },
    };
    const client = await connectedClient(createMcpServer({ sdk: stubSdk(stub) }));
    const result = await client.readResource({ uri: "runs://ws_1/prj_a/01RUN" });
    const text = markdownOf(result);
    expect(text).toContain("# Run 01RUN — failed");
    expect(text).toContain("**Environment:** prod");
    expect(text).toContain("`refs/heads/main` @ `abc1234`");
    expect(text).toContain("| build | succeeded | 1 | component:default/api | — |");
    expect(text).toContain("| deploy | failed | 2 | component:default/api | helm upgrade failed |");
    expect(stub.state.getRun).toHaveBeenCalledWith("ws_1", "prj_a", "01RUN");
    expect(stub.state.listRunJobs).toHaveBeenCalledWith("ws_1", "prj_a", "01RUN");
    await client.close();
  });

  it("maps forbidden through the read error path", async () => {
    const stub = {
      state: {
        getRun: vi.fn().mockRejectedValue(forbidden()),
        listRunJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      },
    };
    const client = await connectedClient(createMcpServer({ sdk: stubSdk(stub) }));
    await expect(
      client.readResource({ uri: "runs://ws_1/prj_a/01RUN" }),
    ).rejects.toThrowError(/forbidden: Forbidden \(requestId: req_test\)/);
    await client.close();
  });
});
