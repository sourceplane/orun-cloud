// MCP command group (saas-mcp-server MCP1):
//
//   - mcp serve → the local stdio transport over the `@saas/mcp` tool plane.
//                 Rides the existing token store (no new auth); the SDK client
//                 carries the caller's credential through api-edge, so RBAC,
//                 rate limits, audit, and metering apply unchanged.
//   - mcp tools → human-readable roster of the registered tools (the same set
//                 `tools/list` would advertise), for debugging client setups.
//
// STDOUT PURITY (serve): stdout is the MCP protocol channel. Nothing in this
// module may write to stdout in serve mode — banners and diagnostics go to
// stderr, and errors surface through the runner's stderr path.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  allTools,
  checkMcpServerEntitlement,
  createMcpServer,
  MCP_SERVER_ENTITLEMENT_KEY,
  SERVER_VERSION,
  type McpTool,
} from "@saas/mcp";
import { OrunCloud } from "@saas/sdk";

import type { CommandContext, CommandResult } from "../router.js";
import { CLI_BIN, DEFAULT_API_URL } from "../brand.js";
import { MissingAuthError } from "../errors.js";
import { formatOutput } from "../output/index.js";

function strFlag(flag: string | boolean | undefined): string | undefined {
  return typeof flag === "string" && flag.length > 0 ? flag : undefined;
}

/**
 * Ambient `workspace` default for the stdio server (design §3). Precedence:
 * explicit `--workspace` flag > persisted active org from the context store >
 * no default. Per-call `workspace` arguments always override whatever this
 * resolves to (enforced in `@saas/mcp`, not here).
 */
export async function resolveWorkspaceDefault(
  ctx: CommandContext,
): Promise<string | undefined> {
  const flag = strFlag(ctx.flags["workspace"]);
  if (flag !== undefined) return flag;
  const cliCtx = await ctx.contextStore.load();
  const active = cliCtx.activeOrgId;
  return active !== undefined && active.length > 0 ? active : undefined;
}

/** The tool roster `mcp serve`/`mcp tools` expose for the given flags. */
function selectTools(readOnly: boolean): ReadonlyArray<McpTool> {
  return readOnly
    ? allTools.filter((tool) => tool.annotations.readOnlyHint === true)
    : allTools;
}

/**
 * MCP6 startup entitlement check (design §8, connect-time on this transport):
 * when an ambient default workspace is resolvable, verify `feature.mcp_server`
 * via the public billing entitlements read BEFORE starting the server.
 * Returns `true` to proceed. Denied → clear stderr message, no server (hard
 * fail, CLI convention: never start a half-working long-lived process). A
 * failed check (billing outage, forbidden read) proceeds with a warning —
 * the D3 default posture is the OPEN gate, so availability wins. Without a
 * resolvable workspace there is nothing to check (per-call tenancy).
 */
export async function assertServeEntitlement(
  sdk: OrunCloud,
  workspace: string | undefined,
  stderr: (line: string) => void,
): Promise<boolean> {
  if (workspace === undefined) return true;
  const decision = await checkMcpServerEntitlement(sdk, workspace);
  if (!decision.allowed) {
    stderr(
      `error: MCP server access is not available on the current plan for workspace ${workspace} ` +
        `(${MCP_SERVER_ENTITLEMENT_KEY} is disabled). Upgrade the workspace's plan or contact an admin.`,
    );
    return false;
  }
  if (decision.reason === "check_failed") {
    stderr(
      `warning: could not verify ${MCP_SERVER_ENTITLEMENT_KEY} for ${workspace}; continuing (gate is fail-open)`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// mcp serve
// ---------------------------------------------------------------------------

export async function mcpServeCommand(ctx: CommandContext): Promise<CommandResult> {
  // Same credential path as every other command: the stored token. Absent →
  // exit non-zero with the login pointer on stderr (never start a server).
  const cred = await ctx.tokenStore.load();
  if (cred === null) throw new MissingAuthError();

  const cliCtx = await ctx.contextStore.load();
  // Base URL precedence: `--api-url` flag > the context store's lastApiUrl >
  // the credential's own apiUrl (written together by `login`; itself already
  // defaulted to DEFAULT_API_URL at login time).
  const apiUrl =
    strFlag(ctx.flags["api-url"]) ??
    cliCtx.lastApiUrl ??
    (cred.apiUrl.length > 0 ? cred.apiUrl : DEFAULT_API_URL);

  const readOnly = ctx.flags["read-only"] === true;
  const defaultWorkspace = await resolveWorkspaceDefault(ctx);

  const sdk = new OrunCloud({
    baseUrl: apiUrl,
    auth: { kind: "bearer", token: cred.token },
  });

  // MCP6 entitlement seam: connect-time check against the ambient default
  // workspace, when one is set. Denied → exit 6 (server-side denial surfaced
  // via the SDK read), message on stderr, no server started.
  if (!(await assertServeEntitlement(sdk, defaultWorkspace, ctx.stderr))) {
    return { exitCode: 6 };
  }

  const server = createMcpServer({
    sdk,
    ...(readOnly ? { readOnly: true } : {}),
    ...(defaultWorkspace !== undefined ? { defaultWorkspace } : {}),
    // MCP6 metering: this transport self-meters `mcp.tool_call` through the
    // public ingest on the user's own credential; ingest failures surface as
    // stderr diagnostics only (stdout stays pure protocol) and never block
    // or fail a tool call.
    usage: {
      enabled: true,
      transport: "stdio",
      debug: (message) => ctx.stderr(`debug: ${message}`),
    },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Startup banner on stderr only — stdout belongs to the protocol.
  const notes = [
    `${selectTools(readOnly).length} tools`,
    `api ${apiUrl}`,
    ...(readOnly ? ["read-only"] : []),
    ...(defaultWorkspace !== undefined ? [`workspace default ${defaultWorkspace}`] : []),
  ];
  ctx.stderr(`${CLI_BIN} MCP server v${SERVER_VERSION} on stdio (${notes.join(", ")})`);

  // Stay alive until the client disconnects (stdin EOF closes the transport).
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// mcp tools
// ---------------------------------------------------------------------------

export async function mcpToolsCommand(ctx: CommandContext): Promise<CommandResult> {
  const readOnly = ctx.flags["read-only"] === true;
  const tools = selectTools(readOnly);

  if (ctx.outputMode === "json") {
    ctx.stdout(
      formatOutput({
        mode: "json",
        data: {
          tools: tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            readOnly: t.annotations.readOnlyHint === true,
          })),
        },
      }),
    );
    return { exitCode: 0 };
  }

  const rows = tools.map((t) => ({
    name: t.name,
    "read-only": t.annotations.readOnlyHint === true ? "yes" : "no",
    title: t.title,
  }));
  ctx.stdout(
    formatOutput({
      mode: "human",
      columns: ["name", "read-only", "title"],
      rows,
      title: `MCP tools (${tools.length})${readOnly ? " — read-only set" : ""}`,
    }),
  );
  return { exitCode: 0 };
}
