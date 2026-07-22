import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Scope, CreateSecretMetadataInput } from "@saas/db/config";
import type { EventsRepository, AppendEventWithAuditInput } from "@saas/db/events";
import type { ConfigRepository } from "@saas/db/config";
import type { MembershipRepository } from "@saas/db/membership";
import { createConfigRepository } from "@saas/db/config";
import { createMembershipRepository } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { uuidFromPublicId } from "@saas/db";
import { toPublicSecretMetadata } from "../mappers.js";
import { findLockedSecretAbove } from "../config-resolver.js";
import type { PolicyResource } from "@saas/contracts/policy";
import type { EncryptionAdapter } from "../encryption.js";
import type { SecretBrokerBinding } from "@saas/contracts/config";
import {
  INTEGRATION_ENTITLEMENTS,
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_POLICY_ACTIONS,
  type InternalMintCredentialRequest,
  type ValidateBrokerBindingRequest,
} from "@saas/contracts/integrations";
import {
  mintBrokeredCredential,
  validateBrokerBinding,
  type BrokeredMintOutcome,
  type BrokerBindingValidation,
} from "../integrations-client.js";
import { checkBillingEntitlement, type BillingEntitlementResult } from "../billing-client.js";
import { orgPublicId } from "../ids.js";

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;

// ── Brokered binding grammar (saas-integration-hub IH7) ──
const CONNECTION_ID_RE = /^int_[0-9a-f]{32}$/;
const TEMPLATE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BINDING_PARAM_KEYS = 10;

/** A locked guardrail above the target scope blocked this write (SM1). */
const LOCKED_MESSAGE = "Cannot override a locked secret";

/**
 * Fields that must never appear in a create-secret request body,
 * EXCEPT `value` which is now accepted for write-only encrypted storage.
 */
const SECRET_MATERIAL_FIELDS = [
  "plaintext",
  "secret",
  "ciphertext",
  "ciphertextEnvelope",
  "ciphertext_envelope",
  "hash",
  "token",
  "password",
  "credential",
];

export interface CreateSecretDeps {
  repo: Pick<ConfigRepository, "createSecretMetadata"> &
    Partial<Pick<ConfigRepository, "getSecretMetadataByScopeKey" | "countBrokeredSecrets">>;
  /** Needed for the locked-guardrail probe; when omitted (older test fakes) the
   * deps path skips the guardrail — the production path always enforces it. */
  membershipRepo?: Pick<MembershipRepository, "getOrganizationById">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  generateId?: () => string;
  now?: () => Date;
  encryptionAdapter?: EncryptionAdapter | null;
  /** IH7 seam: broker validate-binding (tests). Production wires
   * validateBrokerBinding over the INTEGRATIONS_WORKER service binding.
   * A brokered create with no validator available fails closed (503). */
  validateBinding?: (req: ValidateBrokerBindingRequest) => Promise<BrokerBindingValidation>;
  /** IH7 seam: billing entitlement check (tests). Production wires
   * checkBillingEntitlement over the BILLING_WORKER service binding.
   * A brokered create with no checker available fails closed (503). */
  checkEntitlement?: (orgPublicId: string, entitlementKey: string) => Promise<BillingEntitlementResult>;
  /** RS1 seam: the create-from-parent rotation mint (tests). Production wires
   * mintBrokeredCredential (purpose "rotation") over the INTEGRATIONS_WORKER
   * service binding. A rotated create with no minter available fails closed
   * (503) — nothing is persisted without a minted v1. */
  mintRotation?: (req: InternalMintCredentialRequest) => Promise<BrokeredMintOutcome>;
}

// ── Rotation-policy grammar (SM6): "<n>[hdwmy]", e.g. "30d". A rotated create
// requires a parseable policy so the RS2 engine has a schedule to run. ──
const ROTATION_POLICY_RE = /^[0-9]+[hdwmy]$/;
const ROTATION_POLICY_UNIT_SECONDS: Record<string, number> = {
  h: 3600,
  d: 86400,
  w: 7 * 86400,
  m: 30 * 86400,
  y: 365 * 86400,
};
const ROTATION_DEFAULT_POLICY = "30d"; // RS-D2 default interval
const ROTATION_DEFAULT_GRACE_SECONDS = 86400; // RS-D2 default grace (24h)
const MAX_DELIVER_TARGET_LENGTH = 256;

