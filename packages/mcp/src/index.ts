// `@saas/mcp` — the platform MCP tool plane (epic saas-mcp-server, MCP0).
//
// One registry, thin transports: this package owns tool names, zod schemas,
// annotations, and handlers over `@saas/sdk`; the CLI stdio command (MCP1) and
// `apps/mcp-worker` (MCP2) add transport concerns only. The server is a
// CLIENT of the platform — every tool call rides the caller's credential
// through api-edge; RBAC, rate limits, audit, and metering apply unchanged.

export {
  allTools,
  readOnlyTools,
  getTool,
  defineTool,
  executeTool,
  DEFAULT_LIMITS,
  type McpTool,
  type McpToolAnnotations,
  type ToolCallGate,
  type ToolContext,
  type ToolLimits,
  type ToolResult,
} from "./registry.js";

export {
  createMcpServer,
  applyWorkspaceDefault,
  SERVER_NAME,
  SERVER_VERSION,
  CLIENT_SURFACE_HEADER,
  CLIENT_SURFACE_VALUE,
  type CreateMcpServerOptions,
} from "./server.js";

export {
  idempotencyKeyArg,
  resolveIdempotencyKey,
  deriveIdempotencyKey,
} from "./idempotency.js";

export {
  toErrorResult,
  toResourceReadError,
  EntitlementDeniedError,
  ResourceReadError,
  ToolInputError,
} from "./errors.js";

// MCP6 — metering + entitlement seam (design §8). Transport-facing: the CLI
// and the worker wire these; the tool plane itself stays billing-blind.
export {
  MCP_TOOL_CALL_METRIC,
  emitToolCallUsage,
  workspaceOf,
  type McpUsageOptions,
} from "./usage.js";

export {
  MCP_SERVER_ENTITLEMENT_KEY,
  ENTITLEMENT_CACHE_TTL_MS,
  ENTITLEMENT_CACHE_MAX_ENTRIES,
  checkMcpServerEntitlement,
  createEntitlementGate,
  type EntitlementGateCache,
  type EntitlementGateOptions,
  type McpEntitlementDecision,
} from "./entitlement.js";

export {
  allResources,
  catalogEntityResource,
  runSummaryResource,
  encodeEntityKey,
  decodeEntityKey,
  RESOURCE_MIME_TYPE,
  type McpResource,
} from "./resources.js";

export {
  allPrompts,
  investigateFailedRunPrompt,
  accessReviewPrompt,
  usageReviewPrompt,
  serviceSnapshotPrompt,
  type McpPrompt,
} from "./prompts.js";

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
