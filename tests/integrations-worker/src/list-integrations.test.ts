import { handleListIntegrations } from "@integrations-worker/handlers/connections";
import type { Env } from "@integrations-worker/env";
import { asUuid } from "@saas/db/ids";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const WORKSPACE_UUID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_UUID = "11111111-1111-4111-8111-111111111111";
const OWN_CONN = "33333333-3333-4333-8333-333333333333";
const ACCT_CONN = "44444444-4444-4444-8444-444444444444";
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

/** Membership fetcher that answers BOTH the auth-context and integration-parent calls. */
function membershipFetcher(parent: { isChild: boolean; account: unknown }): Fetcher {
  return {
    fetch: (input: string) => {
      if (String(input).includes("/integration-parent")) {
        return Promise.resolve(Response.json({ data: parent }));
      }
      // authorization-context
      return Promise.resolve(
        Response.json({
          data: {
            memberships: [
              { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: WORKSPACE_UUID } },
            ],
          },
        }),
      );
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function policyFetcher(allow = true): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json({ data: { allow, reason: allow ? "ok" : "no" } })),
    connect() {
      throw new Error("nope");
    },
  } as unknown as Fetcher;
}

function createEnv(parent: { isChild: boolean; account: unknown }): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: membershipFetcher(parent),
    POLICY_WORKER: policyFetcher(true),
  } as unknown as Env;
}

function connRow(id: string, orgId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    org_id: orgId,
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

const ACCOUNT = { orgId: "org_11111111111111111111111111111111", workspaceRef: "ws_ACME9999", name: "Acme" };

function listRequest(): Request {
  return new Request("https://worker.test/v1/organizations/x/integrations", { method: "GET" });
}

describe("GET .../integrations — inherited shared connections (IT10)", () => {
  it("appends the Account's shared connection (read-only, attributed) for a child", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("scope = 'account' AND status = 'active'")) return [connRow(ACCT_CONN, ACCOUNT_UUID)];
      if (text.includes("FROM integrations.connections WHERE org_id")) return [connRow(OWN_CONN, WORKSPACE_UUID, { scope: "workspace" })];
      return [];
    });
    const res = await handleListIntegrations(
      listRequest(),
      createEnv({ isChild: true, account: ACCOUNT }),
      "req_1",
      ACTOR,
      asUuid(WORKSPACE_UUID),
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { connections: Array<{ scope: string; inherited?: boolean; sharedByName?: string; sharedByWorkspaceRef?: string }> };
    };
    expect(body.data.connections).toHaveLength(2);
    const inherited = body.data.connections.find((c) => c.inherited);
    expect(inherited).toBeDefined();
    expect(inherited!.sharedByName).toBe("Acme");
    expect(inherited!.sharedByWorkspaceRef).toBe("ws_ACME9999");
    // The workspace's own connection is not marked inherited.
    expect(body.data.connections.filter((c) => c.inherited)).toHaveLength(1);
  });

  it("shows no inherited connections for a standalone org", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections WHERE org_id")) return [connRow(OWN_CONN, WORKSPACE_UUID)];
      return [];
    });
    const res = await handleListIntegrations(
      listRequest(),
      createEnv({ isChild: false, account: null }),
      "req_1",
      ACTOR,
      asUuid(WORKSPACE_UUID),
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connections: Array<{ inherited?: boolean }> } };
    expect(body.data.connections.every((c) => !c.inherited)).toBe(true);
    // Never queried the account-scoped set.
    expect(queries.some((q) => q.text.includes("scope = 'account' AND status = 'active'"))).toBe(false);
  });

  it("hides a 'granted' shared connection the child is not admitted to (D7 hide)", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("scope = 'account' AND status = 'active'"))
        return [connRow(ACCT_CONN, ACCOUNT_UUID, { share_mode: "granted" })];
      if (text.includes("AS admitted")) return [{ admitted: false }];
      if (text.includes("FROM integrations.connections WHERE org_id")) return [connRow(OWN_CONN, WORKSPACE_UUID, { scope: "workspace" })];
      return [];
    });
    const res = await handleListIntegrations(
      listRequest(),
      createEnv({ isChild: true, account: ACCOUNT }),
      "req_1",
      ACTOR,
      asUuid(WORKSPACE_UUID),
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connections: Array<{ inherited?: boolean }> } };
    expect(body.data.connections.some((c) => c.inherited)).toBe(false);
  });
});
