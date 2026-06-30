import {
  isOrgScopedPath,
  extractOrgSegment,
  resolveOrgRefInPath,
  ORG_REF_NOT_FOUND,
} from "@api-edge/org-ref-facade";
import { noopStore } from "@api-edge/org-ref-cache";
import type { Env } from "@api-edge/env";

const ORG_PUB = "org_2f65ddde1f5b4e938c0b80e030e31229";
const WS_REF = "ws_3KF9TQ2P";

/** A MEMBERSHIP_WORKER fetcher that records calls and returns a canned resolution. */
function membershipMock(resolution: { orgId: string } | null): {
  fetcher: Fetcher;
  calls: Array<{ url: string; ref: string }>;
} {
  const calls: Array<{ url: string; ref: string }> = [];
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? (JSON.parse(init.body as string) as { ref: string }) : { ref: "" };
      calls.push({ url, ref: body.ref });
      if (!resolution) {
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      return Response.json({ data: { orgId: resolution.orgId, slug: "acme", publicRef: WS_REF } });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function envWith(fetcher: Fetcher): Env {
  return { ENVIRONMENT: "test", MEMBERSHIP_WORKER: fetcher } as unknown as Env;
}

function reqFor(pathname: string): Request {
  return new Request(`https://api.test${pathname}`, { method: "GET" });
}

const deps = { cache: noopStore() };

describe("isOrgScopedPath / extractOrgSegment", () => {
  it("is true only when there is an id segment", () => {
    expect(isOrgScopedPath("/v1/organizations")).toBe(false);
    expect(isOrgScopedPath("/v1/organizations/")).toBe(false);
    expect(isOrgScopedPath(`/v1/organizations/${ORG_PUB}`)).toBe(true);
    expect(isOrgScopedPath(`/v1/organizations/${WS_REF}/projects`)).toBe(true);
    expect(isOrgScopedPath("/v1/projects")).toBe(false);
  });

  it("extracts the {seg} segment", () => {
    expect(extractOrgSegment(`/v1/organizations/${WS_REF}`)).toBe(WS_REF);
    expect(extractOrgSegment(`/v1/organizations/${WS_REF}/members/mem_1`)).toBe(WS_REF);
  });
});

describe("resolveOrgRefInPath (WID3)", () => {
  it("passes an org_<hex> segment through with NO membership call", async () => {
    const { fetcher, calls } = membershipMock({ orgId: ORG_PUB });
    const path = `/v1/organizations/${ORG_PUB}/projects`;
    const out = await resolveOrgRefInPath(path, reqFor(path), envWith(fetcher), "req", deps);
    expect(out).not.toBe(ORG_REF_NOT_FOUND);
    if (out === ORG_REF_NOT_FOUND) return;
    expect(out.pathname).toBe(path);
    expect(calls).toHaveLength(0);
  });

  it("leaves the bare /v1/organizations collection untouched (no segment)", async () => {
    const { fetcher, calls } = membershipMock({ orgId: ORG_PUB });
    const out = await resolveOrgRefInPath(
      "/v1/organizations",
      reqFor("/v1/organizations"),
      envWith(fetcher),
      "req",
      deps,
    );
    if (out === ORG_REF_NOT_FOUND) throw new Error("unexpected 404");
    expect(out.pathname).toBe("/v1/organizations");
    expect(calls).toHaveLength(0);
  });

  it("rewrites a ws_ segment to the canonical org_<hex>", async () => {
    const { fetcher, calls } = membershipMock({ orgId: ORG_PUB });
    const path = `/v1/organizations/${WS_REF}/members`;
    const out = await resolveOrgRefInPath(path, reqFor(path), envWith(fetcher), "req", deps);
    if (out === ORG_REF_NOT_FOUND) throw new Error("unexpected 404");
    expect(out.pathname).toBe(`/v1/organizations/${ORG_PUB}/members`);
    expect(new URL(out.request.url).pathname).toBe(`/v1/organizations/${ORG_PUB}/members`);
    expect(calls).toEqual([
      { url: "http://membership-worker/v1/internal/membership/resolve-org-ref", ref: WS_REF },
    ]);
  });

  it("rewrites a slug segment to the canonical org_<hex>", async () => {
    const { fetcher, calls } = membershipMock({ orgId: ORG_PUB });
    const path = "/v1/organizations/acme/projects";
    const out = await resolveOrgRefInPath(path, reqFor(path), envWith(fetcher), "req", deps);
    if (out === ORG_REF_NOT_FOUND) throw new Error("unexpected 404");
    expect(out.pathname).toBe(`/v1/organizations/${ORG_PUB}/projects`);
    expect(calls[0]!.ref).toBe("acme");
  });

  it("returns the NOT_FOUND sentinel for an unresolvable ref", async () => {
    const { fetcher } = membershipMock(null);
    const path = "/v1/organizations/ghost/projects";
    const out = await resolveOrgRefInPath(path, reqFor(path), envWith(fetcher), "req", deps);
    expect(out).toBe(ORG_REF_NOT_FOUND);
  });
});

// The /v1/workspaces/ws_… end-to-end path is exercised by composing the same
// rewrite index.ts applies: workspace rewrite first, then org-ref resolution on
// the resulting /v1/organizations/{seg} path.
import { isWorkspaceAliasRoute, rewriteWorkspacePath, rewriteToOrgRequest } from "@api-edge/workspace-facade";

describe("workspace alias + org-ref resolution (end-to-end)", () => {
  it("resolves /v1/workspaces/ws_… through to /v1/organizations/org_<hex>", async () => {
    const { fetcher, calls } = membershipMock({ orgId: ORG_PUB });
    const wsPath = `/v1/workspaces/${WS_REF}/members`;
    expect(isWorkspaceAliasRoute(wsPath)).toBe(true);

    const aliasedPath = rewriteWorkspacePath(wsPath);
    expect(aliasedPath).toBe(`/v1/organizations/${WS_REF}/members`);
    const aliasedReq = rewriteToOrgRequest(reqFor(wsPath), aliasedPath);

    const out = await resolveOrgRefInPath(aliasedPath, aliasedReq, envWith(fetcher), "req", deps);
    if (out === ORG_REF_NOT_FOUND) throw new Error("unexpected 404");
    expect(out.pathname).toBe(`/v1/organizations/${ORG_PUB}/members`);
    expect(calls[0]!.ref).toBe(WS_REF);
  });
});
