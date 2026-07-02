import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Scope, RecordSecretSyncInput } from "@saas/db/config";
import type { ConfigRepository } from "@saas/db/config";
import type { MembershipRepository } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createConfigRepository } from "@saas/db/config";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { toPublicSecretSync } from "../mappers.js";
import type { PolicyResource } from "@saas/contracts/policy";

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;
const REF_MAX = 512;

/** No value ever rides a sync record — it is provenance metadata only. */
const FORBIDDEN_VALUE_FIELDS = ["value", "plaintext", "secret", "ciphertext", "ciphertextEnvelope"];

export interface RecordSecretSyncDeps {
  repo: Pick<ConfigRepository, "recordSecretSync" | "getSecretMetadataByScopeKey">;
  membershipRepo?: Pick<MembershipRepository, "getOrganizationById">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  generateId?: () => string;
  now?: () => Date;
}

/**
 * POST …/config/secrets/syncs (saas-secret-manager SM5). Records that a deploy
 * run's materialize step pushed `secretKey`@`version` into `entityRef` on
 * `target`. Resolves `secretKey` -> secret_id within the request scope (404 if
 * absent), records the sync (superseding any prior live sync for the same
 * target+entity), emits `secret.sync.recorded` (payload key/version/target/
 * entityRef/runId — NEVER a value), and returns the recorded row. `secret.write`.
 */
export async function handleRecordSecretSync(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
  deps?: RecordSecretSyncDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be a JSON object"] });
  }

  const raw = body as Record<string, unknown>;
  const fields: Record<string, string[]> = {};

  for (const forbidden of FORBIDDEN_VALUE_FIELDS) {
    if (forbidden in raw) {
      fields[forbidden] = ["A sync record carries no secret value"];
    }
  }

  const { secretKey, version, target, entityRef, runId } = raw as {
    secretKey?: unknown;
    version?: unknown;
    target?: unknown;
    entityRef?: unknown;
    runId?: unknown;
  };

  if (typeof secretKey !== "string" || !KEY_RE.test(secretKey)) {
    fields.secretKey = ["A valid secretKey is required (letters, digits, dots, hyphens, underscores; 1-128 chars)"];
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    fields.version = ["version must be a positive integer"];
  }
  if (typeof target !== "string" || target.length === 0 || target.length > REF_MAX) {
    fields.target = ["target must be a non-empty string (<= 512 chars)"];
  }
  if (typeof entityRef !== "string" || entityRef.length === 0 || entityRef.length > REF_MAX) {
    fields.entityRef = ["entityRef must be a non-empty string (<= 512 chars)"];
  }
  if (typeof runId !== "string" || runId.length === 0 || runId.length > REF_MAX) {
    fields.runId = ["runId must be a non-empty string (<= 512 chars)"];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  // Layer-1 RBAC (SM5): recording a sync is a secret.write.
  const authzErr = await authorizeSecretWrite(env, requestId, actor, scope, deps);
  if (authzErr) return authzErr;

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const genId = deps?.generateId ?? (() => crypto.randomUUID());
  const now = deps?.now ? deps.now() : new Date();

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);

    // Resolve the secret within the request scope (shared row). Resource-hiding
    // 404 when the key does not exist in scope.
    const secret = await repo.getSecretMetadataByScopeKey(scope, secretKey as string);
    if (!secret.ok) {
      if (secret.error.kind === "not_found") {
        return errorResponse("not_found", "Secret not found", 404, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const input: RecordSecretSyncInput = {
      id: crypto.randomUUID(),
      scope,
      secretId: secret.value.id,
      version: version as number,
      target: target as string,
      entityRef: entityRef as string,
      runId: runId as string,
    };
    const result = await repo.recordSecretSync(input);
    if (!result.ok) {
      if (result.error.kind === "conflict") {
        return errorResponse("conflict", "A concurrent sync already holds this entity", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const eventsRepo = deps?.eventsRepo ?? (executor ? createEventsRepository(executor) : null);
    if (eventsRepo) {
      const eventResult = await eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: "secret.sync.recorded",
          version: 1,
          source: "config-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId: scope.orgId,
          projectId: "projectId" in scope ? scope.projectId : null,
          environmentId: "environmentId" in scope ? scope.environmentId : null,
          subjectKind: "secret_sync",
          subjectId: result.value.id,
          requestId,
          payload: {
            // Provenance metadata ONLY — never a secret value.
            key: secret.value.secretKey,
            version: result.value.version,
            target: result.value.target,
            entityRef: result.value.entityRef,
            runId: result.value.runId,
            status: result.value.status,
          },
        },
        audit: {
          id: genId(),
          category: "config",
          description: `Secret sync recorded: ${secret.value.secretKey} -> ${result.value.target}/${result.value.entityRef}`,
          projectId: "projectId" in scope ? scope.projectId : null,
          environmentId: "environmentId" in scope ? scope.environmentId : null,
        },
      });
      if (!eventResult.ok) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
    }

    return successResponse({ sync: toPublicSecretSync(result.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/** Layer-1 `secret.write` gate (mirrors create-secret / put-secret-policy).
 *  Returns an error Response on denial, or null to proceed. Skipped on deps. */
async function authorizeSecretWrite(
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
  deps?: RecordSecretSyncDeps,
): Promise<Response | null> {
  if (deps) return null;
  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    scope.orgId,
    requestId,
  );
  if (!contextResult.ok) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const resource: PolicyResource = { kind: scope.kind === "organization" ? "organization" : "project", orgId: scope.orgId };
  if ("projectId" in scope) resource.projectId = scope.projectId;
  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER,
    actor.subjectId,
    actor.subjectType,
    "secret.write",
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  return null;
}
