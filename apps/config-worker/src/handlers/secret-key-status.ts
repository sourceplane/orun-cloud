import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { OrgScope, SecretDekRepository } from "@saas/db/config";
import { createSecretDekRepository } from "@saas/db/config";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse } from "../http.js";
import { isValidKeyHex } from "../encryption.js";
import type { PolicyResource } from "@saas/contracts/policy";
import type { SecretKeyStatus } from "@saas/contracts/config";

export interface SecretKeyStatusDeps {
  dekRepo: Pick<SecretDekRepository, "getActiveDek" | "countEnvelopeVersions">;
  /** Overrides the env-derived KEK presence flag in tests. */
  kekConfigured?: boolean;
}

/**
 * Workspace key-hierarchy status (saas-secret-manager SM2):
 * `GET …/config/secrets/key-status`, org scope, `secret.read`. Reports whether
 * the KEK is configured, the active DEK generation, and the stored envelope
 * counts by format version — the metric that drives the k0 retirement date
 * (orun-secrets R-13). Numbers and booleans only; no key material, no
 * ciphertext, no envelope bytes cross this surface.
 */
export async function handleSecretKeyStatus(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: OrgScope,
  deps?: SecretKeyStatusDeps,
): Promise<Response> {
  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.MEMBERSHIP_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  // Authorization (read)
  if (!deps) {
    const contextResult = await fetchAuthorizationContext(
      env.MEMBERSHIP_WORKER!,
      actor.subjectId,
      actor.subjectType,
      scope.orgId,
      requestId,
    );
    if (!contextResult.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const resource: PolicyResource = { kind: "organization", orgId: scope.orgId };
    const policyResult = await authorizeViaPolicy(
      env.POLICY_WORKER!,
      actor.subjectId,
      actor.subjectType,
      "secret.read",
      resource,
      contextResult.memberships,
      requestId,
    );
    if (!policyResult.allow) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const dekRepo = deps?.dekRepo ?? createSecretDekRepository(executor!);

    const dekResult = await dekRepo.getActiveDek(scope.orgId);
    if (!dekResult.ok && dekResult.error.kind !== "not_found") {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const countsResult = await dekRepo.countEnvelopeVersions(scope.orgId);
    if (!countsResult.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const keyStatus: SecretKeyStatus = {
      kekConfigured: deps?.kekConfigured ?? isValidKeyHex(env.SECRET_KEK),
      activeGeneration: dekResult.ok ? dekResult.value.generation : null,
      envelopes: { v1: countsResult.value.v1Count, v2: countsResult.value.v2Count },
    };

    return successResponse({ keyStatus }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
