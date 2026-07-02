import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Scope, PutSecretPolicyInput, SecretPolicyTier } from "@saas/db/config";
import type { ConfigRepository } from "@saas/db/config";
import type { MembershipRepository } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createConfigRepository } from "@saas/db/config";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { validateSecretPolicyDocument } from "../secret-policy.js";
import { SECRET_EVENT_TYPES } from "../secret-events.js";
import type { PolicyResource } from "@saas/contracts/policy";

const NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const TIERS: SecretPolicyTier[] = ["composition", "stack", "intent"];

export interface PutSecretPolicyDeps {
  repo: Pick<ConfigRepository, "putSecretPolicy">;
  membershipRepo?: Pick<MembershipRepository, "getOrganizationById">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  generateId?: () => string;
  now?: () => Date;
}

/** Canonical content hash of a SecretPolicy document (push idempotency key). */
async function hashDocument(document: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i]!.toString(16).padStart(2, "0");
  return hex;
}

/**
 * PUT …/config/secret-policies (saas-secret-manager SM3). Push a tier-tagged
 * SecretPolicy document — the Layer-2 conditions the resolve evaluates. Layer-1
 * `secret.write`. Idempotent by document hash; the document's tenancy scope
 * comes from the route (workspace-wide vs project). The body carries no value.
 */
export async function handlePutSecretPolicy(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
  deps?: PutSecretPolicyDeps,
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

  const { name, tier, source, document } = body as {
    name?: unknown;
    tier?: unknown;
    source?: unknown;
    document?: unknown;
  };
  const fields: Record<string, string[]> = {};
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    fields.name = ["A valid name is required (letters, digits, dots, hyphens, underscores; 1-128 chars)"];
  }
  if (typeof tier !== "string" || !TIERS.includes(tier as SecretPolicyTier)) {
    fields.tier = ["tier must be one of: composition, stack, intent"];
  }
  if (typeof source !== "string" || source.length === 0 || source.length > 256) {
    fields.source = ["source must be a non-empty string (<= 256 chars)"];
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fields.document = ["document must be a SecretPolicy spec object"];
  } else {
    // Locked-vocabulary validation (SM3 pinned rule): an unknown predicate,
    // subject spelling, scope shape, or rule field is a validation error AT
    // PUT TIME — it must never surface at resolve time. All violations are
    // reported at once so `orun policy push` shows the full lint result.
    const documentErrors = validateSecretPolicyDocument(document);
    if (documentErrors.length > 0) fields.document = documentErrors;
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  // Layer-1 RBAC (SM3): a policy push is a secret.write.
  const authzErr = await authorizeSecretWrite(env, requestId, actor, scope, deps);
  if (authzErr) return authzErr;

  const documentHash = await hashDocument(document);
  const genId = deps?.generateId ?? (() => crypto.randomUUID());
  const now = deps?.now ? deps.now() : new Date();
  const input: PutSecretPolicyInput = {
    id: crypto.randomUUID(),
    orgId: scope.orgId,
    projectId: "projectId" in scope ? scope.projectId : null,
    name: name as string,
    tier: tier as SecretPolicyTier,
    source: source as string,
    document: document as Record<string, unknown>,
    documentHash,
  };

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);
    const result = await repo.putSecretPolicy(input);
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    // Emit a policy-updated event only when the stored document actually changed
    // (idempotent re-push is a no-op — no audit noise).
    if (result.value.updated) {
      const eventsRepo = deps?.eventsRepo ?? (executor ? createEventsRepository(executor) : null);
      if (eventsRepo) {
        const eventResult = await eventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: SECRET_EVENT_TYPES.POLICY_UPDATED,
            version: 1,
            source: "config-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId: scope.orgId,
            projectId: "projectId" in scope ? scope.projectId : null,
            subjectKind: "secret_policy",
            subjectId: result.value.record.id,
            subjectName: result.value.record.name,
            requestId,
            payload: {
              name: result.value.record.name,
              tier: result.value.record.tier,
              source: result.value.record.source,
              documentHash: result.value.record.documentHash,
              scope: scope.kind,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Secret policy pushed: ${result.value.record.name} (${result.value.record.tier})`,
            projectId: "projectId" in scope ? scope.projectId : null,
          },
        });
        if (!eventResult.ok) {
          return errorResponse("internal_error", "Service unavailable", 503, requestId);
        }
      }
    }

    return successResponse(
      {
        policy: {
          name: result.value.record.name,
          tier: result.value.record.tier,
          source: result.value.record.source,
          scope: scope.kind,
          documentHash: result.value.record.documentHash,
          updated: result.value.updated,
        },
      },
      requestId,
      result.value.updated ? 200 : 200,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/** Layer-1 `secret.write` gate, mirroring create-secret. Returns an error
 *  Response on denial, or null to proceed. Skipped on the deps (test) path. */
async function authorizeSecretWrite(
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
  deps?: PutSecretPolicyDeps,
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
