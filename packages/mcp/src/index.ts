// `@saas/mcp` — the platform MCP tool plane (epic saas-mcp-server, MCP0).
//
// One registry, thin transports: this package owns tool names, zod schemas,
// annotations, and handlers over `@saas/sdk`; the CLI stdio command (MCP1) and
// `apps/mcp-worker` (MCP2) add transport concerns only. The server is a
// CLIENT of the platform — every tool call rides the caller's credential
// through api-edge; RBAC, rate limits, audit, and metering apply unchanged.

export {
  allTools,
  getTool,
  defineTool,
  executeTool,
  DEFAULT_LIMITS,
  type McpTool,
  type McpToolAnnotations,
  type ToolContext,
  type ToolLimits,
  type ToolResult,
} from "./registry.js";

export {
  createMcpServer,
  SERVER_NAME,
  SERVER_VERSION,
  type CreateMcpServerOptions,
} from "./server.js";

export { toErrorResult, ToolInputError } from "./errors.js";

export {
  workspaceArg,
  projectArg,
  scopedShape,
  cursorArg,
  limitArg,
  encodeStateCursor,
  configScopeFromInput,
  compact,
} from "./scope.js";

export {
  truncateText,
  DEFAULT_MAX_TEXT_BYTES,
  type TruncatedText,
} from "./truncate.js";
