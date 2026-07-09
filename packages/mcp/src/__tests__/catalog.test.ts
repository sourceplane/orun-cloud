// catalog_search / catalog_get_entity / catalog_read_doc

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LIMITS } from "../registry.js";

import { dataOf, errorDetailOf, forbidden, runTool } from "./helpers.js";

const entity = {
  orgId: "org_1",
  entityRef: "component:default/api",
  kind: "Component",
  name: "api",
  owner: "team-a",
  lifecycle: "production",
  relations: [],
  sourceProjectId: "prj_a",
  sourceEnvironment: null,
  sourceCommit: null,
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

describe("catalog_search", () => {
  it("passes facets, cursor, and limit through and returns the encoded next cursor", async () => {
    const listOrgCatalogEntities = vi.fn().mockResolvedValue({
      entities: [entity],
      nextCursor: { createdAt: "2026-01-02T00:00:00Z", id: "row_2" },
    });
    const result = await runTool(
      "catalog_search",
      { workspace: "ws_1", kind: "Component", q: "api", cursor: "c1|r1", limit: 25 },
      { state: { listOrgCatalogEntities } },
    );
    expect(listOrgCatalogEntities).toHaveBeenCalledWith("ws_1", {
      kind: "Component",
      q: "api",
      cursor: "c1|r1",
      limit: 25,
    });
    expect(dataOf(result)).toEqual({
      entities: [entity],
      meta: { cursor: "2026-01-02T00:00:00Z|row_2" },
    });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "catalog_search",
      { workspace: "ws_1" },
      { state: { listOrgCatalogEntities: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("catalog_get_entity", () => {
  it("emulates the getter by exact-filtering the list endpoint (risk D2)", async () => {
    const near = { ...entity, entityRef: "component:default/api-gateway" };
    const listOrgCatalogEntities = vi
      .fn()
      .mockResolvedValue({ entities: [entity, near], nextCursor: null });
    const result = await runTool(
      "catalog_get_entity",
      { workspace: "ws_1", entityRef: "component:default/api" },
      { state: { listOrgCatalogEntities } },
    );
    expect(listOrgCatalogEntities).toHaveBeenCalledWith("ws_1", {
      q: "component:default/api",
      limit: 100,
    });
    expect(dataOf(result)).toEqual({ entities: [entity] });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "catalog_get_entity",
      { workspace: "ws_1", entityRef: "component:default/api" },
      { state: { listOrgCatalogEntities: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("catalog_read_doc", () => {
  it("browses the doc index, passing cursor/limit through", async () => {
    const listCatalogDocs = vi.fn().mockResolvedValue({
      docs: [doc],
      nextCursor: { createdAt: "2026-01-02T00:00:00Z", id: "doc_2" },
    });
    const result = await runTool(
      "catalog_read_doc",
      { workspace: "ws_1", entityRef: doc.entityRef, cursor: "c|d", limit: 10 },
      { state: { listCatalogDocs } },
    );
    expect(listCatalogDocs).toHaveBeenCalledWith("ws_1", {
      entityRef: doc.entityRef,
      cursor: "c|d",
      limit: 10,
    });
    expect(dataOf(result)).toEqual({
      docs: [doc],
      meta: { cursor: "2026-01-02T00:00:00Z|doc_2" },
    });
  });

  it("reads a doc body by digest with the byte cap applied", async () => {
    const readCatalogDoc = vi.fn().mockResolvedValue("x".repeat(100));
    const result = await runTool(
      "catalog_read_doc",
      { workspace: "ws_1", digest: "sha256:doc" },
      { state: { readCatalogDoc } },
      { ...DEFAULT_LIMITS, maxTextBytes: 10 },
    );
    expect(readCatalogDoc).toHaveBeenCalledWith("ws_1", "sha256:doc");
    const data = dataOf(result);
    expect(data["truncated"]).toBe(true);
    expect(data["truncatedBytes"]).toBe(90);
    expect(String(data["content"])).toContain("[truncated — 90 more bytes");
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "catalog_read_doc",
      { workspace: "ws_1", digest: "sha256:doc" },
      { state: { readCatalogDoc: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});
