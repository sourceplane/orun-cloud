// MCP resources (saas-mcp-server MCP4, design §6): read-optional context a
// client can attach without spending a tool call. Kept minimal — exactly the
// two templates the design names — because client support for resources is
// weaker than for tools and every advertised template costs context.
//
// Both templates register a `list` callback that returns an empty list:
// enumerating a whole org's catalog (or run history) on `resources/list`
// would blow the client's context budget for no navigational value. Agents
// discover concrete ids through `catalog_search` / `runs_list` and then
// attach the specific resource URI.

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ERROR_CODES } from "@saas/contracts/errors";

import { ResourceReadError, ToolInputError } from "./errors.js";
import { compact } from "./scope.js";
import { truncateText } from "./truncate.js";

import type { ToolContext } from "./tool.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { CatalogDoc, OrgCatalogEntity, Run, RunJob } from "@saas/contracts/state";
import type { StateClient } from "@saas/sdk";

// The SDK does not export its state query interfaces; derive them so the
// compact() calls stay pinned to the real method signatures.
type OrgCatalogEntitiesQuery = NonNullable<
  Parameters<StateClient["listOrgCatalogEntities"]>[1]
>;
type CatalogDocsQuery = NonNullable<Parameters<StateClient["listCatalogDocs"]>[1]>;

export const RESOURCE_MIME_TYPE = "text/markdown";

/** A registered resource template: URI pattern + markdown read callback. */
export interface McpResource {
  name: string;
  template: ResourceTemplate;
  metadata: { title: string; description: string; mimeType: string };
  read: (uri: URL, variables: Variables, ctx: ToolContext) => Promise<ReadResourceResult>;
}

// ── entityKey codec ─────────────────────────────────────────
// Entity refs contain `:` and `/` (`component:default/api`), which cannot
// ride a single URI path segment verbatim, and percent-encoding is ambiguous
// under template matching (the SDK matcher does not decode). `entityKey` is
// therefore base64url(entityRef): lossless for any ref, URL-safe by
// construction. Tools keep taking the raw `entityRef` — the key form exists
// only for resource URIs; `encodeEntityKey` is exported so transports/tests
// can mint URIs.

export function encodeEntityKey(entityRef: string): string {
  const bytes = new TextEncoder().encode(entityRef);
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeEntityKey(entityKey: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(entityKey)) {
    throw new ToolInputError(
      "`entityKey` must be base64url(entityRef), e.g. encodeEntityKey(`component:default/api`)",
    );
  }
  const base64 = entityKey.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let raw: string;
  try {
    raw = atob(padded);
  } catch {
    throw new ToolInputError("`entityKey` is not valid base64url");
  }
  return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
}

/** Extract a required string variable from a template match. */
function requireVariable(variables: Variables, name: string): string {
  const value = variables[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`URI template variable \`${name}\` is required`);
  }
  return value;
}

function markdownResult(uri: URL, text: string): ReadResourceResult {
  return {
    contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text }],
  };
}

// ── catalog://{workspace}/{entityKey} ───────────────────────

export const catalogEntityResource: McpResource = {
  name: "catalog_entity",
  template: new ResourceTemplate("catalog://{workspace}/{entityKey}", {
    // No enumeration on resources/list (see module comment).
    list: () => ({ resources: [] }),
  }),
  metadata: {
    title: "Catalog entity overview",
    description:
      "One catalog entity as markdown: identity, owner, relations, provenance, doc index, and the overview doc body (byte-capped). `entityKey` is base64url(entityRef). The agent-facing twin of the entity page; use `catalog_search` to find refs.",
    mimeType: RESOURCE_MIME_TYPE,
  },
  read: async (uri, variables, ctx) => {
    const workspace = requireVariable(variables, "workspace");
    const entityRef = decodeEntityKey(requireVariable(variables, "entityKey"));
    // Same emulation path as `catalog_get_entity` (risk D2, SC0 unshipped):
    // exact-filter the OV6 list endpoint; migrate when the getter lands.
    const [entityPage, docsPage] = await Promise.all([
      ctx.sdk.state.listOrgCatalogEntities(
        workspace,
        compact<OrgCatalogEntitiesQuery>({ q: entityRef, limit: 100 }),
      ),
      ctx.sdk.state.listCatalogDocs(
        workspace,
        compact<CatalogDocsQuery>({ entityRef, limit: 100 }),
      ),
    ]);
    const entity = entityPage.entities.find((e) => e.entityRef === entityRef);
    if (entity === undefined) {
      throw new ResourceReadError(
        ERROR_CODES.NOT_FOUND,
        `no catalog entity with ref "${entityRef}" in workspace ${workspace}`,
      );
    }
    const overviewDoc = docsPage.docs.find((d) => d.role === "overview");
    const overviewBody =
      overviewDoc === undefined
        ? null
        : await ctx.sdk.state.readCatalogDoc(workspace, overviewDoc.digest);
    return markdownResult(
      uri,
      entityMarkdown(entity, docsPage.docs, overviewBody, ctx.limits.maxTextBytes),
    );
  },
};

