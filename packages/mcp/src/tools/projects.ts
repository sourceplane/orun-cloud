import type {
  CreateEnvironmentRequest,
  CreateProjectRequest,
  PublicEnvironment,
  PublicProject,
} from "@saas/sdk";
import { z } from "zod";

import { idempotencyKeyArg, resolveIdempotencyKey } from "../idempotency.js";
import { compact, projectArg, scopedShape } from "../scope.js";
import { defineTool } from "../tool.js";

export const projectsListTool = defineTool({
  name: "projects_list",
  title: "List projects",
  description:
    "List the projects (git repos) in a workspace. Pass `project` (id or slug) to narrow to one project and inline its environments; without the filter environments are omitted to keep the call cheap.",
  inputSchema: z.object({
    ...scopedShape,
    project: projectArg
      .describe(
        "Optional project filter: a `prj_…` id or project slug. When set, the matched project's environments are included.",
      )
      .optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const res = await ctx.sdk.repos.list(input.workspace);
    const projects: PublicProject[] = res.projects;

    if (input.project === undefined) {
      const data = { projects } satisfies { projects: PublicProject[] };
      return { summary: `${projects.length} project(s)`, data };
    }

    const match = projects.find(
      (p) => p.id === input.project || p.slug === input.project,
    );
    if (match === undefined) {
      const data = { projects: [], environments: [] } satisfies {
        projects: PublicProject[];
        environments: PublicEnvironment[];
      };
      return {
        summary: `no project matching "${input.project}" in this workspace`,
        data,
      };
    }

    const envs = await ctx.sdk.environments.list(input.workspace, match.id);
    const data = {
      projects: [match],
      environments: envs.environments,
    } satisfies { projects: PublicProject[]; environments: PublicEnvironment[] };
    return {
      summary: `project ${match.slug} with ${envs.environments.length} environment(s)`,
      data,
    };
  },
});

// ---------------------------------------------------------------------------
// Write tools (MCP5, design §4/§7) — same public mutations as the console and
// CLI, policy-gated by the owning worker's deny-by-default RBAC and audited
// like every other API write. Retries are replay-safe: an Idempotency-Key is
// auto-generated per attempt (caller-suppliable via `idempotencyKey`).
// ---------------------------------------------------------------------------

export const projectCreateTool = defineTool({
  name: "project_create",
  title: "Create project",
  description:
    "Create a new project (git repo) in a workspace. This is a WRITE: it is policy-gated (requires a builder-or-higher role) and audited like any console/CLI mutation. Retries are replay-safe — an Idempotency-Key is generated per call unless you supply `idempotencyKey`. To browse existing projects use `projects_list` instead.",
  inputSchema: z.object({
    ...scopedShape,
    name: z.string().min(1).describe("Human-readable project name."),
    slug: z
      .string()
      .min(1)
      .describe("URL-safe slug. Omit to let the API derive one from the name.")
      .optional(),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const body = compact<CreateProjectRequest>({ name: input.name, slug: input.slug });
    const res = await ctx.sdk.repos.create(input.workspace, body, {
      idempotencyKey: resolveIdempotencyKey(input.idempotencyKey),
    });
    const data = { project: res.project } satisfies { project: PublicProject };
    return {
      summary: `created project ${res.project.slug} (${res.project.id})`,
      data,
    };
  },
});

export const environmentCreateTool = defineTool({
  name: "environment_create",
  title: "Create environment",
  description:
    "Create a new environment (e.g. staging) under a project. This is a WRITE: policy-gated (builder-or-higher role) and audited like any console/CLI mutation. Retries are replay-safe — an Idempotency-Key is generated per call unless you supply `idempotencyKey`. To browse existing environments use `projects_list` with the `project` filter.",
  inputSchema: z.object({
    ...scopedShape,
    project: projectArg,
    name: z.string().min(1).describe("Human-readable environment name."),
    slug: z
      .string()
      .min(1)
      .describe("URL-safe slug. Omit to let the API derive one from the name.")
      .optional(),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const body = compact<CreateEnvironmentRequest>({ name: input.name, slug: input.slug });
    const res = await ctx.sdk.environments.create(input.workspace, input.project, body, {
      idempotencyKey: resolveIdempotencyKey(input.idempotencyKey),
    });
    const data = { environment: res.environment } satisfies {
      environment: PublicEnvironment;
    };
    return {
      summary: `created environment ${res.environment.slug} (${res.environment.id})`,
      data,
    };
  },
});
