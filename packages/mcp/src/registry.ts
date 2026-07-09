// The tool registry — the single source of truth for tool names, schemas,
// annotations, and handlers (design §2, locked). Transports (CLI stdio,
// mcp-worker) consume `allTools` / `createMcpServer` and add only transport
// concerns.
//
// Locked budget: ≤ 25 default tools (design §4). A new tool must displace or
// justify itself against the existing set — endpoint-mirroring is an anti-goal.

import { accessExplainTool } from "./tools/access.js";
import { auditSearchTool } from "./tools/audit.js";
import { billingSummaryTool } from "./tools/billing.js";
import {
  catalogGetEntityTool,
  catalogReadDocTool,
  catalogSearchTool,
} from "./tools/catalog.js";
import { configReadTool, secretsListTool } from "./tools/config.js";
import { eventsSearchTool } from "./tools/events.js";
import { quotaCheckTool, usageSummaryTool } from "./tools/metering.js";
import { projectsListTool } from "./tools/projects.js";
import { runsGetTool, runsListTool, runsReadLogsTool } from "./tools/runs.js";
import { securityEventsListTool } from "./tools/securityEvents.js";
import { webhookDeliveriesListTool } from "./tools/webhooks.js";
import { whoamiTool } from "./tools/whoami.js";
import { workspacesListTool } from "./tools/workspaces.js";

import type { McpTool } from "./tool.js";

export {
  defineTool,
  executeTool,
  DEFAULT_LIMITS,
  type McpTool,
  type McpToolAnnotations,
  type ToolContext,
  type ToolLimits,
  type ToolResult,
} from "./tool.js";

/** Every registered tool, in the order clients see them (orientation first). */
export const allTools: ReadonlyArray<McpTool> = [
  whoamiTool,
  workspacesListTool,
  projectsListTool,
  catalogSearchTool,
  catalogGetEntityTool,
  catalogReadDocTool,
  runsListTool,
  runsGetTool,
  runsReadLogsTool,
  auditSearchTool,
  eventsSearchTool,
  securityEventsListTool,
  accessExplainTool,
  usageSummaryTool,
  quotaCheckTool,
  billingSummaryTool,
  configReadTool,
  secretsListTool,
  webhookDeliveriesListTool,
];

/** Look a tool up by its registered name; `undefined` when absent. */
export function getTool(name: string): McpTool | undefined {
  return allTools.find((tool) => tool.name === name);
}
