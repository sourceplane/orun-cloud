import {
  handleCreateWorkspaceLink,
  handleResolveWorkspaceLinks,
} from "@state-worker/handlers/links";
import type { Env } from "@state-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_UUID = "22222222-2222-4222-8222-222222222222";
const PROJECT_UUID = "44444444-4444-4444-8444-444444444444";
const LINK_UUID = "55555555-5555-4555-8555-555555555555";
const ORG_PUBLIC = `org_${ORG_UUID.replace(/-/g, "")}`;
const PROJECT_PUBLIC = `prj_${PROJECT_UUID.replace(/-/g, "")}`;
const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };
const NOW = new Date("2026-06-14T10:00:00Z");

type QueryRecord = { text: string; params: unknown[] };

function fakeExecutor(
  respond: (text: string, params: unknown[]) => Record<string, unknown>[] | null,
): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { executor, queries };
}

/** A projects-worker fetcher whose resolve/create behavior is configurable. */
interface ProjectsBehavior {
  // resolve by slug result: null = miss, object = hit
  resolveSlug?: { id: string; slug: string; name: string; status: string } | null;
  // resolve by projectId result (used by resolve endpoint projection)
  resolveById?: { id: string; slug: string; name: string; status: string } | null;
  // create result
  createStatus?: number;
  createProject?: { id: string; slug: string; name: string; status: string };
}

