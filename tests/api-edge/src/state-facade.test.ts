// api-edge state-facade — OP2 run-coordination routing. The edge authenticates
// the bearer, forwards the actor + the Orun-Contract-Version header to
// state-worker (which re-checks policy + the version), and proxies the response.

import { isStateRoute, handleStateRoute } from "@api-edge/state-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createDownstream(response: Response): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(response.clone());
    },
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function sessionFetcher(): Fetcher {
  return {
    fetch(input: string | Request | URL): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/auth/resolve")) {
        return Promise.resolve(
          Response.json({
            data: {
              actor: { actorType: "user", actorId: "usr_abc", email: "u@test.com" },
              session: { id: "ses_1" },
              user: { id: "usr_abc", email: "u@test.com", displayName: "U" },
            },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: {}, meta: { requestId: "r", cursor: null } }));
    },
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
}

const RUNS_PATH = "/v1/organizations/org_x/projects/prj_y/state/runs";

describe("state facade — route matching", () => {
  it("matches the run-coordination plane under /state/", () => {
    expect(isStateRoute(RUNS_PATH)).toBe(true);
    expect(isStateRoute(`${RUNS_PATH}/01J0/jobs/build/claim`)).toBe(true);
    expect(isStateRoute("/v1/organizations/org_x/projects/prj_y/state/runs/01J0/runnable")).toBe(true);
  });

  it("still matches the OP4 workspace-link routes", () => {
    expect(isStateRoute("/v1/cli/links/resolve")).toBe(true);
    expect(isStateRoute("/v1/organizations/org_x/cli/links")).toBe(true);
    expect(isStateRoute("/v1/organizations/org_x/projects/prj_y/cli/links")).toBe(true);
  });

  it("does not match unrelated project routes", () => {
    expect(isStateRoute("/v1/organizations/org_x/projects/prj_y/environments")).toBe(false);
    expect(isStateRoute("/v1/organizations/org_x/projects/prj_y")).toBe(false);
  });
});

describe("state facade — forwarding", () => {
  it("401s without a bearer", async () => {
    const { fetcher, calls } = createDownstream(Response.json({ data: {} }));
    const env = { IDENTITY_WORKER: sessionFetcher(), STATE_WORKER: fetcher, ENVIRONMENT: "test" };
    const res = await handleStateRoute(
      new Request(`https://edge.test${RUNS_PATH}`, { method: "GET" }),
      env as never,
      "req_1",
      RUNS_PATH,
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("forwards actor + Orun-Contract-Version to state-worker, preserving path", async () => {
    const { fetcher, calls } = createDownstream(
      Response.json({ data: { runs: [], nextCursor: null }, meta: { requestId: "req_inner", cursor: null } }),
    );
    const env = { IDENTITY_WORKER: sessionFetcher(), STATE_WORKER: fetcher, ENVIRONMENT: "test" };
    const res = await handleStateRoute(
      new Request(`https://edge.test${RUNS_PATH}?status=running`, {
        method: "GET",
        headers: { authorization: "Bearer tok_123", "orun-contract-version": "1" },
      }),
      env as never,
      "req_1",
      RUNS_PATH,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("x-actor-subject-id")).toBe("usr_abc");
    expect(headers.get("x-actor-subject-type")).toBe("user");
    expect(headers.get("orun-contract-version")).toBe("1");
    expect(calls[0]!.url).toContain("/state/runs");
    expect(calls[0]!.url).toContain("status=running");
  });
});
