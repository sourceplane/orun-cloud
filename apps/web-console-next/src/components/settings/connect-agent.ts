// "Connect an agent" page model (saas-mcp-server MCP7) — pure, dependency-free
// (no React), so the install snippets, remote-URL derivation, OAuth client
// roster, and grant filtering are unit-testable in isolation. The page
// (`settings/mcp/page.tsx`) renders this vocabulary; nothing here talks to the
// network.
//
// The snippets mirror `packages/cli/README.md` § MCP server verbatim — the CLI
// README is the source of truth for client setup; drift between the two is a
// copy bug.

import { OAUTH_PUBLIC_CLIENTS, type OAuthPublicClient } from "@saas/contracts/auth";
import type { CliSessionSummary } from "@saas/contracts/auth";
import { mcpWorkersDevUrl } from "@/lib/app-config";
import { sessionClientLabel } from "@/lib/oauth-consent";

/* ── Local (stdio) install snippets ──────────────────────────────────── */

/** The one-liner for Claude Code — asserted verbatim in tests. */
export const CLAUDE_CODE_MCP_COMMAND = "claude mcp add orun-cloud -- orun-cloud mcp serve";

/** The stdio server command every client ultimately launches. */
export const MCP_SERVE_COMMAND = "orun-cloud mcp serve";

/** Prerequisite before any local snippet works. */
export const MCP_LOGIN_COMMAND = "orun-cloud login";

export interface McpClientSnippet {
  id: "claude-code" | "cursor" | "vscode" | "generic";
  /** Tab label. */
  label: string;
  /** Where the snippet goes — a terminal or a config-file path. */
  hint: string;
  /** Copied verbatim. Never contains credential material. */
  code: string;
  language: "shell" | "json";
}

const CURSOR_MCP_JSON = `{
  "mcpServers": {
    "orun-cloud": {
      "command": "orun-cloud",
      "args": ["mcp", "serve"]
    }
  }
}`;

const VSCODE_MCP_JSON = `{
  "servers": {
    "orun-cloud": {
      "type": "stdio",
      "command": "orun-cloud",
      "args": ["mcp", "serve"]
    }
  }
}`;

/** Per-client local setup, mirroring `packages/cli/README.md`. */
export const LOCAL_MCP_SNIPPETS: readonly McpClientSnippet[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "Run in your terminal",
    code: CLAUDE_CODE_MCP_COMMAND,
    language: "shell",
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: "~/.cursor/mcp.json",
    code: CURSOR_MCP_JSON,
    language: "json",
  },
  {
    id: "vscode",
    label: "VS Code",
    hint: ".vscode/mcp.json",
    code: VSCODE_MCP_JSON,
    language: "json",
  },
  {
    id: "generic",
    label: "Other clients",
    hint: "Any stdio MCP client",
    code: MCP_SERVE_COMMAND,
    language: "shell",
  },
];

/* ── Remote (Streamable HTTP) ────────────────────────────────────────── */

/**
 * The remote MCP endpoint for an environment name ("stage" | "prod" — the
 * console's API-target names). The worker serves MCP on POST /mcp; the
 * `mcp.<domain>` custom hostname is an infra follow-up, so this is the
 * workers.dev URL, derived the same way the console derives api-edge URLs.
 */
export function mcpRemoteUrl(environment: string): string {
  return `${mcpWorkersDevUrl(environment)}/mcp`;
}

/**
 * OAuth-capable clients that can connect to the remote URL interactively —
 * the vetted public-client allow-list (`OAUTH_PUBLIC_CLIENTS`, D1 Option A),
 * minus the loopback-only development client (not a product surface).
 */
export function supportedOAuthClients(): readonly OAuthPublicClient[] {
  return OAUTH_PUBLIC_CLIENTS.filter((c) => c.clientId !== "orun-cloud-dev");
}

/* ── Console links the page rides (never rebuilt here) ───────────────── */

export interface ConnectAgentLinks {
  /** Mint an `sk_` key — the existing API-keys surface owns the flow. */
  apiKeys: string;
  /** Role definitions and effective access. */
  peopleAccess: string;
  /** `mcp.tool_call` shows up in the consumption explorer here. */
  usage: string;
  /** Per-user Sessions & devices — MCP OAuth grants live (and revoke) there. */
  sessions: string;
}

export function connectAgentLinks(orgSlug: string): ConnectAgentLinks {
  return {
    apiKeys: `/orgs/${orgSlug}/settings/api-keys`,
    peopleAccess: `/orgs/${orgSlug}/settings/people`,
    usage: `/orgs/${orgSlug}/usage`,
    sessions: "/you/sessions",
  };
}

/* ── Status: active MCP grants ───────────────────────────────────────── */

export interface McpGrantRow {
  id: string;
  /** Vetted client display name (falls back to the raw client id). */
  clientName: string;
  createdAt: string;
  lastUsedAt: string;
}

/**
 * The signed-in user's active MCP OAuth grants, filtered out of the existing
 * per-user CLI-sessions read (MCP3: a grant IS a CLI-shaped session labeled
 * `mcp:<clientId>` — no new read model).
 */
export function activeMcpGrants(sessions: readonly CliSessionSummary[]): McpGrantRow[] {
  const rows: McpGrantRow[] = [];
  for (const s of sessions) {
    if (s.revokedAt) continue;
    const { label, kind } = sessionClientLabel(s.host);
    if (kind !== "mcp") continue;
    rows.push({ id: s.id, clientName: label, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt });
  }
  return rows;
}