function entityMarkdown(
  entity: OrgCatalogEntity,
  docs: CatalogDoc[],
  overviewBody: string | null,
  maxTextBytes: number,
): string {
  const lines: string[] = [
    `# ${entity.entityRef} — ${entity.name}`,
    "",
    `- **Kind:** ${entity.kind}`,
    `- **Owner:** ${entity.owner ?? "—"}`,
    `- **Lifecycle:** ${entity.lifecycle ?? "—"}`,
  ];
  if (entity.description != null) lines.push(`- **Description:** ${entity.description}`);
  if (entity.system != null) lines.push(`- **System:** ${entity.system}`);
  lines.push("", "## Relations");
  if (entity.relations.length === 0) {
    lines.push("None declared.");
  } else {
    for (const rel of entity.relations) lines.push(`- ${rel.type} → \`${rel.targetRef}\``);
  }
  lines.push(
    "",
    "## Provenance",
    `- Project \`${entity.sourceProjectId}\` · environment ${entity.sourceEnvironment ?? "project-wide"} · commit ${entity.sourceCommit ?? "unknown"}`,
    `- Snapshot \`${entity.headDigest}\``,
    "",
    "## Docs",
  );
  if (docs.length === 0) {
    lines.push("No catalog docs.");
  } else {
    lines.push("| Key | Title | Role | Path | Digest |", "|---|---|---|---|---|");
    for (const doc of docs) {
      lines.push(
        `| ${doc.docKey} | ${doc.title} | ${doc.role} | \`${doc.path}\` | \`${doc.digest}\` |`,
      );
    }
  }
  if (overviewBody !== null) {
    // Same byte cap as `catalog_read_doc` — an oversized doc gets the
    // explicit truncation marker, never a silent cut.
    lines.push("", "## Overview", "", truncateText(overviewBody, maxTextBytes).text);
  }
  return lines.join("\n");
}

// ── runs://{workspace}/{project}/{runId} ────────────────────

export const runSummaryResource: McpResource = {
  name: "run_summary",
  template: new ResourceTemplate("runs://{workspace}/{project}/{runId}", {
    // No enumeration on resources/list (see module comment).
    list: () => ({ resources: [] }),
  }),
  metadata: {
    title: "Run summary",
    description:
      "One delivery run as markdown: status, git provenance, timings, and the plan-DAG job list with per-job statuses. Use `runs_list` to find run ids, and the `runs_read_logs` tool for a job's log output.",
    mimeType: RESOURCE_MIME_TYPE,
  },
  read: async (uri, variables, ctx) => {
    const workspace = requireVariable(variables, "workspace");
    const project = requireVariable(variables, "project");
    const runId = requireVariable(variables, "runId");
    const [runRes, jobsRes] = await Promise.all([
      ctx.sdk.state.getRun(workspace, project, runId),
      ctx.sdk.state.listRunJobs(workspace, project, runId),
    ]);
    return markdownResult(uri, runMarkdown(runRes.run, jobsRes.jobs));
  },
};

function runMarkdown(run: Run, jobs: RunJob[]): string {
  const counts = run.jobCounts;
  const lines: string[] = [
    `# Run ${run.runId} — ${run.status}`,
    "",
    `- **Project:** \`${run.projectId}\` · **Environment:** ${run.environment ?? "—"}`,
    `- **Source:** ${run.source} · \`${run.git.ref}\` @ \`${run.git.commit}\`${run.git.dirty ? " (dirty)" : ""}`,
    `- **Created:** ${run.createdAt} by ${run.createdBy.displayName ?? run.createdBy.id}`,
    `- **Started:** ${run.startedAt ?? "—"} · **Finished:** ${run.finishedAt ?? "—"}`,
    `- **Job counts:** ${counts.queued} queued · ${counts.running} running · ${counts.succeeded} succeeded · ${counts.failed} failed`,
    "",
    "## Jobs",
  ];
  if (jobs.length === 0) {
    lines.push("No jobs recorded.");
  } else {
    lines.push("| Job | Status | Attempt | Component | Error |", "|---|---|---|---|---|");
    for (const job of jobs) {
      lines.push(
        `| ${job.jobId} | ${job.status} | ${job.attempt} | ${job.component ?? "—"} | ${job.errorText ?? "—"} |`,
      );
    }
  }
  return lines.join("\n");
}

/** Every registered resource template (kept to the two design §6 names). */
export const allResources: ReadonlyArray<McpResource> = [
  catalogEntityResource,
  runSummaryResource,
];
