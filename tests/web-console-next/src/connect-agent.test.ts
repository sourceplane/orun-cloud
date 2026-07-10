import {
  CLAUDE_CODE_MCP_COMMAND,
  LOCAL_MCP_SNIPPETS,
  MCP_LOGIN_COMMAND,
  MCP_SERVE_COMMAND,
  NODE_CLI_CLAUDE_CODE_MCP_COMMAND,
  NODE_CLI_MCP_LOGIN_COMMAND,
  NODE_CLI_MCP_SERVE_COMMAND,
  NODE_CLI_MCP_SNIPPETS,
  ORUN_INSTALL_COMMAND,
  activeMcpGrants,
  connectAgentLinks,
  mcpRemoteUrl,
  supportedOAuthClients,
} from "@web-console-next/components/settings/connect-agent";
import { OAUTH_PUBLIC_CLIENTS } from "@saas/contracts/auth";
import type { CliSessionSummary } from "@saas/contracts/auth";

describe("LOCAL_MCP_SNIPPETS (orun binary — the primary local path, MCP10)", () => {
  it("covers the four clients, Claude Code first", () => {
    expect(LOCAL_MCP_SNIPPETS.map((s) => s.id)).toEqual([
      "claude-code",
      "cursor",
      "vscode",
      "generic",
    ]);
  });

  it("pins the orun install one-liner and login prerequisite verbatim", () => {
    expect(ORUN_INSTALL_COMMAND).toBe(
      "curl -fsSL https://raw.githubusercontent.com/sourceplane/orun/main/install.sh | sh",
    );
    expect(MCP_LOGIN_COMMAND).toBe("orun auth login");
  });

  it("pins the Claude Code one-liner verbatim — the orun binary, not the node CLI", () => {
    expect(CLAUDE_CODE_MCP_COMMAND).toBe("claude mcp add orun -- orun mcp serve");
    const claude = LOCAL_MCP_SNIPPETS.find((s) => s.id === "claude-code")!;
    expect(claude.code).toBe(CLAUDE_CODE_MCP_COMMAND);
    expect(claude.language).toBe("shell");
  });

  it("carries valid Cursor JSON launching the orun binary (~/.cursor/mcp.json)", () => {
    const cursor = LOCAL_MCP_SNIPPETS.find((s) => s.id === "cursor")!;
    expect(cursor.hint).toBe("~/.cursor/mcp.json");
    const parsed = JSON.parse(cursor.code) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.mcpServers["orun"]).toEqual({
      command: "orun",
      args: ["mcp", "serve"],
    });
  });

  it("carries valid VS Code JSON launching the orun binary (.vscode/mcp.json)", () => {
    const vscode = LOCAL_MCP_SNIPPETS.find((s) => s.id === "vscode")!;
    expect(vscode.hint).toBe(".vscode/mcp.json");
    const parsed = JSON.parse(vscode.code) as {
      servers: Record<string, { type: string; command: string; args: string[] }>;
    };
    expect(parsed.servers["orun"]).toEqual({
      type: "stdio",
      command: "orun",
      args: ["mcp", "serve"],
    });
  });

  it("gives generic clients the bare serve command", () => {
    const generic = LOCAL_MCP_SNIPPETS.find((s) => s.id === "generic")!;
    expect(generic.code).toBe(MCP_SERVE_COMMAND);
    expect(MCP_SERVE_COMMAND).toBe("orun mcp serve");
  });

  it("never points a primary snippet at the node CLI", () => {
    for (const s of LOCAL_MCP_SNIPPETS) {
      expect(s.code).not.toContain("orun-cloud");
    }
  });

  it("contains no secret material anywhere", () => {
    for (const s of LOCAL_MCP_SNIPPETS) {
      expect(s.code).not.toMatch(/sk_[A-Za-z0-9]/);
      expect(s.code.toLowerCase()).not.toContain("bearer");
      expect(s.code.toLowerCase()).not.toContain("secret");
    }
  });
});

