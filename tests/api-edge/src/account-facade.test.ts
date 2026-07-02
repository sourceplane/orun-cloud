import { isAccountAggregateRoute, handleAccountAggregateRoute } from "@api-edge/account-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createSessionFetcher(userId: string): Fetcher {
  return {
    fetch(input: string | Request | URL): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/auth/resolve")) {
        return Promise.resolve(
          Response.json({
            data: {
              actor: { actorType: "user", actorId: userId, email: "user@test.com" },
              session: { id: "ses_abc", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
              user: { id: userId, email: "user@test.com", displayName: "Test" },
            },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: {}, meta: { requestId: "req_test", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

/** Membership fake: serves the org DTO and the child-workspace list. */
function createMembershipFetcher(opts: {
  self?: { id: string; workspaceRef: string; name: string };
  children?: Array<{ orgId: string; workspaceRef: string; name: string }>;
  workspacesStatus?: number;
}): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("/workspaces")) {
        if (opts.workspacesStatus) {
          return Promise.resolve(Response.json({ error: { code: "not_found" } }, { status: opts.workspacesStatus }));
        }
        return Promise.resolve(
          Response.json({ data: { workspaces: opts.children ?? [] }, meta: { requestId: "r", cursor: null } }),
        );
      }
      return Promise.resolve(
        Response.json({
          data: { organization: opts.self ?? { id: "org_root", workspaceRef: "ws_ROOT", name: "Root" } },
          meta: { requestId: "r", cursor: null },
        }),
      );
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

/** State fake: per-org responses keyed by org id, with in-flight tracking. */
function createStateFetcher(opts: {
  perOrg?: Record<string, Response | (() => Response)>;
  delayMs?: number;
}): { fetcher: Fetcher; calls: FetchCall[]; maxInFlight: () => number } {
  const calls: FetchCall[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetcher = {
    async fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      inFlight -= 1;
      const m = url.match(/\/v1\/organizations\/([^/]+)\//);
      const key = m?.[1] ?? "";
      const custom = opts.perOrg?.[key];
      if (custom) return typeof custom === "function" ? custom() : custom.clone();
      return Response.json({ data: { entities: [{ ref: `ent-${key}` }], runs: [{ id: `run-${key}` }] }, meta: { requestId: "r", cursor: null } });
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls, maxInFlight: () => peak };
}

function makeEnv(overrides: Partial<Record<string, Fetcher>>): never {
  return {
    ENVIRONMENT: "test",
    IDENTITY_WORKER: createSessionFetcher("usr_abc123"),
    ...overrides,
  } as never;
}

function makeRequest(path: string): Request {
  return new Request(`https://api.example.com${path}`, {
    method: "GET",
    headers: { authorization: "Bearer sps_ses_abc.secret" },
  });
}

describe("api-edge account aggregate facade (teams-hub TH2)", () => {
  describe("isAccountAggregateRoute", () => {
    it("matches account-catalog and account-runs", () => {
      expect(isAccountAggregateRoute("/v1/organizations/org_abc/account-catalog")).toBe(true);
      expect(isAccountAggregateRoute("/v1/organizations/org_abc/account-runs")).toBe(true);
    });
    it("does not match other org routes", () => {
      expect(isAccountAggregateRoute("/v1/organizations/org_abc/account-roles")).toBe(false);
      expect(isAccountAggregateRoute("/v1/organizations/org_abc/catalog/entities")).toBe(false);
    });
  });

  it("fans out over {self} ∪ children, tagging rows with their workspace", async () => {
    const membership = createMembershipFetcher({
      self: { id: "org_root", workspaceRef: "ws_ROOT", name: "Root" },
      children: [
        { orgId: "org_c1", workspaceRef: "ws_C1", name: "Payments" },
        { orgId: "org_c2", workspaceRef: "ws_C2", name: "Search" },
      ],
    });
    const state = createStateFetcher({});
    const res = await handleAccountAggregateRoute(
      makeRequest("/v1/organizations/org_root/account-catalog"),
      makeEnv({ MEMBERSHIP_WORKER: membership.fetcher, STATE_WORKER: state.fetcher }),
      "req_t",
      "/v1/organizations/org_root/account-catalog",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { workspaces: Array<{ workspace: { orgId: string }; status: string; entities: unknown[] }>; truncated: boolean } };
    expect(body.data.truncated).toBe(false);
    expect(body.data.workspaces.map((w) => w.workspace.orgId)).toEqual(["org_root", "org_c1", "org_c2"]);
    expect(body.data.workspaces.every((w) => w.status === "ok")).toBe(true);
    expect(body.data.workspaces[1]!.entities).toEqual([{ ref: "ent-org_c1" }]);
    // Per-workspace reads hit each org's own authorized endpoint.
    expect(state.calls.map((c) => c.url)).toEqual([
      "https://state.internal/v1/organizations/org_root/catalog/entities",
      "https://state.internal/v1/organizations/org_c1/catalog/entities",
      "https://state.internal/v1/organizations/org_c2/catalog/entities",
    ]);
  });

  it("account-runs reads each workspace's /state/runs and forwards the query", async () => {
    const membership = createMembershipFetcher({
      children: [{ orgId: "org_c1", workspaceRef: "ws_C1", name: "Payments" }],
    });
    const state = createStateFetcher({});
    const res = await handleAccountAggregateRoute(
      makeRequest("/v1/organizations/org_root/account-runs?status=running&limit=5"),
      makeEnv({ MEMBERSHIP_WORKER: membership.fetcher, STATE_WORKER: state.fetcher }),
      "req_t",
      "/v1/organizations/org_root/account-runs",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { workspaces: Array<{ runs: unknown[] }> } };
    expect(body.data.workspaces[0]!.runs).toEqual([{ id: "run-org_root" }]);
    expect(state.calls.map((c) => c.url)).toEqual([
      "https://state.internal/v1/organizations/org_root/state/runs?status=running&limit=5",
      "https://state.internal/v1/organizations/org_c1/state/runs?status=running&limit=5",
    ]);
  });

  it("reports a denied workspace as denied (TH-C) without failing the aggregate", async () => {
    const membership = createMembershipFetcher({
      children: [
        { orgId: "org_secret", workspaceRef: "ws_S", name: "Restricted" },
        { orgId: "org_open", workspaceRef: "ws_O", name: "Open" },
      ],
    });
    const state = createStateFetcher({
      perOrg: {
        org_secret: () => Response.json({ error: { code: "not_found" } }, { status: 404 }),
        org_flaky: () => Response.json({ error: { code: "internal_error" } }, { status: 503 }),
      },
    });
    const res = await handleAccountAggregateRoute(
      makeRequest("/v1/organizations/org_root/account-catalog"),
      makeEnv({ MEMBERSHIP_WORKER: membership.fetcher, STATE_WORKER: state.fetcher }),
      "req_t",
      "/v1/organizations/org_root/account-catalog",
    );
    const body = (await res.json()) as { data: { workspaces: Array<{ workspace: { orgId: string }; status: string; entities: unknown[] }> } };
    const secret = body.data.workspaces.find((w) => w.workspace.orgId === "org_secret")!;
    expect(secret.status).toBe("denied");
    expect(secret.entities).toEqual([]);
    const open = body.data.workspaces.find((w) => w.workspace.orgId === "org_open")!;
    expect(open.status).toBe("ok");
  });

  it("bounds fan-out concurrency and caps the workspace set (TH-B)", async () => {
    const children = Array.from({ length: 30 }, (_, i) => ({
      orgId: `org_c${i}`,
      workspaceRef: `ws_C${i}`,
      name: `W${i}`,
    }));
    const membership = createMembershipFetcher({ children });
    const state = createStateFetcher({ delayMs: 5 });
    const res = await handleAccountAggregateRoute(
      makeRequest("/v1/organizations/org_root/account-catalog"),
      makeEnv({ MEMBERSHIP_WORKER: membership.fetcher, STATE_WORKER: state.fetcher }),
      "req_t",
      "/v1/organizations/org_root/account-catalog",
    );
    const body = (await res.json()) as { data: { workspaces: unknown[]; truncated: boolean } };
    expect(body.data.truncated).toBe(true);
    expect(body.data.workspaces).toHaveLength(20);
    expect(state.calls).toHaveLength(20);
    expect(state.maxInFlight()).toBeLessThanOrEqual(4);
  });

  it("mirrors a 404 from the workspace-set read (account not visible to the caller)", async () => {
    const membership = createMembershipFetcher({ workspacesStatus: 404 });
    const state = createStateFetcher({});
    const res = await handleAccountAggregateRoute(
      makeRequest("/v1/organizations/org_hidden/account-catalog"),
      makeEnv({ MEMBERSHIP_WORKER: membership.fetcher, STATE_WORKER: state.fetcher }),
      "req_t",
      "/v1/organizations/org_hidden/account-catalog",
    );
    expect(res.status).toBe(404);
    expect(state.calls).toHaveLength(0);
  });

  it("405s non-GET", async () => {
    const membership = createMembershipFetcher({});
    const state = createStateFetcher({});
    const res = await handleAccountAggregateRoute(
      new Request("https://api.example.com/v1/organizations/org_root/account-catalog", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      }),
      makeEnv({ MEMBERSHIP_WORKER: membership.fetcher, STATE_WORKER: state.fetcher }),
      "req_t",
      "/v1/organizations/org_root/account-catalog",
    );
    expect(res.status).toBe(405);
  });
});
