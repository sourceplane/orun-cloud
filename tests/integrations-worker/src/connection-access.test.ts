import { resolveUsableConnection } from "@integrations-worker/connection-access";
import { orgPublicId } from "@integrations-worker/ids";
import type { Env } from "@integrations-worker/env";
import { createIntegrationsRepository } from "@saas/db/integrations";
import { asUuid } from "@saas/db/ids";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

// A child workspace references its Account's shared connection by the id it sees
// in its own list (IT10). resolveUsableConnection is the read-up seam that lets
// repo listing / linking resolve that id even though the row is owned by the
// Account, not the requesting workspace.

const WORKSPACE_UUID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_UUID = "99999999-9999-4999-8999-999999999999";
const OWN_CONN = "33333333-3333-4333-8333-333333333333";
const ACCT_CONN = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-06-11T10:00:00Z");

function fakeExecutor(
  respond: (text: string, params: unknown[]) => Record<string, unknown>[] | null,
): SqlExecutor {
  return {
    async execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
}

function membershipFetcher(parent: { isChild: boolean; account: unknown }): Fetcher {
  return {
    fetch: (input: string) => {
      if (String(input).includes("/integration-parent")) {
        return Promise.resolve(Response.json({ data: parent }));
      }
      return Promise.resolve(Response.json({ data: { memberships: [] } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function env(parent: { isChild: boolean; account: unknown }): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: membershipFetcher(parent),
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

const ACCOUNT = { orgId: orgPublicId(ACCOUNT_UUID), workspaceRef: "ws_ACME9999", name: "Acme" };

// getConnection is org-scoped; getConnectionById is not. Distinguish by SQL.
const isOrgScoped = (t: string) => t.includes("org_id = $1 AND id = $2");
const isById = (t: string) => t.includes("WHERE id = $1");

describe("resolveUsableConnection (inherited read-up)", () => {
  it("returns the org's own connection without a read-up", async () => {
    let membershipCalls = 0;
    const e = {
      ...env({ isChild: false, account: null }),
      MEMBERSHIP_WORKER: {
        fetch: () => {
          membershipCalls += 1;
          return Promise.resolve(Response.json({ data: { isChild: false, account: null } }));
        },
      },
    } as unknown as Env;
    const repo = createIntegrationsRepository(
      fakeExecutor((t) => (isOrgScoped(t) ? [connRow(OWN_CONN, WORKSPACE_UUID, { scope: "workspace" })] : [])),
    );
    const conn = await resolveUsableConnection(e, repo, asUuid(WORKSPACE_UUID), asUuid(OWN_CONN), "req");
    expect(conn?.id).toBe(OWN_CONN);
    // Own-connection hit never consults membership.
    expect(membershipCalls).toBe(0);
  });

  it("resolves an inherited 'auto' account connection for a child", async () => {
    const repo = createIntegrationsRepository(
      fakeExecutor((t) => {
        if (isOrgScoped(t)) return []; // not owned by the workspace
        if (isById(t)) return [connRow(ACCT_CONN, ACCOUNT_UUID)];
        return [];
      }),
    );
    const conn = await resolveUsableConnection(
      env({ isChild: true, account: ACCOUNT }),
      repo,
      asUuid(WORKSPACE_UUID),
      asUuid(ACCT_CONN),
      "req",
    );
    expect(conn?.id).toBe(ACCT_CONN);
    expect(conn?.orgId).toBe(ACCOUNT_UUID);
  });

  it("resolves an inherited 'granted' connection when the workspace is admitted", async () => {
    const repo = createIntegrationsRepository(
      fakeExecutor((t) => {
        if (isOrgScoped(t)) return [];
        if (isById(t)) return [connRow(ACCT_CONN, ACCOUNT_UUID, { share_mode: "granted" })];
        if (t.includes("AS admitted")) return [{ admitted: true }];
        return [];
      }),
    );
    const conn = await resolveUsableConnection(
      env({ isChild: true, account: ACCOUNT }),
      repo,
      asUuid(WORKSPACE_UUID),
      asUuid(ACCT_CONN),
      "req",
    );
    expect(conn?.id).toBe(ACCT_CONN);
  });

  it("denies an inherited 'granted' connection the workspace is not admitted to", async () => {
    const repo = createIntegrationsRepository(
      fakeExecutor((t) => {
        if (isOrgScoped(t)) return [];
        if (isById(t)) return [connRow(ACCT_CONN, ACCOUNT_UUID, { share_mode: "granted" })];
        if (t.includes("AS admitted")) return [{ admitted: false }];
        return [];
      }),
    );
    const conn = await resolveUsableConnection(
      env({ isChild: true, account: ACCOUNT }),
      repo,
      asUuid(WORKSPACE_UUID),
      asUuid(ACCT_CONN),
      "req",
    );
    expect(conn).toBeNull();
  });

  it("denies read-up for a standalone org (not a child)", async () => {
    const repo = createIntegrationsRepository(
      fakeExecutor((t) => {
        if (isOrgScoped(t)) return [];
        if (isById(t)) return [connRow(ACCT_CONN, ACCOUNT_UUID)];
        return [];
      }),
    );
    const conn = await resolveUsableConnection(
      env({ isChild: false, account: null }),
      repo,
      asUuid(WORKSPACE_UUID),
      asUuid(ACCT_CONN),
      "req",
    );
    expect(conn).toBeNull();
  });

  it("denies a connection owned by a different account than the child's parent", async () => {
    const repo = createIntegrationsRepository(
      fakeExecutor((t) => {
        if (isOrgScoped(t)) return [];
        if (isById(t)) return [connRow(ACCT_CONN, OTHER_ACCOUNT_UUID)];
        return [];
      }),
    );
    const conn = await resolveUsableConnection(
      env({ isChild: true, account: ACCOUNT }),
      repo,
      asUuid(WORKSPACE_UUID),
      asUuid(ACCT_CONN),
      "req",
    );
    expect(conn).toBeNull();
  });

  it("denies read-up for a workspace-private (non-account) connection", async () => {
    const repo = createIntegrationsRepository(
      fakeExecutor((t) => {
        if (isOrgScoped(t)) return [];
        if (isById(t)) return [connRow(ACCT_CONN, ACCOUNT_UUID, { scope: "workspace" })];
        return [];
      }),
    );
    const conn = await resolveUsableConnection(
      env({ isChild: true, account: ACCOUNT }),
      repo,
      asUuid(WORKSPACE_UUID),
      asUuid(ACCT_CONN),
      "req",
    );
    expect(conn).toBeNull();
  });
});
