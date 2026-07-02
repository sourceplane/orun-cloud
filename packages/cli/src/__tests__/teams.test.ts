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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-team-"));
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

const TEAM = { id: "team_abc", name: "Platform", slug: "platform", status: "active", createdAt: "2026-01-01T00:00:00Z" };

describe("commands — team", () => {
  it("team list → GET /teams (table)", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["team", "list"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams");
      expect(cap.fetchCalls[0]!.init.method).toBe("GET");
      expect(cap.stdout.join("\n")).toContain("Platform");
    }, { response: () => jsonResponse(envelope({ teams: [TEAM] })), activeOrgId: "org_1" });
  });

  it("team create <name> → POST /teams with body", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["team", "create", "Platform"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams");
      expect(cap.fetchCalls[0]!.init.method).toBe("POST");
      expect(JSON.parse(cap.fetchCalls[0]!.init.body as string)).toEqual({ name: "Platform" });
    }, { response: () => jsonResponse(envelope({ team: TEAM })), activeOrgId: "org_1" });
  });

  it("team create requires a name", async () => {
    await withHarness(async ({ runArgv }) => {
      const r = await runArgv(["team", "create"]);
      expect(r.exitCode).not.toBe(0);
    }, { response: () => jsonResponse(envelope({ team: TEAM })), activeOrgId: "org_1" });
  });

  it("team delete <id> → DELETE /teams/:id", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["team", "delete", "team_abc"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams/team_abc");
      expect(cap.fetchCalls[0]!.init.method).toBe("DELETE");
    }, { response: () => jsonResponse(envelope({ team: { ...TEAM, status: "deleted" } })), activeOrgId: "org_1" });
  });

  it("team members <id> → GET /teams/:id/members", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["team", "members", "team_abc"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams/team_abc/members");
    }, { response: () => jsonResponse(envelope({ members: [{ subjectId: "usr_a", subjectType: "user", status: "active", createdAt: "2026-01-01T00:00:00Z" }] })), activeOrgId: "org_1" });
  });

  it("team member-add <id> <subject> → POST /members with body", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["team", "member-add", "team_abc", "usr_new"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams/team_abc/members");
      expect(cap.fetchCalls[0]!.init.method).toBe("POST");
      expect(JSON.parse(cap.fetchCalls[0]!.init.body as string)).toEqual({ subjectId: "usr_new" });
    }, { response: () => jsonResponse(envelope({ member: { subjectId: "usr_new", subjectType: "user", status: "active", createdAt: "2026-01-01T00:00:00Z" } })), activeOrgId: "org_1" });
  });

  it("team grant <id> --role --scope → POST /team-roles with body", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["team", "grant", "team_abc", "--role=builder", "--scope=organization"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/team-roles");
      expect(cap.fetchCalls[0]!.init.method).toBe("POST");
      const body = JSON.parse(cap.fetchCalls[0]!.init.body as string);
      expect(body).toMatchObject({ teamId: "team_abc", role: "builder", scopeKind: "organization" });
    }, { response: () => jsonResponse(envelope({ grant: { teamId: "team_abc", role: "builder", scopeKind: "organization", scopeRef: null } })), activeOrgId: "org_1" });
  });

  it("team grant requires --role and --scope", async () => {
    await withHarness(async ({ runArgv }) => {
      const r = await runArgv(["team", "grant", "team_abc"]);
      expect(r.exitCode).not.toBe(0);
    }, { response: () => jsonResponse(envelope({ grant: {} })), activeOrgId: "org_1" });
  });

  it("team revoke <id> --role --scope → DELETE /team-roles with body", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["team", "revoke", "team_abc", "--role=builder", "--scope=organization"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/team-roles");
      expect(cap.fetchCalls[0]!.init.method).toBe("DELETE");
      expect(JSON.parse(cap.fetchCalls[0]!.init.body as string).role).toBe("builder");
    }, { response: () => jsonResponse(envelope({ grant: { teamId: "team_abc", role: "builder", scopeKind: "organization", scopeRef: null } })), activeOrgId: "org_1" });
  });
});

describe("commands — team access (TM6b3b)", () => {
  it("team access → GET /effective-access and renders action + via", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["team", "access"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/effective-access");
      expect(cap.fetchCalls[0]!.init.method).toBe("GET");
      const text = cap.stdout.join("\n");
      expect(text).toContain("organization.read");
      expect(text).toContain("team team_x");
    }, {
      response: () => jsonResponse(envelope({ permissions: [
        { action: "organization.read", allow: true, reason: "org_builder", via: { kind: "team", teamId: "team_x" } },
        { action: "organization.settings.update", allow: false, reason: "no_matching_role" },
      ] })),
      activeOrgId: "org_1",
    });
  });

  it("team access <subjectId> forwards subjectId", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["team", "access", "usr_other"]);
      expect(r.exitCode).toBe(0);
      expect(cap.fetchCalls[0]!.url).toContain("subjectId=usr_other");
    }, { response: () => jsonResponse(envelope({ permissions: [] })), activeOrgId: "org_1" });
  });
});
