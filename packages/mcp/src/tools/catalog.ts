import type { CatalogDoc, OrgCatalogEntity } from "@saas/contracts/state";
import { z } from "zod";

import {
  compact,
  cursorArg,
  encodeStateCursor,
  limitArg,
  projectArg,
  scopedShape,
} from "../scope.js";
import { defineTool } from "../tool.js";
import { truncateText } from "../truncate.js";

import type { StateClient } from "@saas/sdk";

// The SDK does not export its state query interfaces; derive them so the
// compact() calls stay pinned to the real method signatures.
type OrgCatalogEntitiesQuery = NonNullable<
  Parameters<StateClient["listOrgCatalogEntities"]>[1]
>;
type CatalogDocsQuery = NonNullable<Parameters<StateClient["listCatalogDocs"]>[1]>;

export const catalogSearchTool = defineTool({
  name: "catalog_search",
  title: "Search the service catalog",
  description:
    "Search the workspace's org-wide service catalog (the merged, git-derived component graph). Facets: `kind`, `owner`, `project`, `environment`; `q` free-text matches name or entityRef. For one known entityRef use `catalog_get_entity` instead.",
  inputSchema: z.object({
    ...scopedShape,
    project: projectArg.optional(),
    environment: z.string().min(1).describe("Environment slug filter.").optional(),
    kind: z
      .string()
      .min(1)
      .describe("Entity kind facet (Component | API | System | …).")
      .optional(),
    owner: z.string().min(1).describe("Owner facet.").optional(),
    q: z.string().min(1).describe("Free-text match over name/entityRef.").optional(),
    cursor: cursorArg.optional(),
    limit: limitArg.optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx) => {
    const page = await ctx.sdk.state.listOrgCatalogEntities(
      input.workspace,
      compact<OrgCatalogEntitiesQuery>({
        project: input.project,
        environment: input.environment,
        kind: input.kind,
        owner: input.owner,
        q: input.q,
        cursor: input.cursor,
        limit: input.limit,
      }),
    );
    const data = {
      entities: page.entities,
      meta: { cursor: encodeStateCursor(page.nextCursor) },
    } satisfies { entities: OrgCatalogEntity[]; meta: { cursor: string | null } };
    return { summary: `${page.entities.length} catalog entit(y/ies)`, data };
  },
});

export const catalogGetEntityTool = defineTool({
  name: "catalog_get_entity",
  title: "Get a catalog entity",
  description:
    "Fetch one catalog entity by its exact entityRef (e.g. `component:default/api`): identity, owner, relations, and provenance. Use `catalog_search` when you don't know the exact ref.",
  inputSchema: z.object({
    ...scopedShape,
    entityRef: z
      .string()
      .min(1)
      .describe("Exact entity ref, e.g. `component:default/api`."),
    project: projectArg
      .describe("Optional provenance filter (`prj_…`) when the ref exists in several projects.")
      .optional(),
    environment: z.string().min(1).describe("Optional environment slug filter.").optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx) => {
    // SC0's `state.getOrgCatalogEntity` has not shipped (epic saas-mcp-server,
    // risk D2): emulate the getter by exact-filtering the OV6 list endpoint.
    // Migrate to the dedicated getter when SC0 lands — contract-compatible.
    const page = await ctx.sdk.state.listOrgCatalogEntities(
      input.workspace,
      compact<OrgCatalogEntitiesQuery>({
        q: input.entityRef,
        project: input.project,
        environment: input.environment,
        limit: 100,
      }),
    );
    const entities = page.entities.filter((e) => e.entityRef === input.entityRef);
    const data = { entities } satisfies { entities: OrgCatalogEntity[] };
    return {
      summary:
        entities.length === 0
          ? `no catalog entity with ref "${input.entityRef}"`
          : `${entities.length} match(es) for ${input.entityRef}`,
      data,
    };
  },
});

export const catalogReadDocTool = defineTool({
  name: "catalog_read_doc",
  title: "Browse and read catalog docs",
  description:
    "Browse the workspace's git-authored catalog docs (filter by `entityRef`, `role`, `project`, `q`), or pass `digest` (from a browse row or an entity's docRef) to read one doc's markdown body, byte-capped. Not for run logs — use `runs_read_logs`.",
  inputSchema: z.object({
    ...scopedShape,
    digest: z
      .string()
      .min(1)
      .describe("Content digest (`sha256:…`) of a doc body to read. When set, all browse filters are ignored.")
      .optional(),
    entityRef: z.string().min(1).describe("Narrow the doc index to one entity's doc set.").optional(),
    project: projectArg.optional(),
    environment: z.string().min(1).describe("Environment slug filter.").optional(),
    role: z
      .string()
      .min(1)
      .describe("Doc role slug (overview | guide | runbook | architecture | …).")
      .optional(),
    q: z.string().min(1).describe("Free-text match over title/path/entity name.").optional(),
    cursor: cursorArg.optional(),
    limit: limitArg.optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx) => {
    if (input.digest !== undefined) {
      const body = await ctx.sdk.state.readCatalogDoc(input.workspace, input.digest);
      const capped = truncateText(body, ctx.limits.maxTextBytes);
      const data = {
        digest: input.digest,
        content: capped.text,
        truncated: capped.truncated,
        truncatedBytes: capped.truncatedBytes,
      };
      return {
        summary: `doc body ${input.digest}${capped.truncated ? " (truncated)" : ""}`,
        data,
      };
    }
    const page = await ctx.sdk.state.listCatalogDocs(
      input.workspace,
      compact<CatalogDocsQuery>({
        project: input.project,
        environment: input.environment,
        entityRef: input.entityRef,
        role: input.role,
        q: input.q,
        cursor: input.cursor,
        limit: input.limit,
      }),
    );
    const data = {
      docs: page.docs,
      meta: { cursor: encodeStateCursor(page.nextCursor) },
    } satisfies { docs: CatalogDoc[]; meta: { cursor: string | null } };
    return {
      summary: `${page.docs.length} doc(s); pass a row's digest to read its body`,
      data,
    };
  },
});