function rotationPolicySeconds(policy: string): number {
  const unit = policy[policy.length - 1]!;
  return Number(policy.slice(0, -1)) * ROTATION_POLICY_UNIT_SECONDS[unit]!;
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

export async function handleCreateSecret(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
  deps?: CreateSecretDeps,
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

  // Reject secret-material fields (except value, which is now accepted)
  for (const forbidden of SECRET_MATERIAL_FIELDS) {
    if (forbidden in raw) {
      fields[forbidden] = ["Secret material fields are not accepted"];
    }
  }

  const { secretKey, displayName, rotationPolicy, expiresAt, value, overridable, personal, binding, rotation } = raw as {
    secretKey?: unknown;
    displayName?: unknown;
    rotationPolicy?: unknown;
    expiresAt?: unknown;
    value?: unknown;
    overridable?: unknown;
    personal?: unknown;
    binding?: unknown;
    rotation?: unknown;
  };

  if (typeof secretKey !== "string" || !KEY_RE.test(secretKey)) {
    fields.secretKey = ["A valid secretKey is required (letters, digits, dots, hyphens, underscores; 1-128 chars)"];
  }
  if (displayName !== undefined && displayName !== null && typeof displayName !== "string") {
    fields.displayName = ["displayName must be a string or null"];
  }
  if (rotationPolicy !== undefined && rotationPolicy !== null && typeof rotationPolicy !== "string") {
    fields.rotationPolicy = ["rotationPolicy must be a string or null"];
  }
  if (overridable !== undefined && typeof overridable !== "boolean") {
    fields.overridable = ["overridable must be a boolean"];
  }
  // Secrets may be locked (overridable=false) at account or organization scope
  // only; the account rung is not routable, so organization is the writable one.
  if (overridable === false && scope.kind !== "organization") {
    fields.overridable = ["Only an organization-scope secret may be locked (overridable=false)"];
  }
  if (personal !== undefined && typeof personal !== "boolean") {
    fields.personal = ["personal must be a boolean"];
  }
  if (value !== undefined && value !== null && typeof value !== "string") {
    fields.value = ["value must be a string"];
  }
  if (value !== undefined && value !== null && typeof value === "string" && value.length === 0) {
    fields.value = ["value must not be empty"];
  }

  // ── Brokered binding (IH7): `binding` in place of `value`. ──
  let parsedBinding: SecretBrokerBinding | null = null;
  if (binding !== undefined) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      fields.binding = ["binding must be an object { connectionId, template, params? }"];
    } else {
      const b = binding as Record<string, unknown>;
      const bindingErrors: string[] = [];
      if (typeof b.connectionId !== "string" || !CONNECTION_ID_RE.test(b.connectionId)) {
        bindingErrors.push("binding.connectionId must be a connection public id (int_<32 hex>)");
      }
      if (typeof b.template !== "string" || !TEMPLATE_RE.test(b.template)) {
        bindingErrors.push("binding.template must be a template id (lowercase letters, digits, hyphens; 1-64 chars)");
      }
      let bindingParams: Record<string, unknown> | undefined;
      if (b.params !== undefined) {
        if (!b.params || typeof b.params !== "object" || Array.isArray(b.params)) {
          bindingErrors.push("binding.params must be a plain object");
        } else if (Object.keys(b.params).length > MAX_BINDING_PARAM_KEYS) {
          bindingErrors.push(`binding.params allows at most ${MAX_BINDING_PARAM_KEYS} keys`);
        } else if (Object.keys(b.params).length > 0) {
          bindingParams = b.params as Record<string, unknown>;
        }
      }
      if (bindingErrors.length > 0) {
        fields.binding = bindingErrors;
      } else {
        parsedBinding = {
          connectionId: b.connectionId as string,
          template: b.template as string,
          ...(bindingParams ? { params: bindingParams } : {}),
        };
      }
    }
    // Mutually exclusive with a stored value (CreateBrokeredSecretRequest).
    if (value !== undefined && value !== null) {
      fields.binding = [...(fields.binding ?? []), "binding and value are mutually exclusive"];
    }
  }

  // ── Rotation producer (provider-rotated-secrets RS1): `rotation` in place
  //    of `value` — the v1 value is minted once from the connected parent and
  //    stored as ordinary ciphertext; these fields tell the RS2 engine how to
  //    mint the next version. Same wire grammar as the brokered binding. ──
  interface ParsedRotation {
    connectionId: string;
    template: string;
    params?: Record<string, unknown>;
    graceSeconds?: number;
    deliverTarget?: string;
  }
  let parsedRotation: ParsedRotation | null = null;
  if (rotation !== undefined) {
    if (!rotation || typeof rotation !== "object" || Array.isArray(rotation)) {
      fields.rotation = ["rotation must be an object { connectionId, template, params?, graceSeconds?, deliverTarget? }"];
    } else {
      const r = rotation as Record<string, unknown>;
      const rotationErrors: string[] = [];
      if (typeof r.connectionId !== "string" || !CONNECTION_ID_RE.test(r.connectionId)) {
        rotationErrors.push("rotation.connectionId must be a connection public id (int_<32 hex>)");
      }
      if (typeof r.template !== "string" || !TEMPLATE_RE.test(r.template)) {
        rotationErrors.push("rotation.template must be a template id (lowercase letters, digits, hyphens; 1-64 chars)");
      }
      let rotationParams: Record<string, unknown> | undefined;
      if (r.params !== undefined) {
        if (!r.params || typeof r.params !== "object" || Array.isArray(r.params)) {
          rotationErrors.push("rotation.params must be a plain object");
        } else if (Object.keys(r.params).length > MAX_BINDING_PARAM_KEYS) {
          rotationErrors.push(`rotation.params allows at most ${MAX_BINDING_PARAM_KEYS} keys`);
        } else if (Object.keys(r.params).length > 0) {
          rotationParams = r.params as Record<string, unknown>;
        }
      }
      let graceSeconds: number | undefined;
      if (r.graceSeconds !== undefined && r.graceSeconds !== null) {
        if (typeof r.graceSeconds !== "number" || !Number.isInteger(r.graceSeconds) || r.graceSeconds < 0) {
          rotationErrors.push("rotation.graceSeconds must be a non-negative integer");
        } else {
          graceSeconds = r.graceSeconds;
        }
      }
      let deliverTarget: string | undefined;
      if (r.deliverTarget !== undefined && r.deliverTarget !== null) {
        if (typeof r.deliverTarget !== "string" || r.deliverTarget.trim() === "" || r.deliverTarget.length > MAX_DELIVER_TARGET_LENGTH) {
          rotationErrors.push(`rotation.deliverTarget must be a non-empty string (max ${MAX_DELIVER_TARGET_LENGTH} chars)`);
        } else {
          deliverTarget = r.deliverTarget;
        }
      }
      if (rotationErrors.length > 0) {
        fields.rotation = rotationErrors;
      } else {
        parsedRotation = {
          connectionId: r.connectionId as string,
          template: r.template as string,
          ...(rotationParams ? { params: rotationParams } : {}),
          ...(graceSeconds !== undefined ? { graceSeconds } : {}),
          ...(deliverTarget !== undefined ? { deliverTarget } : {}),
        };
      }
    }
    // The v1 value comes FROM the mint — a caller-supplied value contradicts it.
    if (value !== undefined && value !== null) {
      fields.rotation = [...(fields.rotation ?? []), "rotation and value are mutually exclusive"];
    }
    // A rotated secret is `source: static` with a stored value; a brokered one
    // stores none — the two producers cannot share a key (880 DB CHECK).
    if (binding !== undefined) {
      fields.rotation = [...(fields.rotation ?? []), "rotation and binding are mutually exclusive"];
    }
    // The RS2 engine needs a parseable schedule; the SM6 grammar is "<n>[hdwmy]".
    if (typeof rotationPolicy === "string" && !ROTATION_POLICY_RE.test(rotationPolicy)) {
      fields.rotationPolicy = ["rotationPolicy must match \"<n>[hdwmy]\" (e.g. \"30d\") for a rotated secret"];
    }
  }

  let parsedExpiresAt: Date | undefined;
  if (expiresAt !== undefined && expiresAt !== null) {
    if (typeof expiresAt !== "string") {
      fields.expiresAt = ["expiresAt must be an ISO 8601 date string or null"];
    } else {
      const d = new Date(expiresAt);
      if (isNaN(d.getTime())) {
        fields.expiresAt = ["expiresAt must be a valid ISO 8601 date string"];
      } else {
        parsedExpiresAt = d;
      }
    }
  }

  if (Object.keys(fields).length > 0) {
    return validationError(requestId, fields);
  }

  // Personal overlays exist at environment scope only (DB CHECK mirrors this).
  if (personal === true && scope.kind !== "environment") {
    return errorResponse("bad_request", "Personal secrets are only supported at environment scope", 400, requestId);
  }

  // A personal overlay can never be brokered (IH7 — CreateBrokeredSecretRequest).
  if (parsedBinding && personal === true) {
    return errorResponse("bad_request", "A personal secret cannot be brokered", 400, requestId);
  }

  // Broker authority binds at shared scopes only — same rule for rotation (RS1).
  if (parsedRotation && personal === true) {
    return errorResponse("bad_request", "A personal secret cannot be provider-rotated", 400, requestId);
  }

  // Resolve encryption adapter (a brokered pointer is NOT ciphertext — the
  // adapter is only needed when a stored value is being written).
  let encryptionAdapter: EncryptionAdapter | null | undefined = deps?.encryptionAdapter;
  if (encryptionAdapter === undefined && !deps && !parsedBinding) {
    // Production path: lazy-import encryption adapter. Workspace-bound (SM2):
    // v:2 DEK envelopes when SECRET_KEK is configured, else the v:1 static key.
    const { createSecretEncryptionAdapter } = await import("../encryption.js");
    encryptionAdapter = await createSecretEncryptionAdapter(env, scope.orgId);
  }

  // If value is provided, encryption adapter is required
  const secretValue = typeof value === "string" ? value : null;
  if (secretValue && !encryptionAdapter) {
    return errorResponse("internal_error", "Encryption is not configured", 503, requestId);
  }

  // A rotated create stores the MINTED value as ordinary ciphertext — the
  // adapter is required even though no caller-supplied value exists (RS1).
  if (parsedRotation && !encryptionAdapter) {
    return errorResponse("internal_error", "Encryption is not configured", 503, requestId);
  }

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.MEMBERSHIP_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  // Authorization
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

    // Layer-1 RBAC activation (SM1): secrets authorize on the dedicated
    // secret.* actions, not the generic config plane.
    const policyAction = "secret.write";
    const resource: PolicyResource = { kind: scope.kind === "organization" ? "organization" : "project", orgId: scope.orgId };
    if ("projectId" in scope) {
      resource.projectId = scope.projectId;
    }

    const policyResult = await authorizeViaPolicy(
      env.POLICY_WORKER!,
      actor.subjectId,
      actor.subjectType,
      policyAction,
      resource,
      contextResult.memberships,
      requestId,
    );
    if (!policyResult.allow) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    // Binding a broker (IH7, design §5.4): "you cannot bind authority you
    // could not mint" — a brokered OR rotated create ADDITIONALLY requires the
    // broker's own issue action on the organization (a rotated create's v1 IS
    // a mint). Deny → resource-hiding 404, same as the secret.write deny above.
    if (parsedBinding || parsedRotation) {
      const issueResult = await authorizeViaPolicy(
        env.POLICY_WORKER!,
        actor.subjectId,
        actor.subjectType,
        INTEGRATION_POLICY_ACTIONS.CREDENTIAL_ISSUE,
        { kind: "organization", orgId: scope.orgId },
        contextResult.memberships,
        requestId,
      );
      if (!issueResult.allow) {
        return errorResponse("not_found", "Not found", 404, requestId);
      }
    }
  }

  // Encrypt value before any DB mutation
  let ciphertextEnvelope: string | undefined;
  if (secretValue && encryptionAdapter) {
    try {
      const envelope = await encryptionAdapter.encrypt(secretValue);
      ciphertextEnvelope = JSON.stringify(envelope);
    } catch {
      return errorResponse("internal_error", "Encryption failed", 503, requestId);
    }
  }

  const secretId = crypto.randomUUID();
  const genId = deps?.generateId ?? (() => randomHex(16));
  const now = deps?.now ? deps.now() : new Date();

  // config.secret_metadata.created_by is a UUID column; the actor id arrives as
  // the public `usr_<hex>` form. uuidFromPublicId returns a branded `Uuid`, which
  // is what CreateSecretMetadataInput.createdBy now requires (a raw string no
  // longer type-checks — a missing decode here is a compile error).
  const createdByUuid = uuidFromPublicId(actor.subjectId);
  if (!createdByUuid) return errorResponse("validation_failed", "Invalid actor id", 422, requestId);

  const baseInput = {
    id: secretId,
    scope,
    secretKey: secretKey as string,
    displayName: (displayName as string) ?? undefined,
    // A rotated create defaults the schedule (RS-D2) — the RS2 engine needs one.
    rotationPolicy: (rotationPolicy as string) ?? (parsedRotation ? ROTATION_DEFAULT_POLICY : undefined),
    createdBy: createdByUuid,
  };
  const input: CreateSecretMetadataInput = parsedExpiresAt !== undefined
    ? { ...baseInput, expiresAt: parsedExpiresAt }
    : baseInput;
  if (ciphertextEnvelope !== undefined) {
    input.ciphertextEnvelope = ciphertextEnvelope;
  }
  if (overridable !== undefined) {
    input.overridable = overridable as boolean;
  }
  if (personal === true) {
    // The overlay owner is always the verified actor — never caller-supplied.
    input.personalOwner = createdByUuid;
  }

  // Provider slug learned from the broker's validate-binding (IH7); rides the
  // stored metadata + the secret_binding.created event. Never params.
  let bindingProvider: string | undefined;

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    // ── Brokered gates (IH7): entitlement, then broker validation — BEFORE
    //    any DB mutation. Both fail closed when their seam is unavailable. ──
    if (parsedBinding) {
      const checkEntitlement =
        deps?.checkEntitlement ??
        (!deps && env.BILLING_WORKER
          ? (orgPub: string, key: string) => checkBillingEntitlement(env.BILLING_WORKER!, orgPub, key, requestId)
          : null);
      if (!checkEntitlement) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
      const entitlement = await checkEntitlement(
        orgPublicId(scope.orgId),
        INTEGRATION_ENTITLEMENTS.BROKERED_SECRETS_LIMIT,
      );
      if (entitlement.kind === "service_error") {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
      if (!entitlement.decision.allowed) {
        return errorResponse(
          "precondition_failed",
          "Brokered secrets are not included in your current plan",
          412,
          requestId,
          {
            reason: entitlement.decision.reason ?? "not_configured",
            entitlementKey: INTEGRATION_ENTITLEMENTS.BROKERED_SECRETS_LIMIT,
          },
        );
      }
      if (entitlement.decision.limitValue !== null && entitlement.decision.limitValue !== undefined) {
        const countRepo = deps ? deps.repo : createConfigRepository(executor!);
        if (countRepo.countBrokeredSecrets) {
          const count = await countRepo.countBrokeredSecrets(scope.orgId);
          if (!count.ok) {
            return errorResponse("internal_error", "Service unavailable", 503, requestId);
          }
          if (count.value >= entitlement.decision.limitValue) {
            return errorResponse(
              "precondition_failed",
              "Brokered secret limit reached for the current plan",
              412,
              requestId,
              {
                reason: "limit_reached",
                entitlementKey: INTEGRATION_ENTITLEMENTS.BROKERED_SECRETS_LIMIT,
                limit: entitlement.decision.limitValue,
              },
            );
          }
        }
      }

      const validateBindingFn =
        deps?.validateBinding ??
        (!deps && env.INTEGRATIONS_WORKER
          ? (r: ValidateBrokerBindingRequest) => validateBrokerBinding(env.INTEGRATIONS_WORKER!, r, requestId)
          : null);
      if (!validateBindingFn) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
      const validation = await validateBindingFn({
        orgId: scope.orgId,
        connectionId: parsedBinding.connectionId,
        template: parsedBinding.template,
        ...(parsedBinding.params ? { params: parsedBinding.params } : {}),
      });
      if (!validation.ok) {
        return brokeredValidationFailure(validation.reason, parsedBinding, requestId);
      }
      // SP0b: the provider must declare it backs this mode (replaces the
      // hardcoded provider allow-lists). Tolerant of an empty set (older
      // integrations-worker) so it never over-rejects.
      if (validation.supportedModes.length > 0 && !validation.supportedModes.includes("brokered")) {
        return errorResponse(
          "unsupported",
          `The ${validation.provider} integration does not support brokered secrets`,
          400,
          requestId,
          { reason: "mode_unsupported" },
        );
      }

      const connectionUuid = uuidFromPublicId(parsedBinding.connectionId, "int");
      if (!connectionUuid) {
        return validationError(requestId, {
          binding: ["binding.connectionId must be a connection public id (int_<32 hex>)"],
        });
      }

      // The envelope slot stores the binding POINTER, not ciphertext — the
      // encrypt step is deliberately skipped (there is no value to store).
      input.ciphertextEnvelope = JSON.stringify({
        v: "brokered",
        provider: {
          connectionId: parsedBinding.connectionId,
          template: parsedBinding.template,
          ...(parsedBinding.params ? { params: parsedBinding.params } : {}),
        },
      });
      input.source = "brokered";
      input.bindingProvider = validation.provider;
      input.bindingConnectionId = connectionUuid;
      input.bindingTemplate = parsedBinding.template;
      bindingProvider = validation.provider;
    }

    // ── Rotated create (RS1): validate the binding, mint the v1 from the
    //    connected parent (purpose "rotation"), encrypt, and stamp the
    //    producer — ALL before any DB mutation. Every step fails closed:
    //    nothing is persisted without a verified, encrypted minted value. ──
    if (parsedRotation) {
      const validateBindingFn =
        deps?.validateBinding ??
        (!deps && env.INTEGRATIONS_WORKER
          ? (r: ValidateBrokerBindingRequest) => validateBrokerBinding(env.INTEGRATIONS_WORKER!, r, requestId)
          : null);
      if (!validateBindingFn) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
      const validation = await validateBindingFn({
        orgId: scope.orgId,
        connectionId: parsedRotation.connectionId,
        template: parsedRotation.template,
        ...(parsedRotation.params ? { params: parsedRotation.params } : {}),
      });
      if (!validation.ok) {
        return brokeredValidationFailure(validation.reason, parsedRotation, requestId);
      }
      // SP0b: the provider must declare it backs `rotated` (replaces the
      // hardcoded ALLOWED_ROTATION_PROVIDERS). Tolerant of an empty set.
      if (validation.supportedModes.length > 0 && !validation.supportedModes.includes("rotated")) {
        return errorResponse(
          "unsupported",
          `The ${validation.provider} integration does not support rotated secrets`,
          400,
          requestId,
          { reason: "mode_unsupported" },
        );
      }

      const connectionUuid = uuidFromPublicId(parsedRotation.connectionId, "int");
      if (!connectionUuid) {
        return validationError(requestId, {
          rotation: ["rotation.connectionId must be a connection public id (int_<32 hex>)"],
        });
      }

      const mintRotationFn =
        deps?.mintRotation ??
        (!deps && env.INTEGRATIONS_WORKER
          ? (r: InternalMintCredentialRequest) => mintBrokeredCredential(env.INTEGRATIONS_WORKER!, r, requestId)
          : null);
      if (!mintRotationFn) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      // The minted token must outlive the first rotation: interval + grace
      // (RS-D2). The broker clamps against the rotation-class ceiling; its
      // entitlement + per-org daily mint rate limit are enforced at the mint
      // (RS-D6: the rotated tier rides the credential_broker entitlement).
      const intervalSeconds = rotationPolicySeconds(
        typeof rotationPolicy === "string" ? rotationPolicy : ROTATION_DEFAULT_POLICY,
      );
      const graceSeconds = parsedRotation.graceSeconds ?? ROTATION_DEFAULT_GRACE_SECONDS;
      const mintOutcome = await mintRotationFn({
        orgId: scope.orgId,
        connectionId: parsedRotation.connectionId,
        template: parsedRotation.template,
        ...(parsedRotation.params ? { params: parsedRotation.params } : {}),
        ttlSeconds: intervalSeconds + graceSeconds,
        purpose: "rotation",
        requestedBy: actor.subjectId,
        requestedByType: actor.subjectType,
      });
      if (!mintOutcome.ok) {
        // Same fail-closed taxonomy as the resolve path: an inactive/revoked
        // connection or refused mint is a typed 412, a broker outage a 503.
        if (mintOutcome.status === 503) {
          return errorResponse("internal_error", "Service unavailable", 503, requestId);
        }
        return errorResponse(
          "precondition_failed",
          `The rotation mint was refused (${mintOutcome.reason})`,
          412,
          requestId,
          { reason: mintOutcome.reason },
        );
      }

      // Encrypt the minted value — reveal-once: it exists only inside this
      // scope and the envelope; it is never logged and never echoed.
      try {
        const envelope = await encryptionAdapter!.encrypt(mintOutcome.value);
        input.ciphertextEnvelope = JSON.stringify(envelope);
      } catch {
        return errorResponse("internal_error", "Encryption failed", 503, requestId);
      }

      // source stays "static" — a rotated secret reads like any stored secret
      // (880 DB CHECK requires it); the producer columns carry the HOW.
      input.rotationProvider = validation.provider;
      input.rotationConnectionId = connectionUuid;
      input.rotationTemplate = parsedRotation.template;
      if (parsedRotation.params) {
        input.rotationParams = parsedRotation.params;
      }
      if (parsedRotation.graceSeconds !== undefined) {
        input.rotationGraceSeconds = parsedRotation.graceSeconds;
      }
      if (parsedRotation.deliverTarget !== undefined) {
        input.rotationDeliverTarget = parsedRotation.deliverTarget;
      }
      // Surface the minted token's provider-side death through the SM6 expiry
      // lane unless the caller pinned an explicit expiry.
      if (parsedExpiresAt === undefined) {
        const mintExpiry = new Date(mintOutcome.expiresAt);
        if (!isNaN(mintExpiry.getTime())) {
          input.expiresAt = mintExpiry;
        }
      }
    }

    if (executor && "transaction" in executor) {
      const txResult = await executor.transaction(async (txExec) => {
        const txRepo = createConfigRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);
        const txMembershipRepo = createMembershipRepository(txExec);

        // Guardrail (SM1): a scoped write may not override a locked
        // (overridable=false) account- or organization-scope key.
        const locked = await findLockedSecretAbove(txRepo, txMembershipRepo, scope, secretKey as string);
        if (locked) {
          return { result: { ok: false as const, error: { kind: "locked" as const } } };
        }

        const result = await txRepo.createSecretMetadata(input);

        if (!result.ok) {
          return { result };
        }

        const eventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "secrets.updated",
            version: 1,
            source: "config-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId: scope.orgId,
            projectId: "projectId" in scope ? scope.projectId : null,
            environmentId: "environmentId" in scope ? scope.environmentId : null,
            subjectKind: "secret",
            subjectId: secretId,
            requestId,
            payload: {
              operation: "create",
              scope: scope.kind,
              key: secretKey as string,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Secret metadata created: ${secretKey as string}`,
            projectId: "projectId" in scope ? scope.projectId : null,
            environmentId: "environmentId" in scope ? scope.environmentId : null,
          },
        });

        if (!eventResult.ok) {
          throw new Error("Failed to append event");
        }

        // IH7: a brokered create ADDITIONALLY announces the binding on the
        // integrations event stream (provider/connection/template — NEVER
        // params, NEVER a value).
        if (parsedBinding) {
          const bindingEventResult = await txEventsRepo.appendEventWithAudit(
            bindingCreatedEvent(genId, now, actor, scope, secretId, secretKey as string, parsedBinding, bindingProvider ?? "", requestId),
          );
          if (!bindingEventResult.ok) {
            throw new Error("Failed to append event");
          }
        }

        return { result };
      });

      if (!txResult.result.ok) {
        const err = txResult.result.error;
        if (err.kind === "locked") {
          return errorResponse("conflict", LOCKED_MESSAGE, 409, requestId);
        }
        if (err.kind === "conflict") {
          return errorResponse("conflict", "Secret already exists for this scope and key", 409, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      return successResponse({ secret: toPublicSecretMetadata(txResult.result.value) }, requestId, 201);
    }

    // Non-transactional path (deps injection for tests)
    if (deps) {
      // Guardrail (SM1): reject overriding a locked account/organization key.
      if (deps.membershipRepo && deps.repo.getSecretMetadataByScopeKey) {
        const locked = await findLockedSecretAbove(
          deps.repo as Pick<ConfigRepository, "getSecretMetadataByScopeKey">,
          deps.membershipRepo,
          scope,
          secretKey as string,
        );
        if (locked) {
          return errorResponse("conflict", LOCKED_MESSAGE, 409, requestId);
        }
      }

      const result = await deps.repo.createSecretMetadata(input);

      if (!result.ok) {
        const err = result.error;
        if (err.kind === "conflict") {
          return errorResponse("conflict", "Secret already exists for this scope and key", 409, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      if (deps.eventsRepo) {
        const eventResult = await deps.eventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "secrets.updated",
            version: 1,
            source: "config-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId: scope.orgId,
            projectId: "projectId" in scope ? scope.projectId : null,
            environmentId: "environmentId" in scope ? scope.environmentId : null,
            subjectKind: "secret",
            subjectId: secretId,
            requestId,
            payload: {
              operation: "create",
              scope: scope.kind,
              key: secretKey as string,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Secret metadata created: ${secretKey as string}`,
            projectId: "projectId" in scope ? scope.projectId : null,
            environmentId: "environmentId" in scope ? scope.environmentId : null,
          },
        });

        if (!eventResult.ok) {
          throw new Error("Failed to append event");
        }

        // IH7: brokered creates also announce the binding (deps path mirrors
        // the transactional path — only when an eventsRepo is present).
        if (parsedBinding) {
          const bindingEventResult = await deps.eventsRepo.appendEventWithAudit(
            bindingCreatedEvent(genId, now, actor, scope, secretId, secretKey as string, parsedBinding, bindingProvider ?? "", requestId),
          );
          if (!bindingEventResult.ok) {
            throw new Error("Failed to append event");
          }
        }
      }

      return successResponse({ secret: toPublicSecretMetadata(result.value) }, requestId, 201);
    }

    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── Brokered helpers (IH7) ───────────────────────────────────

