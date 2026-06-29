// Public "Workspace" vocabulary alias over the unchanged organization contract
// (saas-workspaces WS2 / specs/core/vocabulary.md).
//
// A **Workspace** is any `organizations` row in an **Account**; its public id
// `workspaceId` is the SAME opaque `org_*` value as `orgId`. The internal model,
// the `orgId` field, and `/v1/organizations/*` are all unchanged — `workspaceId`
// is a purely additive alias.
//
// At the edge, responses served on the `/v1/workspaces/*` path are projected to
// include `workspaceId` next to every `orgId` (api-edge `workspace-facade.ts`),
// and request bodies accept either spelling (`workspaceId` is normalized to
// `orgId`). These helpers let typed consumers (SDK/console) express that alias
// without re-modelling every org-scoped shape.

/**
 * Add the optional `workspaceId` alias alongside `orgId` on a response shape.
 * The value is identical to `orgId`; it is optional because the legacy
 * `/v1/organizations/*` surface does not project it.
 */
export type WithWorkspaceId<T> = T extends { orgId: string }
  ? T & { workspaceId?: string }
  : T;

/**
 * Accept either `orgId` or `workspaceId` on a request body. Both are the same
 * opaque `org_*` id; handlers normalize `workspaceId` to `orgId`.
 */
export type WorkspaceIdAlias =
  | { orgId: string; workspaceId?: string }
  | { workspaceId: string; orgId?: string };

/**
 * Resolve the canonical org id from a body that may use either spelling,
 * preferring the Workspace spelling when both are present (saas-workspaces A4).
 */
export function resolveWorkspaceOrgId(
  body: { orgId?: string | null; workspaceId?: string | null },
): string | undefined {
  const workspace = body.workspaceId?.trim();
  if (workspace) return workspace;
  const org = body.orgId?.trim();
  return org || undefined;
}
