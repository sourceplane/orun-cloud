// Admission grant management (IT8b): an account admin governs which workspaces
// may consume an account-shared connection, and switches its share mode.
//
// All routes are authorized as organization.integration.manage against the
// connection's OWNING (account) org — the {orgId} in the path — exactly like
// connect/revoke. A grant is keyed by the admitted workspace org.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PolicyResource } from "@saas/contracts/policy";
import {
  INTEGRATION_POLICY_ACTIONS,
  type CreateConnectionGrantResponse,
  type ListConnectionGrantsResponse,
  type RevokeConnectionGrantResponse,
  type UpdateConnectionResponse,
} from "@saas/contracts/integrations";
import { createIntegrationsRepository } from "@saas/db/integrations";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid, type Uuid } from "@saas/db/ids";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, listResponse, successResponse, validationError } from "../http.js";
import { toPublicConnection, toPublicConnectionGrant } from "../mappers.js";
import { generateUuid, parseOrgPublicId } from "../ids.js";
import { uuidFromPublicId } from "@saas/db/ids";

export interface GrantHandlerDeps {
  executor?: SqlExecutor;
}

function resolveExecutor(env: Env, deps?: GrantHandlerDeps): { executor: SqlExecutor; owned: boolean } {
  if (deps?.executor) return { executor: deps.executor, owned: false };
  return { executor: createSqlExecutor(env.PLATFORM_DB!), owned: true };
}

async function disposeIfOwned(executor: SqlExecutor, owned: boolean): Promise<void> {
  if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

/** Account-admin authorization against the connection-owning org. */
async function authorizeManage(
  env: Env,
  actor: ActorContext,
  orgId: string,
  requestId: string,
): Promise<Response | null> {
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);
  const resource: PolicyResource = { kind: "organization", orgId };
  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    INTEGRATION_POLICY_ACTIONS.MANAGE,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) return errorResponse("not_found", "Not found", 404, requestId);
  return null;
}

// ── List grants ─────────────────────────────────────────────

export async function handleListConnectionGrants(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: GrantHandlerDeps,
): Promise<Response> {
  const denied = await authorizeManage(env, actor, orgId, requestId);
  if (denied) return denied;

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    // The connection must belong to THIS org (the account owns it).
    const connection = await repo.getConnection(orgId, connectionId);
    if (!connection.ok) return errorResponse("not_found", "Not found", 404, requestId);

    const grants = await repo.listConnectionGrants(connectionId);
    if (!grants.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const payload: ListConnectionGrantsResponse = {
      grants: grants.value.map(toPublicConnectionGrant),
    };
    return listResponse(payload, requestId, null);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}

// ── Create grant (admit a workspace) ────────────────────────

export async function handleCreateConnectionGrant(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: GrantHandlerDeps,
): Promise<Response> {
  const denied = await authorizeManage(env, actor, orgId, requestId);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const workspaceOrgUuid =
    typeof body.workspaceOrgId === "string" ? parseOrgPublicId(body.workspaceOrgId) : null;
  if (!workspaceOrgUuid) {
    return validationError(requestId, { workspaceOrgId: ["Required (org_…)"] });
  }
  // A connection is never granted to its own owning org (it already owns it).
  if (workspaceOrgUuid === orgId) {
    return validationError(requestId, {
      workspaceOrgId: ["The owning account does not need a grant"],
    });
  }

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    const connection = await repo.getConnection(orgId, connectionId);
    if (!connection.ok) return errorResponse("not_found", "Not found", 404, requestId);
    if (connection.value.scope !== "account") {
      return errorResponse(
        "precondition_failed",
        "Only account-shared connections support admission grants",
        412,
        requestId,
        { reason: "not_account_scoped" },
      );
    }

    const created = await repo.createConnectionGrant({
      id: generateUuid(),
      connectionId,
      orgId: asUuid(workspaceOrgUuid),
      grantedBy: uuidFromPublicId(actor.subjectId),
    });
    if (!created.ok) {
      if (created.error.kind === "conflict") {
        return errorResponse("conflict", "This workspace is already admitted", 409, requestId, {
          reason: "already_granted",
        });
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const payload: CreateConnectionGrantResponse = { grant: toPublicConnectionGrant(created.value) };
    return successResponse(payload, requestId, 201);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}

// ── Revoke grant ────────────────────────────────────────────

export async function handleRevokeConnectionGrant(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  workspaceOrgId: Uuid,
  deps?: GrantHandlerDeps,
): Promise<Response> {
  const denied = await authorizeManage(env, actor, orgId, requestId);
  if (denied) return denied;

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    const connection = await repo.getConnection(orgId, connectionId);
    if (!connection.ok) return errorResponse("not_found", "Not found", 404, requestId);

    const revoked = await repo.revokeConnectionGrant(connectionId, workspaceOrgId);
    if (!revoked.ok) return errorResponse("not_found", "Not found", 404, requestId);

    const payload: RevokeConnectionGrantResponse = { revoked: true };
    return successResponse(payload, requestId);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}

// ── Set share mode ──────────────────────────────────────────

export async function handleUpdateConnection(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: GrantHandlerDeps,
): Promise<Response> {
  const denied = await authorizeManage(env, actor, orgId, requestId);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  if (body.shareMode !== "auto" && body.shareMode !== "granted") {
    return validationError(requestId, { shareMode: ["Must be 'auto' or 'granted'"] });
  }

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    const connection = await repo.getConnection(orgId, connectionId);
    if (!connection.ok) return errorResponse("not_found", "Not found", 404, requestId);
    if (connection.value.scope !== "account") {
      return errorResponse(
        "precondition_failed",
        "Only account-shared connections have an admission posture",
        412,
        requestId,
        { reason: "not_account_scoped" },
      );
    }

    const updated = await repo.updateConnectionShareMode(orgId, connectionId, body.shareMode);
    if (!updated.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const payload: UpdateConnectionResponse = { connection: toPublicConnection(updated.value) };
    return successResponse(payload, requestId);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}