function membershipFetcher(opts: {
  allow?: boolean;
  orgs?: Array<{ id: string; slug: string; name: string; role: string }>;
  contextOk?: boolean;
}): Fetcher {
  return {
    fetch: (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("authorization-context")) {
        if (opts.contextOk === false) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        return Promise.resolve(
          Response.json({
            data: {
              memberships: [
                { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_PUBLIC } },
              ],
            },
          }),
        );
      }
      if (url.includes("subject-orgs")) {
        return Promise.resolve(Response.json({ data: { orgs: opts.orgs ?? [] } }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function policyFetcher(allow: boolean): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json({ data: { allow } })),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function projectsFetcher(behavior: ProjectsBehavior): Fetcher {
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/internal/projects/resolve") {
        const byId = url.searchParams.get("projectId");
        if (byId) {
          return Promise.resolve(
            Response.json({ data: { project: behavior.resolveById ?? null } }),
          );
        }
        return Promise.resolve(
          Response.json({ data: { project: behavior.resolveSlug ?? null } }),
        );
      }
      // POST .../projects (create)
      if (url.pathname.endsWith("/projects") && init?.method === "POST") {
        const status = behavior.createStatus ?? 201;
        if (status >= 400) {
          return Promise.resolve(Response.json({ error: { code: "x" } }, { status }));
        }
        return Promise.resolve(
          Response.json(
            { data: { project: behavior.createProject ?? { id: PROJECT_PUBLIC, slug: "platform", name: "platform", status: "active" } } },
            { status },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createEnv(over: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    ...over,
  } as unknown as Env;
}

function workspaceLinkRow(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: LINK_UUID,
    org_id: ORG_UUID,
    project_id: PROJECT_UUID,
    remote_url: "github.com/acme/platform",
    status: "active",
    created_by: ACTOR.subjectId,
    created_by_kind: "user",
    last_seen_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  };
}

function createRequest(body: Record<string, unknown>): Request {
  return new Request("https://state.test/v1/organizations/x/cli/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ORG_ENTRY = { id: ORG_PUBLIC, slug: "acme", name: "Acme", role: "admin" };

describe("POST /v1/organizations/{orgId}/cli/links", () => {
  it("creates a link, creating the project on demand when absent", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("INSERT INTO state.workspace_links")) return [workspaceLinkRow()];
      return [{ _event: {}, _audit: {} }];
    });
    const env = createEnv({
      MEMBERSHIP_WORKER: membershipFetcher({ allow: true, orgs: [ORG_ENTRY] }),
      POLICY_WORKER: policyFetcher(true),
      PROJECTS_WORKER: projectsFetcher({
        resolveSlug: null, // not found → create
        createStatus: 201,
        createProject: { id: PROJECT_PUBLIC, slug: "platform", name: "platform", status: "active" },
      }),
    });
    const res = await handleCreateWorkspaceLink(
      createRequest({ remoteUrl: "git@github.com:acme/platform.git", projectSlug: "platform" }),
      env,
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { link: { orgId: string; orgSlug: string; projectId: string; projectSlug: string; remoteUrl: string } };
      meta: { requestId: string };
    };
    expect(body.data.link.orgId).toBe(ORG_PUBLIC);
    expect(body.data.link.orgSlug).toBe("acme");
    expect(body.data.link.projectId).toBe(PROJECT_PUBLIC);
    expect(body.data.link.projectSlug).toBe("platform");
    expect(body.data.link.remoteUrl).toBe("github.com/acme/platform");
    expect(body.meta.requestId).toBe("req_1");
    // org.cli.linked emitted to the event log.
    expect(queries.some((q) => q.text.includes("events.event_log"))).toBe(true);
  });

  it("persists and surfaces rename-stable provider identity (OV2.1)", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("INSERT INTO state.workspace_links")) {
        return [
          workspaceLinkRow({
            provider: "github",
            provider_repo_id: "123456",
            provider_owner_id: "789",
            provider_owner_login: "acme",
          }),
        ];
      }
      return [{ _event: {}, _audit: {} }];
    });
    const env = createEnv({
      MEMBERSHIP_WORKER: membershipFetcher({ allow: true, orgs: [ORG_ENTRY] }),
      POLICY_WORKER: policyFetcher(true),
      PROJECTS_WORKER: projectsFetcher({
        resolveSlug: { id: PROJECT_PUBLIC, slug: "platform", name: "platform", status: "active" },
      }),
    });
    const res = await handleCreateWorkspaceLink(
      createRequest({
        remoteUrl: "git@github.com:acme/platform.git",
        projectSlug: "platform",
        provider: "github",
        providerRepoId: "123456",
        providerOwnerId: "789",
        providerOwnerLogin: "acme",
      }),
      env,
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        link: {
          provider: string | null;
          providerRepoId: string | null;
          providerOwnerId: string | null;
          providerOwnerLogin: string | null;
        };
      };
    };
    expect(body.data.link.provider).toBe("github");
    expect(body.data.link.providerRepoId).toBe("123456");
    expect(body.data.link.providerOwnerId).toBe("789");
    expect(body.data.link.providerOwnerLogin).toBe("acme");
    // The INSERT carried the rename-stable identity into the row.
    const insert = queries.find((q) => q.text.includes("INSERT INTO state.workspace_links"));
    expect(insert?.params).toContain("github");
    expect(insert?.params).toContain("123456");
  });

  it("reuses an existing project when the slug already resolves", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("INSERT INTO state.workspace_links")) return [workspaceLinkRow()];
      return [{ _event: {}, _audit: {} }];
    });
    let createCalled = false;
    const projects: Fetcher = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/internal/projects/resolve") {
          return Promise.resolve(
            Response.json({ data: { project: { id: PROJECT_PUBLIC, slug: "platform", name: "platform", status: "active" } } }),
          );
        }
        if (init?.method === "POST") {
          createCalled = true;
          return Promise.resolve(Response.json({ data: { project: {} } }, { status: 201 }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      },
      connect() {
        throw new Error("x");
      },
    } as unknown as Fetcher;

    const res = await handleCreateWorkspaceLink(
      createRequest({ remoteUrl: "https://github.com/acme/platform.git" }),
      createEnv({
        MEMBERSHIP_WORKER: membershipFetcher({ allow: true, orgs: [ORG_ENTRY] }),
        POLICY_WORKER: policyFetcher(true),
        PROJECTS_WORKER: projects,
      }),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor },
    );
    expect(res.status).toBe(201);
    expect(createCalled).toBe(false); // resolved, never created
  });

  // Regression: state-worker must send the BARE UUID (not the `org_<hex>`
  // public form) to membership-worker's /authorization-context. The handler
  // calls `asUuid(req.orgId)` and throws on non-canonical input; that surfaced
  // as a 500 → 404 → CLI "not authorized to link…" with the user holding the
  // `org.cli.link` grant. The policy resource must use the same format the
  // facts carry (policy-engine matches by string equality) — both are UUIDs.
  it("sends bare UUIDs (not public ids) to membership-worker and policy-worker", async () => {
    const membershipBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const membership: Fetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        membershipBodies.push({ url, body });
        if (url.includes("authorization-context")) {
          return Response.json({
            data: {
              memberships: [
                { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_UUID } },
              ],
            },
          });
        }
        if (url.includes("subject-orgs")) {
          return Response.json({ data: { orgs: [ORG_ENTRY] } });
        }
        return new Response(null, { status: 404 });
      },
      connect() { throw new Error("x"); },
    } as unknown as Fetcher;
    const policyBodies: Array<Record<string, unknown>> = [];
    const policy: Fetcher = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        policyBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ data: { allow: true } });
      },
      connect() { throw new Error("x"); },
    } as unknown as Fetcher;

    const { executor } = fakeExecutor((text) => {
      if (text.includes("INSERT INTO state.workspace_links")) return [workspaceLinkRow()];
      return [{ _event: {}, _audit: {} }];
    });
    const res = await handleCreateWorkspaceLink(
      createRequest({ remoteUrl: "git@github.com:acme/platform.git" }),
      createEnv({
        MEMBERSHIP_WORKER: membership,
        POLICY_WORKER: policy,
        PROJECTS_WORKER: projectsFetcher({ resolveSlug: { id: PROJECT_PUBLIC, slug: "platform", name: "platform", status: "active" } }),
      }),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor },
    );
    expect(res.status).toBe(201);

    const ctxCall = membershipBodies.find((b) => b.url.includes("authorization-context"));
    expect(ctxCall).toBeDefined();
    // The canary: must be the bare UUID, NOT the `org_<hex>` public form.
    expect(ctxCall!.body.orgId).toBe(ORG_UUID);
    expect(ctxCall!.body.orgId).not.toMatch(/^org_/);

    const policyCall = policyBodies[0];
    expect(policyCall).toBeDefined();
    expect((policyCall!.resource as { orgId: string }).orgId).toBe(ORG_UUID);
    expect((policyCall!.resource as { orgId: string }).orgId).not.toMatch(/^org_/);
  });

  it("returns a safe 404 when policy denies org.cli.link (resource hiding)", async () => {
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleCreateWorkspaceLink(
      createRequest({ remoteUrl: "git@github.com:acme/platform.git" }),
      createEnv({
        MEMBERSHIP_WORKER: membershipFetcher({ orgs: [ORG_ENTRY] }),
        POLICY_WORKER: policyFetcher(false),
        PROJECTS_WORKER: projectsFetcher({}),
      }),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor },
    );
    expect(res.status).toBe(404);
    expect(queries).toHaveLength(0); // denied before any DB write
  });

  it("returns 404 when the actor is not a member (context fails)", async () => {
    const { executor } = fakeExecutor(() => []);
    const res = await handleCreateWorkspaceLink(
      createRequest({ remoteUrl: "git@github.com:acme/platform.git" }),
      createEnv({
        MEMBERSHIP_WORKER: membershipFetcher({ contextOk: false }),
        POLICY_WORKER: policyFetcher(true),
        PROJECTS_WORKER: projectsFetcher({}),
      }),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor },
    );
    expect(res.status).toBe(404);
  });

  it("returns 422 for an unparseable remote URL", async () => {
    const { executor } = fakeExecutor(() => []);
    const res = await handleCreateWorkspaceLink(
      createRequest({ remoteUrl: "not a remote" }),
      createEnv({
        MEMBERSHIP_WORKER: membershipFetcher({ allow: true, orgs: [ORG_ENTRY] }),
        POLICY_WORKER: policyFetcher(true),
        PROJECTS_WORKER: projectsFetcher({}),
      }),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor },
    );
    expect(res.status).toBe(422);
  });

  it("maps a project.create 404 (lacking project.create) to a safe 404", async () => {
    const { executor } = fakeExecutor(() => []);
    const res = await handleCreateWorkspaceLink(
      createRequest({ remoteUrl: "git@github.com:acme/platform.git" }),
      createEnv({
        MEMBERSHIP_WORKER: membershipFetcher({ allow: true, orgs: [ORG_ENTRY] }),
        POLICY_WORKER: policyFetcher(true),
        PROJECTS_WORKER: projectsFetcher({ resolveSlug: null, createStatus: 404 }),
      }),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/cli/links/resolve", () => {
  function resolveRequest(remoteUrl: string): Request {
    const u = new URL("https://state.test/v1/cli/links/resolve");
    u.searchParams.set("remoteUrl", remoteUrl);
    return new Request(u.toString(), { method: "GET" });
  }

  it("returns only candidates in orgs the actor belongs to", async () => {
    // Two active links for the remote: one in the actor's org, one in another.
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM state.workspace_links")) {
        return [
          workspaceLinkRow({ id: LINK_UUID, org_id: ORG_UUID }),
          workspaceLinkRow({ id: "66666666-6666-4666-8666-666666666666", org_id: OTHER_ORG_UUID }),
        ];
      }
      return [];
    });
    const res = await handleResolveWorkspaceLinks(
      resolveRequest("git@github.com:acme/platform.git"),
      createEnv({
        // The actor is only in ORG, not OTHER_ORG.
        MEMBERSHIP_WORKER: membershipFetcher({ orgs: [ORG_ENTRY] }),
        PROJECTS_WORKER: projectsFetcher({
          resolveById: { id: PROJECT_PUBLIC, slug: "platform", name: "platform", status: "active" },
        }),
      }),
      "req_1",
      ACTOR,
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { candidates: Array<{ orgId: string; projectSlug: string }>; links: unknown[] };
    };
    expect(body.data.candidates).toHaveLength(1);
    expect(body.data.candidates[0]!.orgId).toBe(ORG_PUBLIC);
    expect(body.data.candidates[0]!.projectSlug).toBe("platform");
    expect(body.data.links).toHaveLength(1);
  });

  it("returns an empty candidate set when the actor shares no org with any link", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM state.workspace_links")) {
        return [workspaceLinkRow({ org_id: OTHER_ORG_UUID })];
      }
      return [];
    });
    const res = await handleResolveWorkspaceLinks(
      resolveRequest("git@github.com:acme/platform.git"),
      createEnv({
        MEMBERSHIP_WORKER: membershipFetcher({ orgs: [ORG_ENTRY] }),
        PROJECTS_WORKER: projectsFetcher({}),
      }),
      "req_1",
      ACTOR,
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { candidates: unknown[] } };
    expect(body.data.candidates).toHaveLength(0);
  });

  it("returns 422 for a bad remoteUrl query", async () => {
    const { executor } = fakeExecutor(() => []);
    const res = await handleResolveWorkspaceLinks(
      resolveRequest("garbage"),
      createEnv({ MEMBERSHIP_WORKER: membershipFetcher({ orgs: [ORG_ENTRY] }) }),
      "req_1",
      ACTOR,
      { executor },
    );
    expect(res.status).toBe(422);
  });
});
