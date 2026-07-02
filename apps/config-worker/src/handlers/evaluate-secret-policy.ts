import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Scope, SecretPolicyRecord } from "@saas/db/config";
import type { ConfigRepository } from "@saas/db/config";
import { createConfigRepository } from "@saas/db/config";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import {
  evaluateSecretPolicy,
  parseSecretPolicyDocument,
  type Platform,
  type SecretPolicyDocument,
  type SecretPolicyFacts,
} from "../secret-policy.js";
import type { PolicyResource } from "@saas/contracts/policy";

const PLATFORMS: Platform[] = ["local-cli", "ci-oidc", "service"];

export interface EvaluateSecretPolicyDeps {
  repo: Pick<ConfigRepository, "listSecretPolicies">;
  /** Layer-1 decision injector for tests; production uses the policy round-trip. */
  layer1?: (action: string) => Promise<boolean>;
}

/**
 * POST …/config/secret-policies/evaluate (saas-secret-manager SM3). A dry-run
 * that reports BOTH layers for a hypothetical resolve — the engine behind
 * `orun policy test`. Layer-1 `secret.read` to run the tool itself; it then
 * reports the `secret.value.use` (Layer-1) and SecretPolicy (Layer-2) outcomes
 * without serving any value.
 */
export async function handleEvaluateSecretPolicy(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
  deps?: EvaluateSecretPolicyDeps,
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
  const key = typeof raw.key === "string" ? raw.key : "";
  if (!key) fields.key = ["key is required"];
  const envSlug = typeof raw.env === "string" ? raw.env : "";
  if (!envSlug) fields.env = ["env is required"];
  const platform = typeof raw.platform === "string" && PLATFORMS.includes(raw.platform as Platform)
    ? (raw.platform as Platform)
    : undefined;
  if (!platform) fields.platform = ["platform must be one of: local-cli, ci-oidc, service"];
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const subjectRaw = (raw.subject ?? {}) as Record<string, unknown>;
  const facts: SecretPolicyFacts = {
    subject: {
      id: typeof subjectRaw.id === "string" ? subjectRaw.id : actor.subjectId,
      kind: normalizeKind(typeof subjectRaw.kind === "string" ? subjectRaw.kind : actor.subjectType),
      teams: Array.isArray(subjectRaw.teams) ? subjectRaw.teams.filter((t): t is string => typeof t === "string") : [],
    },
    env: envSlug,
    platform: platform!,
    ...(raw.component && typeof raw.component === "object" ? { component: raw.component as NonNullable<SecretPolicyFacts["component"]> } : {}),
    ...(raw.trigger && typeof raw.trigger === "object" ? { trigger: raw.trigger as NonNullable<SecretPolicyFacts["trigger"]> } : {}),
    ...(typeof raw.servesFrom === "string" ? { servesFrom: raw.servesFrom as NonNullable<SecretPolicyFacts["servesFrom"]> } : {}),
  };

  // Authorization to RUN the dry-run (secret.read) + the Layer-1 probe of the
  // resolve action (secret.value.use), both via the policy round-trip.
  let layer1Allow: boolean;
  if (deps?.layer1) {
    // Test path: the dry-run gate is assumed passed; layer1 injects the probe.
    layer1Allow = await deps.layer1("secret.value.use");
  } else {
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
    if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const resource: PolicyResource = { kind: scope.kind === "organization" ? "organization" : "project", orgId: scope.orgId };
    if ("projectId" in scope) resource.projectId = scope.projectId;
    const readGate = await authorizeViaPolicy(env.POLICY_WORKER, actor.subjectId, actor.subjectType, "secret.read", resource, contextResult.memberships, requestId);
    if (!readGate.allow) return errorResponse("not_found", "Not found", 404, requestId);
    const useProbe = await authorizeViaPolicy(env.POLICY_WORKER, actor.subjectId, actor.subjectType, "secret.value.use", resource, contextResult.memberships, requestId);
    layer1Allow = useProbe.allow;
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);
    const listed = await repo.listSecretPolicies({ orgId: scope.orgId, projectId: "projectId" in scope ? scope.projectId : null });
    if (!listed.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const documents = toDocuments(listed.value);
    const layer2 = evaluateSecretPolicy(documents, key, facts);

    return successResponse(
      {
        layer1: { action: "secret.value.use", allow: layer1Allow, reason: layer1Allow ? "granted" : "denied" },
        layer2,
        decision: { allow: layer1Allow && layer2.allow },
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

function normalizeKind(kind: string): SecretPolicyFacts["subject"]["kind"] {
  if (kind === "workflow" || kind === "service_principal") return kind;
  return "user";
}

/** Records arrive already tier-ordered (composition → stack → intent) from the
 *  repository; parse each into the evaluator shape, preserving that order. */
export function toDocuments(records: SecretPolicyRecord[]): SecretPolicyDocument[] {
  return records.map((r) => parseSecretPolicyDocument(r.tier, r.document));
}
