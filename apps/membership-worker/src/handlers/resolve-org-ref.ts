import type { Env } from "../env.js";
import type { MembershipRepository, Organization, MembershipResult } from "@saas/db/membership";
import { createMembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { isWorkspaceRef } from "@saas/db/ids";
import { successResponse, errorResponse } from "../http.js";
import { orgPublicId, parseOrgPublicId } from "../ids.js";

/**
 * Internal, service-binding-only resolution of any org reference spelling to the
 * canonical `org_<hex>` (epic `saas-workspace-id`, WID3). api-edge calls this to
 * rewrite a `ws_`/slug URL segment to `org_<hex>` at the edge so every bounded
 * context worker keeps receiving — and decoding — the opaque `org_<hex>` it
 * already handles. Resolution by spelling:
 *
 *   - `org_<hex>` → validate via `parseOrgPublicId` (no DB lookup; echo as-is);
 *   - `ws_<8>`    → `getOrganizationByPublicRef` (immutable public ref);
 *   - else        → `getOrganizationBySlug(ref.toLowerCase())` (mutable slug).
 *
 * Not routed by api-edge as a public path — it is reachable only over the
 * Cloudflare service binding, mirroring the sibling `/v1/internal/membership/*`
 * routes (subject-orgs, authorization-context, billing-parent).
 *
 * POST /v1/internal/membership/resolve-org-ref  { ref: string }
 *   200 { orgId: "org_<hex>", slug, publicRef }
 *   400 malformed `org_` ref / missing ref
 *   404 not found (unknown ws_/slug, or `org_` decodes but org row absent)
 */
export interface HandleResolveOrgRefDeps {
  repo?: Pick<MembershipRepository, "getOrganizationById" | "getOrganizationBySlug" | "getOrganizationByPublicRef">;
}

export async function handleResolveOrgRef(
  request: Request,
  env: Env,
  requestId: string,
  deps: HandleResolveOrgRefDeps = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed", 405, requestId);
  }
  if (!deps.repo && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const raw = (body as { ref?: unknown } | null)?.ref;
  if (typeof raw !== "string" || raw.length === 0) {
    return errorResponse("bad_request", "ref is required", 400, requestId);
  }

  const executor = deps.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps.repo ?? createMembershipRepository(executor!);

    let lookup: MembershipResult<Organization>;
    if (raw.startsWith("org_")) {
      const hex = parseOrgPublicId(raw);
      if (!hex) {
        return errorResponse("bad_request", "ref is malformed", 400, requestId);
      }
      lookup = await repo.getOrganizationById(hex);
    } else if (isWorkspaceRef(raw)) {
      lookup = await repo.getOrganizationByPublicRef(raw);
    } else {
      lookup = await repo.getOrganizationBySlug(raw.toLowerCase());
    }

    if (!lookup.ok) {
      if (lookup.error.kind === "not_found") {
        return errorResponse("not_found", "Not found", 404, requestId);
      }
      return errorResponse("internal_error", "Failed to resolve org ref", 503, requestId);
    }

    const org = lookup.value;
    return successResponse(
      { orgId: orgPublicId(org.id), slug: org.slug, publicRef: org.publicRef },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Failed to resolve org ref", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