describe("NODE_CLI_MCP_SNIPPETS (reference implementation — demoted, still accurate)", () => {
  it("covers the same four clients as the CLI README", () => {
    expect(NODE_CLI_MCP_SNIPPETS.map((s) => s.id)).toEqual([
      "claude-code",
      "cursor",
      "vscode",
      "generic",
    ]);
  });

  it("pins the node commands verbatim (mirrors packages/cli/README.md)", () => {
    expect(NODE_CLI_CLAUDE_CODE_MCP_COMMAND).toBe(
      "claude mcp add orun-cloud -- orun-cloud mcp serve",
    );
    expect(NODE_CLI_MCP_SERVE_COMMAND).toBe("orun-cloud mcp serve");
    expect(NODE_CLI_MCP_LOGIN_COMMAND).toBe("orun-cloud login");
    const claude = NODE_CLI_MCP_SNIPPETS.find((s) => s.id === "claude-code")!;
    expect(claude.code).toBe(NODE_CLI_CLAUDE_CODE_MCP_COMMAND);
    const generic = NODE_CLI_MCP_SNIPPETS.find((s) => s.id === "generic")!;
    expect(generic.code).toBe(NODE_CLI_MCP_SERVE_COMMAND);
  });

  it("carries valid Cursor and VS Code JSON launching orun-cloud", () => {
    const cursor = NODE_CLI_MCP_SNIPPETS.find((s) => s.id === "cursor")!;
    const cursorParsed = JSON.parse(cursor.code) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(cursorParsed.mcpServers["orun-cloud"]).toEqual({
      command: "orun-cloud",
      args: ["mcp", "serve"],
    });
    const vscode = NODE_CLI_MCP_SNIPPETS.find((s) => s.id === "vscode")!;
    const vscodeParsed = JSON.parse(vscode.code) as {
      servers: Record<string, { type: string; command: string; args: string[] }>;
    };
    expect(vscodeParsed.servers["orun-cloud"]).toEqual({
      type: "stdio",
      command: "orun-cloud",
      args: ["mcp", "serve"],
    });
  });

  it("contains no secret material anywhere", () => {
    for (const s of NODE_CLI_MCP_SNIPPETS) {
      expect(s.code).not.toMatch(/sk_[A-Za-z0-9]/);
      expect(s.code.toLowerCase()).not.toContain("bearer");
      expect(s.code.toLowerCase()).not.toContain("secret");
    }
  });
});

describe("mcpRemoteUrl", () => {
  it("derives the per-env workers.dev endpoint the same way the console derives api-edge URLs", () => {
    expect(mcpRemoteUrl("stage")).toBe("https://mcp-worker-stage.oruncloud.workers.dev/mcp");
    expect(mcpRemoteUrl("prod")).toBe("https://mcp-worker-prod.oruncloud.workers.dev/mcp");
  });

  it("never embeds credential material in the URL", () => {
    expect(mcpRemoteUrl("prod")).not.toMatch(/sk_/);
  });
});

describe("supportedOAuthClients", () => {
  it("is the vetted allow-list minus the loopback-only dev client", () => {
    const ids = supportedOAuthClients().map((c) => c.clientId);
    expect(ids).not.toContain("orun-cloud-dev");
    expect(ids).toEqual(
      OAUTH_PUBLIC_CLIENTS.filter((c) => c.clientId !== "orun-cloud-dev").map((c) => c.clientId),
    );
  });

  it("renders the vetted display names (same source the consent page uses)", () => {
    const names = supportedOAuthClients().map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Claude Code", "Claude", "Cursor", "Visual Studio Code"]));
  });
});

describe("connectAgentLinks", () => {
  it("points at the existing surfaces — key minting, roles, usage, and grants are never rebuilt", () => {
    expect(connectAgentLinks("acme")).toEqual({
      apiKeys: "/orgs/acme/settings/api-keys",
      peopleAccess: "/orgs/acme/settings/people",
      usage: "/orgs/acme/usage",
      sessions: "/you/sessions",
    });
  });
});

describe("activeMcpGrants", () => {
  const session = (over: Partial<CliSessionSummary>): CliSessionSummary => ({
    id: "sess_1",
    host: null,
    createdAt: "2026-07-01T00:00:00Z",
    lastUsedAt: "2026-07-08T00:00:00Z",
    expiresAt: "2026-08-01T00:00:00Z",
    revokedAt: null,
    ...over,
  });

  it("keeps only active mcp-labeled sessions, rendered with the vetted client name", () => {
    const rows = activeMcpGrants([
      session({ id: "sess_cli", host: "dev-laptop" }),
      session({ id: "sess_mcp", host: "mcp:claude-web" }),
      session({ id: "sess_revoked", host: "mcp:cursor", revokedAt: "2026-07-05T00:00:00Z" }),
    ]);
    expect(rows).toEqual([
      {
        id: "sess_mcp",
        clientName: "Claude",
        createdAt: "2026-07-01T00:00:00Z",
        lastUsedAt: "2026-07-08T00:00:00Z",
      },
    ]);
  });

  it("falls back to the raw client id for an unknown mcp label", () => {
    const rows = activeMcpGrants([session({ host: "mcp:mystery-client" })]);
    expect(rows.map((r) => r.clientName)).toEqual(["mystery-client"]);
  });

  it("returns nothing for plain CLI sessions or an empty list", () => {
    expect(activeMcpGrants([])).toEqual([]);
    expect(activeMcpGrants([session({ host: "workstation" })])).toEqual([]);
  });
});
