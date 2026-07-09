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
import { configReadTool, flagSetTool, secretsListTool } from "./tools/config.js";
import { eventsSearchTool } from "./tools/events.js";
import { memberInviteTool } from "./tools/members.js";
import { quotaCheckTool, usageSummaryTool } from "./tools/metering.js";
import {
  environmentCreateTool,
  projectCreateTool,
  projectsListTool,
} from "./tools/projects.js";
import { runsGetTool, runsListTool, runsReadLogsTool } from "./tools/runs.js";
import { securityEventsListTool } from "./tools/securityEvents.js";
import {
  webhookCreateTool,
  webhookDeliveriesListTool,
  webhookDeliveryReplayTool,
} from "./tools/webhooks.js";
import { whoamiTool } from "./tools/whoami.js";
import { workspacesListTool } from "./tools/workspaces.js";

import type { McpTool } from "./tool.js";

export {
  defineTool,
  executeTool,
  DEFAULT_LIMITS,
  type McpTool,
  type McpToolAnnotations,
  type ToolCallGate,
  type ToolContext,
  type ToolLimits,
  type ToolResult,
} from "./tool.js";

/**
 * Every registered tool, in the order clients see them (orientation first,
 * the MCP5 write set last). 19 reads + 6 writes = 25 — the locked budget is
 * now exactly consumed: a new tool must displace an existing one.
 */
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
  // Write tools (MCP5, design §4 — this set ONLY; api-key/billing/team-grant/
  // admin writes and all work-plane surfaces are deliberately excluded).
  projectCreateTool,
  environmentCreateTool,
  flagSetTool,
  webhookCreateTool,
  webhookDeliveryReplayTool,
  memberInviteTool,
];

/**
 * The read-only roster — what a `readOnly` connection (design §7) advertises
 * and serves. Shared by `createMcpServer`, the CLI `--read-only` flag, and
 * the remote worker (which stays read-only until deliberately enabled).
 */
export const readOnlyTools: ReadonlyArray<McpTool> = allTools.filter(
  (tool) => tool.annotations.readOnlyHint === true,
);

/** Look a tool up by its registered name; `undefined` when absent. */
export function getTool(name: string): McpTool | undefined {
  return allTools.find((tool) => tool.name === name);
}
