import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository, Scope } from "@saas/db/config";
import type { EventsRepository } from "@saas/db/events";
import { createConfigRepository } from "@saas/db/config";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { uuidFromPublicId } from "@saas/db";
import { toPublicSecretMetadata } from "../mappers.js";
import { scopeMatchesRequested } from "../scope-match.js";
import type { PolicyResource } from "@saas/contracts/policy";
import type { SecretBrokerBinding } from "@saas/contracts/config";
import {
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_POLICY_ACTIONS,
  type ValidateBrokerBindingRequest,
} from "@saas/contracts/integrations";
import { validateBrokerBinding, type BrokerBindingValidation } from "../integrations-client.js";

// Repoint a brokered secret's binding to a different connection
// (brokered-orphan-safety, Feature 7): the recovery path for an orphaned head.
// PATCH .../config/secrets/{id} with `{ binding: { connectionId, template?,
// params? } }`. The value is never touched — only the pointer moves. Guarded by
// the SAME dual policy as a brokered create ("you cannot bind authority you
// could not mint"): secret.write AND organization.integration.credential.issue.

const CONNECTION_ID_RE = /^int_[0-9a-f]{32}$/;
const TEMPLATE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BINDING_PARAM_KEYS = 10;

export interface RepointSecretDeps {
  repo: Pick<ConfigRepository, "getSecretMetadata" | "repointBrokeredSecret">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  generateId?: () => string;
  now?: () => Date;
  /** IH7 seam: broker validate-binding (tests). Production wires
   * validateBrokerBinding over the INTEGRATIONS_WORKER service binding. */
  validateBinding?: (req: ValidateBrokerBindingRequest) => Promise<BrokerBindingValidation>;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Parse and validate the `{ binding }` PATCH body. template is optional — when
 *  omitted the existing binding's template is reused (the common "same grant,
 *  live connection" repoint). Returns the shape sans template resolution. */
function parseBody(body: unknown): { connectionId: string; template?: string; params?: Record<string, unknown> } | { error: Record<string, string[]> } {
  if (!body || typeof body !== "object") {
    return { error: { body: ["Request body must be a JSON object"] } };
  }
  const raw = body as Record<string, unknown>;
  const binding = raw.binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return { error: { binding: ["binding must be an object { connectionId, template?, params? }"] } };
  }
  const b = binding as Record<string, unknown>;
  const errs: string[] = [];
  if (typeof b.connectionId !== "string" || !CONNECTION_ID_RE.test(b.connectionId)) {
    errs.push("binding.connectionId must be a connection public id (int_<32 hex>)");
  }
  let template: string | undefined;
  if (b.template !== undefined) {
    if (typeof b.template !== "string" || !TEMPLATE_RE.test(b.template)) {
      errs.push("binding.template must be a template id (lowercase letters, digits, hyphens; 1-64 chars)");
    } else {
      template = b.template;
    }
  }
  let params: Record<string, unknown> | undefined;
  if (b.params !== undefined) {
    if (!b.params || typeof b.params !== "object" || Array.isArray(b.params)) {
      errs.push("binding.params must be a plain object");
    } else if (Object.keys(b.params).length > MAX_BINDING_PARAM_KEYS) {
      errs.push(`binding.params allows at most ${MAX_BINDING_PARAM_KEYS} keys`);
    } else if (Object.keys(b.params).length > 0) {
      params = b.params as Record<string, unknown>;
    }
  }
  if (errs.length > 0) return { error: { binding: errs } };
  return { connectionId: b.connectionId as string, ...(template ? { template } : {}), ...(params ? { params } : {}) };
}

