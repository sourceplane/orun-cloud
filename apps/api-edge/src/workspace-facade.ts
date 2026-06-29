// Public "Workspace" vocabulary alias over the unchanged organization surface
// (saas-workspaces WS2). `/v1/workspaces/*` is a thin path-rewrite into the SAME
// org facades/handlers — no handler is forked — so the two spellings return
// identical results. `workspaceId` is the same opaque `org_*` id as `orgId`.
//
// The alias is applied at one chokepoint in index.ts: a `/v1/workspaces/*`
// request is rewritten to `/v1/organizations/*` before routing, and the JSON
// response is projected to carry `workspaceId` alongside every `orgId`. The
// legacy `/v1/organizations/*` surface is left byte-identical (the projection
// runs only on the alias path).

const WORKSPACE_PREFIX = "/v1/workspaces";
const ORG_PREFIX = "/v1/organizations";

/** True when the path targets the `/v1/workspaces` collection or a sub-path. */
export function isWorkspaceAliasRoute(pathname: string): boolean {
  return pathname === WORKSPACE_PREFIX || pathname.startsWith(WORKSPACE_PREFIX + "/");
}

/**
 * Rewrite a `/v1/workspaces…` path to its `/v1/organizations…` twin. The
 * `{workspaceId}` segment is the same opaque `org_*` id, so only the collection
 * segment changes.
 */
export function rewriteWorkspacePath(pathname: string): string {
  return ORG_PREFIX + pathname.slice(WORKSPACE_PREFIX.length);
}

/**
 * Build the request that is actually routed: a copy of the original with its URL
 * rewritten to the organizations path, so every downstream facade (org, project,
 * integrations, billing, …) sees the canonical `/v1/organizations/*` it already
 * handles. Method, headers, and body are preserved.
 */
export function rewriteToOrgRequest(request: Request, rewrittenPath: string): Request {
  const url = new URL(request.url);
  url.pathname = rewrittenPath;
  return new Request(url.toString(), request);
}

/**
 * Additively mirror `orgId` → `workspaceId` everywhere in a JSON value. Never
 * removes or overwrites: an existing `workspaceId` is left untouched; objects
 * without an `orgId` are unchanged. Returns a structurally new value.
 */
export function addWorkspaceIdDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(addWorkspaceIdDeep);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      out[key] = addWorkspaceIdDeep(val);
    }
    if (typeof obj.orgId === "string" && out.workspaceId === undefined) {
      out.workspaceId = obj.orgId;
    }
    return out;
  }
  return value;
}

/**
 * Project the `workspaceId` alias into a JSON response on the workspace-aliased
 * path. Non-JSON responses pass through untouched; a body that fails to parse is
 * returned unchanged (the original response is cloned for the parse attempt, so
 * its stream is never consumed on the failure path).
 */
export async function projectWorkspaceAlias(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return response;
  }

  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch {
    return response;
  }

  const projected = addWorkspaceIdDeep(parsed);
  const headers = new Headers(response.headers);
  // Length changes once workspaceId is added; let the runtime recompute it.
  headers.delete("content-length");
  return new Response(JSON.stringify(projected), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