/**
 * Map a typed validate-binding failure onto this surface's error idiom:
 * unknown connection hides as 404, an inactive connection is a 412
 * precondition, and pointer-shape problems are 422 validation errors naming
 * the offending binding field.
 */
function brokeredValidationFailure(
  reason: string,
  binding: SecretBrokerBinding,
  requestId: string,
): Response {
  switch (reason) {
    case "connection_not_found":
      return errorResponse("not_found", "Not found", 404, requestId);
    case "connection_inactive":
      return errorResponse("precondition_failed", "The connection is not active", 412, requestId, {
        reason,
      });
    case "capability_not_supported":
      return validationError(requestId, {
        binding: ["This connection's provider does not mint credentials"],
      });
    case "template_unknown":
      return validationError(requestId, {
        "binding.template": [`Unknown template "${binding.template}" for this connection`],
      });
    case "params_invalid":
      return validationError(requestId, {
        "binding.params": ["Invalid params for the requested template"],
      });
    default:
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

/**
 * The `integration.secret_binding.created` event + audit row (IH7). Payload
 * carries binding facts only — key, scope rung, provider, public connection
 * id, template. NEVER params, NEVER a value.
 */
function bindingCreatedEvent(
  genId: () => string,
  now: Date,
  actor: ActorContext,
  scope: Scope,
  secretId: string,
  secretKey: string,
  binding: SecretBrokerBinding,
  provider: string,
  requestId: string,
): AppendEventWithAuditInput {
  return {
    event: {
      id: genId(),
      type: INTEGRATION_EVENT_TYPES.SECRET_BINDING_CREATED,
      version: 1,
      source: "config-worker",
      occurredAt: now,
      actorType: actor.subjectType,
      actorId: actor.subjectId,
      orgId: scope.orgId,
      projectId: "projectId" in scope ? scope.projectId : null,
      environmentId: "environmentId" in scope ? scope.environmentId : null,
      subjectKind: "secret",
      subjectId: secretId,
      subjectName: secretKey,
      requestId,
      payload: {
        key: secretKey,
        scope: scope.kind,
        provider,
        connectionId: binding.connectionId,
        template: binding.template,
      },
    },
    audit: {
      id: genId(),
      category: "config",
      description: `Brokered secret bound: ${secretKey} ← ${provider}/${binding.template}`,
      projectId: "projectId" in scope ? scope.projectId : null,
      environmentId: "environmentId" in scope ? scope.environmentId : null,
    },
  };
}
