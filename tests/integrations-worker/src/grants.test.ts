import {
  handleCreateConnectionGrant,
  handleListConnectionGrants,
  handleRevokeConnectionGrant,
  handleUpdateConnection,
} from "@integrations-worker/handlers/grants";
import type { Env } from "@integrations-worker/env";
import { orgPublicId } from "@integrations-worker/ids";
import { asUuid } from "@saas/db/ids";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ACCOUNT_UUID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_UUID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-06-11T10:00:00Z");
const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

type QueryRecord = { text: string; params: unknown[] };

function fakeExecutor(
  respond: (text: string, params: unknown[]) => Record<string, unknown>[] | null,
): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { executor, queries };
}

function jsonFetcher(body: unknown): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json(body)),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createEnv(allow = true): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: jsonFetcher({
      data: {
        memberships: [
          { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ACCOUNT_UUID } },
        ],
      },
    }),
    POLICY_WORKER: jsonFetcher({ data: { allow, reason: allow ? "org_admin" : "denied" } }),
  } as unknown as Env;
}

function connectionRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ACCOUNT_UUID,
    provider: "github",
    status: "active",
    scope: "account",
    share_mode: "auto",
    display_name: "acme",
    external_account_login: "acme",
    external_account_id: "42",
    external_account_type: "Organization",
    created_by: null,
    state_expires_at: null,
    connected_at: NOW.toISOString(),
    suspended_at: null,
    revoked_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function grantRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "grant1",
    connection_id: CONNECTION_UUID,
    org_id: WORKSPACE_UUID,
    granted_by: "usr_admin",
    status: "active",
    granted_at: NOW.toISOString(),
    revoked_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function grantBody(workspaceOrgId: string): Request {
  return new Request("https://worker.test/grants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceOrgId }),
  });
}

describe("connection grant management (IT8b)", () => {
  it("lists a connection's grants for an account admin", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections WHERE org_id")) return [connectionRow()];
      if (text.includes("FROM integrations.connection_grants")) return [grantRow()];
      return [];
    });
    const res = await handleListConnectionGrants(
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ACCOUNT_UUID),
      asUuid(CONNECTION_UUID),
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { grants: Array<{ workspaceOrgId: string; status: string }> } };
    expect(body.data.grants).toHaveLength(1);
    expect(body.data.grants[0]!.status).toBe("active");
    expect(body.data.grants[0]!.workspaceOrgId).toBe(orgPublicId(WORKSPACE_UUID));
  });

  it("admits a workspace (create grant) → 201", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections WHERE org_id")) return [connectionRow()];
      if (text.includes("INSERT INTO integrations.connection_grants")) return [grantRow()];
      return [];
    });
    const res = await handleCreateConnectionGrant(
      grantBody(orgPublicId(WORKSPACE_UUID)),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ACCOUNT_UUID),
      asUuid(CONNECTION_UUID),
      { executor },
    );
    expect(res.status).toBe(201);
    const insert = queries.find((q) => q.text.includes("INSERT INTO integrations.connection_grants"));
    expect(insert!.params).toContain(WORKSPACE_UUID);
  });

  it("rejects a duplicate admission with 409 already_granted", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections WHERE org_id")) return [connectionRow()];
      if (text.includes("INSERT INTO integrations.connection_grants")) {
        throw { code: "23505", constraint: "uq_integrations_connection_grant_active" };
      }
      return [];
    });
    const res = await handleCreateConnectionGrant(
      grantBody(orgPublicId(WORKSPACE_UUID)),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ACCOUNT_UUID),
      asUuid(CONNECTION_UUID),
      { executor },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("already_granted");
  });

  it("refuses to grant on a workspace-private connection (412)", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections WHERE org_id"))
        return [connectionRow({ scope: "workspace" })];
      return [];
    });
    const res = await handleCreateConnectionGrant(
      grantBody(orgPublicId(WORKSPACE_UUID)),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ACCOUNT_UUID),
      asUuid(CONNECTION_UUID),
      { executor },
    );
    expect(res.status).toBe(412);
  });

  it("revokes a grant; 404 when none is active", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections WHERE org_id")) return [connectionRow()];
      if (text.includes("UPDATE integrations.connection_grants")) return []; // nothing active
      return [];
    });
    const res = await handleRevokeConnectionGrant(
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ACCOUNT_UUID),
      asUuid(CONNECTION_UUID),
      asUuid(WORKSPACE_UUID),
      { executor },
    );
    expect(res.status).toBe(404);
  });

  it("switches share mode to 'granted' → 200", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections WHERE org_id")) return [connectionRow()];
      if (text.includes("SET share_mode")) return [connectionRow({ share_mode: "granted" })];
      return [];
    });
    const res = await handleUpdateConnection(
      new Request("https://worker.test/c", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shareMode: "granted" }),
      }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ACCOUNT_UUID),
      asUuid(CONNECTION_UUID),
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connection: { shareMode: string } } };
    expect(body.data.connection.shareMode).toBe("granted");
    expect(queries.some((q) => q.text.includes("SET share_mode"))).toBe(true);
  });

  it("rejects an invalid share mode with 422", async () => {
    const { executor } = fakeExecutor(() => [connectionRow()]);
    const res = await handleUpdateConnection(
      new Request("https://worker.test/c", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shareMode: "bogus" }),
      }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ACCOUNT_UUID),
      asUuid(CONNECTION_UUID),
      { executor },
    );
    expect(res.status).toBe(422);
  });

  it("denies a non-admin via policy as 404 (no resource disclosure)", async () => {
    const { executor, queries } = fakeExecutor(() => [connectionRow()]);
    const res = await handleListConnectionGrants(
      createEnv(false),
      "req_1",
      ACTOR,
      asUuid(ACCOUNT_UUID),
      asUuid(CONNECTION_UUID),
      { executor },
    );
    expect(res.status).toBe(404);
    expect(queries).toHaveLength(0); // denied before any DB touch
  });
});