export async function handleRepointSecret(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  requestedScope: Scope,
  secretId: string,
  deps?: RepointSecretDeps,
): Promise<Response> {
  const orgId = requestedScope.orgId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const parsed = parseBody(body);
  if ("error" in parsed) return validationError(requestId, parsed.error);

  if (!deps && (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER)) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const genId = deps?.generateId ?? (() => randomHex(16));
  const now = deps?.now ? deps.now() : new Date();
  const createdByUuid = uuidFromPublicId(actor.subjectId);
  if (!createdByUuid) return errorResponse("validation_failed", "Invalid actor id", 422, requestId);

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);

    // Load the head first: repoint applies ONLY to an existing brokered head,
    // and the existing binding supplies the template when the body omits it.
    const existing = await repo.getSecretMetadata(orgId, secretId);
    if (!existing.ok) {
      return existing.error.kind === "not_found"
        ? errorResponse("not_found", "Secret not found", 404, requestId)
        : errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    if (!scopeMatchesRequested(existing.value, requestedScope)) {
      return errorResponse("not_found", "Secret not found", 404, requestId);
    }
    const head = existing.value;
    if (head.source !== "brokered") {
      return errorResponse("unsupported", "Only a brokered secret can be repointed", 400, requestId, { reason: "not_brokered" });
    }

    const template = parsed.template ?? head.bindingTemplate;
    if (!template) {
      return validationError(requestId, { "binding.template": ["binding.template is required (the secret has no existing template to reuse)"] });
    }
    const binding: SecretBrokerBinding = {
      connectionId: parsed.connectionId,
      template,
      ...(parsed.params ? { params: parsed.params } : {}),
    };

    // Dual policy — identical to a brokered create (design §5.4): secret.write
    // AND the broker's own issue action. Deny → resource-hiding 404.
    if (!deps) {
      const contextResult = await fetchAuthorizationContext(
        env.MEMBERSHIP_WORKER!,
        actor.subjectId,
        actor.subjectType,
        orgId,
        requestId,
      );
      if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);

      const resource: PolicyResource = { kind: head.scopeKind === "organization" ? "organization" : "project", orgId };
      if (head.projectId) resource.projectId = head.projectId;

      const writeResult = await authorizeViaPolicy(
        env.POLICY_WORKER!,
        actor.subjectId,
        actor.subjectType,
        "secret.write",
        resource,
        contextResult.memberships,
        requestId,
      );
      if (!writeResult.allow) return errorResponse("not_found", "Not found", 404, requestId);

      const issueResult = await authorizeViaPolicy(
        env.POLICY_WORKER!,
        actor.subjectId,
        actor.subjectType,
        INTEGRATION_POLICY_ACTIONS.CREDENTIAL_ISSUE,
        { kind: "organization", orgId },
        contextResult.memberships,
        requestId,
      );
      if (!issueResult.allow) return errorResponse("not_found", "Not found", 404, requestId);
    }

    // Validate the NEW binding against the broker BEFORE any DB mutation — the
    // target connection must be live + broker-capable and publish the template.
    // This is the same gate a create runs; a repoint to a dead connection is
    // rejected here (you cannot repoint out of one orphan into another).
    const validateBindingFn =
      deps?.validateBinding ??
      (!deps && env.INTEGRATIONS_WORKER
        ? (r: ValidateBrokerBindingRequest) => validateBrokerBinding(env.INTEGRATIONS_WORKER!, r, requestId)
        : null);
    if (!validateBindingFn) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const validation = await validateBindingFn({
      orgId,
      connectionId: binding.connectionId,
      template: binding.template,
      ...(binding.params ? { params: binding.params } : {}),
    });
    if (!validation.ok) return brokeredValidationFailure(validation.reason, binding, requestId);

    const connectionUuid = uuidFromPublicId(binding.connectionId, "int");
    if (!connectionUuid) {
      return validationError(requestId, { binding: ["binding.connectionId must be a connection public id (int_<32 hex>)"] });
    }

    const pointerEnvelope = JSON.stringify({
      v: "brokered",
      provider: {
        connectionId: binding.connectionId,
        template: binding.template,
        ...(binding.params ? { params: binding.params } : {}),
      },
    });

    const result = await repo.repointBrokeredSecret(orgId, secretId, createdByUuid, {
      provider: validation.provider,
      connectionUuid,
      template: binding.template,
      pointerEnvelope,
    });
    if (!result.ok) {
      return result.error.kind === "not_found"
        ? errorResponse("not_found", "Secret not found", 404, requestId)
        : errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    // Announce the repoint: a secrets.updated op + the binding.created event
    // (facts only — provider/connection/template, NEVER params, NEVER a value).
    if (deps?.eventsRepo || (!deps && executor)) {
      const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);
      await eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: "secrets.updated",
          version: 1,
          source: "config-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          projectId: head.projectId,
          environmentId: head.environmentId,
          subjectKind: "secret",
          subjectId: secretId,
          requestId,
          payload: { operation: "repoint", scope: head.scopeKind, key: head.secretKey },
        },
        audit: {
          id: genId(),
          category: "config",
          description: `Brokered secret repointed: ${head.secretKey} → ${validation.provider}/${binding.template}`,
          projectId: head.projectId,
          environmentId: head.environmentId,
        },
      });
      await eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: INTEGRATION_EVENT_TYPES.SECRET_BINDING_CREATED,
          version: 1,
          source: "config-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          projectId: head.projectId,
          environmentId: head.environmentId,
          subjectKind: "secret",
          subjectId: secretId,
          subjectName: head.secretKey,
          requestId,
          payload: {
            key: head.secretKey,
            scope: head.scopeKind,
            provider: validation.provider,
            connectionId: binding.connectionId,
            template: binding.template,
            repointed: true,
          },
        },
        audit: {
          id: genId(),
          category: "config",
          description: `Brokered secret bound: ${head.secretKey} ← ${validation.provider}/${binding.template}`,
          projectId: head.projectId,
          environmentId: head.environmentId,
        },
      });
    }

    return successResponse({ secret: toPublicSecretMetadata(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/** Map a typed validate-binding failure onto this surface's error idiom
 *  (mirrors create-secret's brokeredValidationFailure). */
function brokeredValidationFailure(reason: string, binding: SecretBrokerBinding, requestId: string): Response {
  switch (reason) {
    case "connection_not_found":
      return errorResponse("not_found", "Not found", 404, requestId);
    case "connection_inactive":
      return errorResponse("precondition_failed", "The connection is not active", 412, requestId, { reason });
    case "capability_not_supported":
      return validationError(requestId, { binding: ["This connection's provider does not mint credentials"] });
    case "template_unknown":
      return validationError(requestId, { "binding.template": [`Unknown template "${binding.template}" for this connection`] });
    case "params_invalid":
      return validationError(requestId, { "binding.params": ["Invalid params for the requested template"] });
    default:
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
