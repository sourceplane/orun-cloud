import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { OrunCloud } from "@saas/sdk";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { captureFetch, envelope, jsonResponse, MemoryTokenStore } from "./helpers.js";

interface Cap { stdout: string[]; stderr: string[]; fetchCalls: { url: string; init: RequestInit }[] }

async function withHarness(
  fn: (h: { cap: Cap; runArgv: (argv: string[]) => Promise<{ exitCode: number }> }) => Promise<void>,
  options: { response: () => Response; activeOrgId?: string },
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-account-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], fetchCalls: [] };
    const fetchHarness = captureFetch(options.response);
    cap.fetchCalls = fetchHarness.calls;
    const tokenStore = new MemoryTokenStore({ apiUrl: "https://api.test", token: "tok" });
    const contextStore = new ContextStore({ configDir: dir });
    if (options.activeOrgId) await contextStore.setActiveOrg(options.activeOrgId);
    const runArgv = (argv: string[]) =>
      runCli(argv, {
        stdout: (l) => cap.stdout.push(l),
        stderr: (l) => cap.stderr.push(l),
        tokenStore,
        contextStore,
        sdkFactory: (baseUrl, token) => new OrunCloud({ baseUrl, auth: { kind: "bearer", token }, fetch: fetchHarness.fetch }),
      });
    await fn({ cap, runArgv });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("commands — account (teams-hub TH1d)", () => {
  it("account workspaces → GET /workspaces (table)", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["account", "workspaces"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/workspaces");
      expect(cap.fetchCalls[0]!.init.method).toBe("GET");
      expect(cap.stdout.join("\n")).toContain("ws_CHILD1");
    }, {
      response: () => jsonResponse(envelope({ workspaces: [{ orgId: "org_c1", workspaceRef: "ws_CHILD1", name: "Payments" }] })),
      activeOrgId: "org_1",
    });
  });

  it("account members → GET /account-members with origin column", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["account", "members"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/account-members");
      const text = cap.stdout.join("\n");
      expect(text).toContain("usr_cascade");
      expect(text).toContain("account_role");
      expect(text).toContain("account_admin");
    }, {
      response: () => jsonResponse(envelope({ members: [
        { subjectId: "usr_cascade", subjectType: "user", origin: "account_role", accountRoles: ["account_admin"] },
        { subjectId: "usr_plain", subjectType: "user", origin: "member", status: "active", joinedAt: "2026-01-01T00:00:00Z", accountRoles: [] },
      ] })),
      activeOrgId: "org_1",
    });
  });

  it("account roles → GET /account-roles (users and teams)", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["account", "roles"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/account-roles");
      expect(cap.fetchCalls[0]!.init.method).toBe("GET");
      const text = cap.stdout.join("\n");
      expect(text).toContain("user:usr_a");
      expect(text).toContain("team:team_x");
    }, {
      response: () => jsonResponse(envelope({ assignments: [
        { subjectId: "usr_a", subjectType: "user", role: "account_admin", createdAt: "2026-01-01T00:00:00Z" },
        { subjectId: "team_x", subjectType: "team", role: "account_admin", createdAt: "2026-01-02T00:00:00Z" },
      ] })),
      activeOrgId: "org_1",
    });
  });

  it("account grant <subjectId> --role → POST /account-roles with body", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["account", "grant", "usr_new", "--role=account_admin"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/account-roles");
      expect(cap.fetchCalls[0]!.init.method).toBe("POST");
      expect(JSON.parse(cap.fetchCalls[0]!.init.body as string)).toEqual({ subjectId: "usr_new", role: "account_admin" });
    }, {
      response: () => jsonResponse(envelope({ assignment: { subjectId: "usr_new", role: "account_admin", scopeKind: "account" } })),
      activeOrgId: "org_1",
    });
  });

  it("account grant requires --role", async () => {
    await withHarness(async ({ runArgv }) => {
      const r = await runArgv(["account", "grant", "usr_new"]);
      expect(r.exitCode).not.toBe(0);
    }, {
      response: () => jsonResponse(envelope({ assignment: {} })),
      activeOrgId: "org_1",
    });
  });

  it("account catalog → GET /account-catalog, table tagged by workspace, denied noted (TH2b)", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["account", "catalog"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/account-catalog");
      expect(cap.fetchCalls[0]!.init.method).toBe("GET");
      const text = cap.stdout.join("\n");
      expect(text).toContain("ws_ROOT");
      expect(text).toContain("svc-payments");
      expect(text).toContain("no access: ws_SECRET");
    }, {
      response: () => jsonResponse(envelope({
        workspaces: [
          { workspace: { orgId: "org_1", workspaceRef: "ws_ROOT", name: "Root" }, status: "ok", entities: [{ ref: "svc-payments", kind: "service" }] },
          { workspace: { orgId: "org_s", workspaceRef: "ws_SECRET", name: "Secret" }, status: "denied", entities: [] },
        ],
        truncated: false,
      })),
      activeOrgId: "org_1",
    });
  });

  it("account runs → GET /account-runs with status filter (TH2b)", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["account", "runs", "--status=running"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toContain("https://api.test/v1/organizations/org_1/account-runs");
      expect(cap.fetchCalls[0]!.url).toContain("status=running");
      const text = cap.stdout.join("\n");
      expect(text).toContain("run_abc");
      expect(text).toContain("ws_C1");
    }, {
      response: () => jsonResponse(envelope({
        workspaces: [
          { workspace: { orgId: "org_c1", workspaceRef: "ws_C1", name: "Payments" }, status: "ok", runs: [{ id: "run_abc", status: "running", environment: "prod" }] },
        ],
        truncated: false,
      })),
      activeOrgId: "org_1",
    });
  });

  it("account revoke <subjectId> --role → DELETE /account-roles with tuple body", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["account", "revoke", "usr_old", "--role=account_billing_admin"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/account-roles");
      expect(cap.fetchCalls[0]!.init.method).toBe("DELETE");
      expect(JSON.parse(cap.fetchCalls[0]!.init.body as string)).toEqual({ subjectId: "usr_old", role: "account_billing_admin" });
    }, {
      response: () => jsonResponse(envelope({ assignment: { subjectId: "usr_old", role: "account_billing_admin", scopeKind: "account", revoked: true } })),
      activeOrgId: "org_1",
    });
  });
});
