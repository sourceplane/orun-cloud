import {
  isWorkspaceAliasRoute,
  rewriteWorkspacePath,
  rewriteToOrgRequest,
  addWorkspaceIdDeep,
  projectWorkspaceAlias,
} from "@api-edge/workspace-facade";

describe("workspace alias routing", () => {
  it("matches the /v1/workspaces collection and sub-paths", () => {
    expect(isWorkspaceAliasRoute("/v1/workspaces")).toBe(true);
    expect(isWorkspaceAliasRoute("/v1/workspaces/org_abc")).toBe(true);
    expect(isWorkspaceAliasRoute("/v1/workspaces/org_abc/projects")).toBe(true);
  });

  it("does not match the org surface or unrelated paths", () => {
    expect(isWorkspaceAliasRoute("/v1/organizations")).toBe(false);
    expect(isWorkspaceAliasRoute("/v1/workspaces-foo")).toBe(false);
    expect(isWorkspaceAliasRoute("/health")).toBe(false);
  });

  it("rewrites the collection segment to organizations, preserving the id + tail", () => {
    expect(rewriteWorkspacePath("/v1/workspaces")).toBe("/v1/organizations");
    expect(rewriteWorkspacePath("/v1/workspaces/org_abc")).toBe("/v1/organizations/org_abc");
    expect(rewriteWorkspacePath("/v1/workspaces/org_abc/projects/proj_1")).toBe(
      "/v1/organizations/org_abc/projects/proj_1",
    );
  });

  it("rewrites the routed request URL while preserving method, query, and body", async () => {
    const original = new Request("https://api.test/v1/workspaces/org_abc/projects?limit=5", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "ikey_1" },
      body: JSON.stringify({ name: "x" }),
    });
    const routed = rewriteToOrgRequest(original, rewriteWorkspacePath("/v1/workspaces/org_abc/projects"));
    const url = new URL(routed.url);
    expect(url.pathname).toBe("/v1/organizations/org_abc/projects");
    expect(url.search).toBe("?limit=5");
    expect(routed.method).toBe("POST");
    expect(routed.headers.get("idempotency-key")).toBe("ikey_1");
    expect(await routed.json()).toEqual({ name: "x" });
  });
});

describe("workspaceId projection", () => {
  it("mirrors orgId to workspaceId additively, deeply, without removing fields", () => {
    const input = {
      data: {
        project: { id: "proj_1", orgId: "org_abc", name: "api" },
        environments: [
          { id: "env_1", orgId: "org_abc", projectId: "proj_1" },
          { id: "env_2", orgId: "org_xyz", projectId: "proj_1" },
        ],
      },
      meta: { requestId: "req_1", cursor: null },
    };
    const out = addWorkspaceIdDeep(input) as typeof input & Record<string, unknown>;
    expect(out.data.project).toEqual({
      id: "proj_1",
      orgId: "org_abc",
      workspaceId: "org_abc",
      name: "api",
    });
    expect(out.data.environments[0]).toMatchObject({ orgId: "org_abc", workspaceId: "org_abc" });
    expect(out.data.environments[1]).toMatchObject({ orgId: "org_xyz", workspaceId: "org_xyz" });
    expect(out.meta).toEqual({ requestId: "req_1", cursor: null });
  });

  it("never overwrites an existing workspaceId", () => {
    const out = addWorkspaceIdDeep({ orgId: "org_abc", workspaceId: "org_custom" }) as Record<string, unknown>;
    expect(out.workspaceId).toBe("org_custom");
  });

  it("leaves objects without orgId untouched", () => {
    const out = addWorkspaceIdDeep({ id: "x", nested: { a: 1 } });
    expect(out).toEqual({ id: "x", nested: { a: 1 } });
  });

  it("projects a JSON response and recomputes content-length", async () => {
    const response = Response.json({ data: { orgId: "org_abc" }, meta: { requestId: "r" } });
    const projected = await projectWorkspaceAlias(response);
    const body = (await projected.json()) as { data: { orgId: string; workspaceId: string } };
    expect(body.data).toEqual({ orgId: "org_abc", workspaceId: "org_abc" });
    expect(projected.headers.get("content-length")).toBeNull();
  });

  it("passes through non-JSON responses unchanged", async () => {
    const response = new Response("plain text", { headers: { "content-type": "text/plain" } });
    const projected = await projectWorkspaceAlias(response);
    expect(await projected.text()).toBe("plain text");
  });

  it("returns the original response when the JSON body fails to parse", async () => {
    const response = new Response("{not valid json", {
      headers: { "content-type": "application/json" },
    });
    const projected = await projectWorkspaceAlias(response);
    expect(await projected.text()).toBe("{not valid json");
  });
});
