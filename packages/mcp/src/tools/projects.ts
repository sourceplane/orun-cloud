import type { PublicEnvironment, PublicProject } from "@saas/sdk";
import { z } from "zod";

import { projectArg, scopedShape } from "../scope.js";
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
  annotations: { readOnlyHint: true, idempotentHint: true },
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
