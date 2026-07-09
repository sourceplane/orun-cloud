// Tenancy scoping helpers (design §3): workspace/project is explicit tool
// input, never an ambient guess. The `workspace` value is passed through to
// the SDK verbatim — the api-edge resolver accepts `ws_…` | slug | `org_…`.

import type { ConfigScope } from "@saas/sdk";
import { z } from "zod";

import { ToolInputError } from "./errors.js";

export const workspaceArg = z
  .string()
  .min(1)
  .describe(
    "Workspace to read from: a `ws_…` workspace id, a workspace slug, or a legacy `org_…` id (passed through verbatim; the API resolves it). Use `whoami` or `workspaces_list` to discover yours.",
  );

export const projectArg = z
  .string()
  .min(1)
  .describe("Project (repo) public id (`prj_…`). Use `projects_list` to discover ids.");

/** Shared zod fragment for every workspace-scoped tool input. */
export const scopedShape = { workspace: workspaceArg };

// Pagination fragments shared by every cursor-paginated tool. Cursors are
// opaque server tokens returned in the tool's `data.meta.cursor`.
export const cursorArg = z
  .string()
  .min(1)
  .describe("Opaque continuation cursor from a previous page's `meta.cursor`; pass back verbatim.");

export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(100)
  .describe("Page size (the server clamps to its own bounds).");

/**
 * Encode a state-plane keyset cursor into the `createdAt|id` string the
 * endpoints accept (mirrors the console's `encodeCursor`).
 */
export function encodeStateCursor(
  cursor: { createdAt: string; id: string } | null,
): string | null {
  return cursor === null ? null : `${cursor.createdAt}|${cursor.id}`;
}

/**
 * Build the SDK's discriminated `ConfigScope` from explicit tool arguments.
 * `environment` requires `project` (the config surface has no org+environment
 * scope).
 */
export function configScopeFromInput(input: {
  workspace: string;
  project?: string | undefined;
  environment?: string | undefined;
}): ConfigScope {
  if (input.environment !== undefined) {
    if (input.project === undefined) {
      throw new ToolInputError("`environment` requires `project` to be set");
    }
    return {
      kind: "environment",
      orgId: input.workspace,
      projectId: input.project,
      environmentId: input.environment,
    };
  }
  if (input.project !== undefined) {
    return { kind: "project", orgId: input.workspace, projectId: input.project };
  }
  return { kind: "organization", orgId: input.workspace };
}

/**
 * Strip `undefined` entries so optional SDK query fields typecheck under
 * `exactOptionalPropertyTypes` without a conditional spread per field.
 */
export function compact<T extends object>(input: {
  [K in keyof T]: T[K] | undefined;
}): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
