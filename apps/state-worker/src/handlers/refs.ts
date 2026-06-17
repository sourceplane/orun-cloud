// Hosted RefStore (OV1 — design-v2 §2, orun object-store.md §6).
//
// Refs are the L2 mutable, authoritative surface over the immutable object
// graph: a name → ObjectID pointer, updated by compare-and-swap. They are the
// heads of refs/sources|catalogs|revisions|executions per (org, project), and
// selecting a source/head (a branch, a PR, the current catalog) is resolving
// one. The CLI's RemoteRefStore + objmodel.Reader read views over (this RefStore
// + the existing ObjectStore), so `orun tui --remote` and the console share one
// read path with the local TUI.
//
// Policy: ref reads gate on state.object.read, ref writes on state.object.write
// (refs are the mutable layer of the object plane). Cross-tenant access 404s via
// authorizeRun's resource-hiding.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  GetRefResponse,
  UpdateRefResponse,
  ListRefsResponse,
  StateRef as PublicStateRef,
} from "@saas/contracts/state";
import { STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import { createStateRepository, type StateRef } from "@saas/db/state";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, successResponse, listResponse, validationError } from "../http.js";
import { authorizeRun } from "../authz.js";
import { generateUuid, orgPublicId, projectPublicId } from "../ids.js";
import { isValidDigest } from "../object-store.js";

export interface RefHandlerDeps {
  executor?: SqlExecutor;
}

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

// A legal ref name: non-empty, no leading/trailing slash, every "/"-separated
// segment matches [A-Za-z0-9._-] and is not "." or ".." (matches the orun
// refstore alphabet exactly, so a name round-trips between local and hosted).
const REF_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
export function isValidRefName(name: string): boolean {
  if (!name || name.startsWith("/") || name.endsWith("/")) return false;
  for (const seg of name.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
    if (!REF_SEGMENT_RE.test(seg)) return false;
  }
  return true;
}

function toPublicRef(r: StateRef): PublicStateRef {
  return {
    orgId: orgPublicId(r.orgId),
    projectId: projectPublicId(r.projectId),
    name: r.name,
    target: r.target,
    writer: r.writer,
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ── GET …/state/refs/{name} — resolve a ref ─────────────────

export async function handleGetRef(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  name: string,
  deps?: RefHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_READ);
  if (!authz.ok) return authz.response;

  if (!isValidRefName(name)) return errorResponse("not_found", "Not found", 404, requestId);

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const ref = await repo.getRef(orgId, projectId, name);
    if (!ref.ok) return errorResponse("not_found", `Ref ${name} not found`, 404, requestId);
    const payload: GetRefResponse = { ref: toPublicRef(ref.value) };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── PUT …/state/refs/{name} — compare-and-swap ──────────────

export async function handleUpdateRef(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  name: string,
  deps?: RefHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_WRITE);
  if (!authz.ok) return authz.response;

  if (!isValidRefName(name)) return errorResponse("not_found", "Not found", 404, requestId);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const fields: Record<string, string[]> = {};
  const target = typeof body.target === "string" ? body.target : "";
  if (!target || !isValidDigest(target)) fields.target = ["Required; 'sha256:<64 hex>'"];
  let expectedTarget = "";
  if (body.expectedTarget !== undefined && body.expectedTarget !== null) {
    if (typeof body.expectedTarget !== "string") fields.expectedTarget = ["Must be a string"];
    else expectedTarget = body.expectedTarget;
  }
  if (expectedTarget !== "" && !isValidDigest(expectedTarget)) {
    fields.expectedTarget = ["Must be 'sha256:<64 hex>' or empty"];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const result = await repo.updateRef({
      id: generateUuid(),
      orgId,
      projectId,
      name,
      expectedTarget,
      newTarget: target,
      writer: actor.subjectType,
    });
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    switch (result.value.kind) {
      case "updated": {
        const payload: UpdateRefResponse = { ref: toPublicRef(result.value.ref) };
        return successResponse(payload, requestId, 200);
      }
      case "target_missing":
        return errorResponse(
          "object_missing",
          `Ref target ${target} not found in the object plane; upload its closure first`,
          412,
          requestId,
          { digest: target },
        );
      case "conflict":
        return errorResponse(
          "ref_conflict",
          `Ref ${name} compare-and-swap lost: current target does not match expected`,
          409,
          requestId,
          { current: result.value.current ? result.value.current.target : null },
        );
    }
    // Unreachable: the outcome union is fully handled above.
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── GET …/state/refs?prefix= — list ref names ───────────────

export async function handleListRefs(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: RefHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_READ);
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") ?? "";
  // A non-empty prefix must itself be ref-path-shaped (segments may be partial,
  // but a leading slash or "../" is rejected) to keep the LIKE scan well-formed.
  if (prefix.includes("..") || prefix.startsWith("/")) {
    return validationError(requestId, { prefix: ["Malformed prefix"] });
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const result = await repo.listRefs(orgId, projectId, prefix);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const payload: ListRefsResponse = { refs: result.value.map(toPublicRef) };
    return listResponse(payload, requestId, null);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── DELETE …/state/refs/{name} — remove a ref ───────────────

export async function handleDeleteRef(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  name: string,
  deps?: RefHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_WRITE);
  if (!authz.ok) return authz.response;

  if (!isValidRefName(name)) return errorResponse("not_found", "Not found", 404, requestId);

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const result = await repo.deleteRef(orgId, projectId, name);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return new Response(null, { status: 204 });
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}
