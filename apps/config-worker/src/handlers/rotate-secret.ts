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
import type { EncryptionAdapter } from "../encryption.js";
import { fetchAuthorizationContext as fetchAuthContext } from "../membership-client.js";
import { INTEGRATION_POLICY_ACTIONS, type InternalMintCredentialRequest } from "@saas/contracts/integrations";
import {
  mintBrokeredCredential,
  rotateConnectionSource,
  type BrokeredMintOutcome,
  type RotateSourceResult,
} from "../integrations-client.js";
import type { SecretMetadata } from "@saas/db/config";
import { connectionPublicId } from "../ids.js";
import { SECRET_EVENT_TYPES } from "../secret-events.js";

export interface RotateSecretDeps {
  // touchBrokeredRotation / rotateProviderSecret are only reached on their
  // branches, so they stay optional here — static-rotate test fakes need not
  // provide them.
  repo: Pick<ConfigRepository, "getSecretMetadata" | "rotateSecretMetadata"> & {
    touchBrokeredRotation?: ConfigRepository["touchBrokeredRotation"];
    rotateProviderSecret?: ConfigRepository["rotateProviderSecret"];
  };
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  generateId?: () => string;
  now?: () => Date;
  encryptionAdapter?: EncryptionAdapter | null;
  /** SC2 seam: roll the connection's source credential. Production wires
   *  rotateConnectionSource over the INTEGRATIONS_WORKER binding. */
  rotateSource?: (req: { orgId: string; connectionId: string }) => Promise<RotateSourceResult>;
  /** RS3 seam: the rotate-now mint for a provider-rotated secret. Production
   *  wires mintBrokeredCredential (purpose "rotation") over the
   *  INTEGRATIONS_WORKER binding; fails closed (503) when unavailable. */
  mintRotation?: (req: InternalMintCredentialRequest) => Promise<BrokeredMintOutcome>;
}

// Rotation-policy grammar + RS-D2 defaults (mirrors create-secret RS1).
const ROTATION_POLICY_RE = /^[0-9]+[hdwmy]$/;
const ROTATION_UNIT_SECONDS: Record<string, number> = {
  h: 3600,
  d: 86400,
  w: 7 * 86400,
  m: 30 * 86400,
  y: 365 * 86400,
};
const ROTATION_DEFAULT_INTERVAL_SECONDS = 30 * 86400;
const ROTATION_DEFAULT_GRACE_SECONDS = 86400;

function rotationIntervalSeconds(policy: string | null): number {
  if (!policy || !ROTATION_POLICY_RE.test(policy)) return ROTATION_DEFAULT_INTERVAL_SECONDS;
  const unit = policy[policy.length - 1]!;
  return Number(policy.slice(0, -1)) * ROTATION_UNIT_SECONDS[unit]!;
}

/**
 * Fields that must never appear in a rotate-secret request body,
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

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function handleRotateSecret(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  requestedScope: Scope,
  secretId: string,
  deps?: RotateSecretDeps,
): Promise<Response> {
  const orgId = requestedScope.orgId;

  // Parse body if JSON content-type is sent
  let secretValue: string | null = null;
  // SC2 (scoped credentials): a brokered secret carries no value — the body may
  // instead set `rotationPolicy` (the cadence) and `rotate` (roll the source
  // credential now, default true). Captured here; used only on the brokered
  // branch after the source is known.
  let rotationPolicy: string | null | undefined;
  let rotateSourceNow = true;
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await request.json();
      if (body && typeof body === "object") {
        const raw = body as Record<string, unknown>;
        // Reject forbidden secret-material fields (except value)
        for (const f of SECRET_MATERIAL_FIELDS) {
          if (f in raw) {
            return errorResponse("validation_failed", "Secret material fields are not accepted on rotate", 422, requestId);
          }
        }
        // Accept `value` for write-only encrypted storage
        if ("value" in raw) {
          if (typeof raw.value !== "string" || raw.value.length === 0) {
            return errorResponse("validation_failed", "value must be a non-empty string", 422, requestId);
          }
          secretValue = raw.value as string;
        }
        if ("rotationPolicy" in raw) {
          if (raw.rotationPolicy !== null && typeof raw.rotationPolicy !== "string") {
            return errorResponse("validation_failed", "rotationPolicy must be a string or null", 422, requestId);
          }
          rotationPolicy = raw.rotationPolicy as string | null;
        }
        if ("rotate" in raw) {
          if (typeof raw.rotate !== "boolean") {
            return errorResponse("validation_failed", "rotate must be a boolean", 422, requestId);
          }
          rotateSourceNow = raw.rotate;
        }
      }
    } catch {
      // Empty body is fine for rotate
    }
  }

  // Resolve encryption adapter
  let encryptionAdapter: EncryptionAdapter | null | undefined = deps?.encryptionAdapter;
  if (encryptionAdapter === undefined && !deps) {
    // Workspace-bound (SM2): v:2 DEK envelopes when SECRET_KEK is configured,
    // else the v:1 static key.
    const { createSecretEncryptionAdapter } = await import("../encryption.js");
    encryptionAdapter = await createSecretEncryptionAdapter(env, orgId);
  }

  // If value is provided, encryption adapter is required
  if (secretValue && !encryptionAdapter) {
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

  const genId = deps?.generateId ?? (() => randomHex(16));
  const now = deps?.now ? deps.now() : new Date();

  // config.secret_versions.created_by is a UUID column; the actor id arrives as
  // the public `usr_<hex>` form — decode it (branded Uuid) before the append.
  const createdByUuid = uuidFromPublicId(actor.subjectId);
  if (!createdByUuid) return errorResponse("validation_failed", "Invalid actor id", 422, requestId);

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    // SC2 dispatch: a brokered scoped credential rotates its SOURCE, not a
    // value. Pre-read the head (a cheap metadata read, outside any tx) and
    // branch before the static value-rotation flow.
    const dispatchRepo = deps?.repo ?? createConfigRepository(executor!);
    const pre = await dispatchRepo.getSecretMetadata(orgId, secretId);
    if (pre.ok && scopeMatchesRequested(pre.value, requestedScope) && pre.value.source === "brokered") {
      if (secretValue !== null) {
        return errorResponse(
          "unsupported",
          "A scoped credential has no stored value — omit `value`; rotation rolls the connection's source credential",
          400,
          requestId,
          { reason: "brokered" },
        );
      }
      const touch = dispatchRepo.touchBrokeredRotation;
      if (!touch) return errorResponse("internal_error", "Service unavailable", 503, requestId);
      return await rotateBrokeredSecret(env, requestId, actor, pre.value, {
        rotationPolicy,
        rotate: rotateSourceNow,
        repo: { touchBrokeredRotation: touch },
        eventsRepo: deps?.eventsRepo ?? (executor ? createEventsRepository(executor) : undefined),
        genId,
        now,
        rotateSource: deps?.rotateSource,
      });
    }

    // RS3 dispatch: a provider-rotated secret (rotation_provider set; always
    // source 'static' by the 880 CHECK) rotates by RE-MINTING from its
    // connected parent — the operator's break-glass "rotate now", same path
    // the RS2 engine runs on schedule.
    if (pre.ok && scopeMatchesRequested(pre.value, requestedScope) && pre.value.rotationProvider) {
      if (secretValue !== null) {
        return errorResponse(
          "unsupported",
          "A provider-rotated secret's value comes from its connected parent — omit `value`; rotation re-mints it",
          400,
          requestId,
          { reason: "provider_rotated" },
        );
      }
      if (rotationPolicy !== undefined) {
        return validationError(requestId, {
          rotationPolicy: ["Editing the cadence of a provider-rotated secret is not supported on rotate yet — rotate re-mints with the stored policy"],
        });
      }
      const rotateRepo = deps?.repo.rotateProviderSecret
        ? { rotateProviderSecret: deps.repo.rotateProviderSecret }
        : executor
          ? { rotateProviderSecret: createConfigRepository(executor).rotateProviderSecret }
          : null;
      if (!rotateRepo) return errorResponse("internal_error", "Service unavailable", 503, requestId);
      return await rotateProviderRotatedSecret(env, requestId, actor, pre.value, {
        repo: rotateRepo,
        eventsRepo: deps?.eventsRepo ?? (executor ? createEventsRepository(executor) : undefined),
        genId,
        now,
        createdByUuid,
        encryptionAdapter,
        mintRotation: deps?.mintRotation,
      });
    }

    if (executor && "transaction" in executor) {
      const txResult = await executor.transaction(async (txExec) => {
        const txRepo = createConfigRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);

        const existing = await txRepo.getSecretMetadata(orgId, secretId);
        if (!existing.ok) {
          return { result: existing };
        }

        if (!scopeMatchesRequested(existing.value, requestedScope)) {
          return { result: { ok: false as const, error: { kind: "not_found" as const } } };
        }

        // Brokered guard (IH7): there is no stored value to rotate — the
        // envelope is a binding pointer. v1 re-bind = delete + recreate.
        if (existing.value.source === "brokered") {
          return { result: { ok: false as const, error: { kind: "brokered" as const } } };
        }

        // Authorize
        const contextResult = await fetchAuthorizationContext(
          env.MEMBERSHIP_WORKER!,
          actor.subjectId,
          actor.subjectType,
          orgId,
          requestId,
        );
        if (!contextResult.ok) {
          return { result: { ok: false as const, error: { kind: "not_found" as const } } };
        }

        const secret = existing.value;
        // Layer-1 RBAC activation (SM1): secrets authorize on secret.*.
        const policyAction = "secret.write";
        const resource: PolicyResource = { kind: secret.scopeKind === "organization" ? "organization" : "project", orgId };
        if (secret.projectId) {
          resource.projectId = secret.projectId;
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
          return { result: { ok: false as const, error: { kind: "not_found" as const } } };
        }

        const result = await txRepo.rotateSecretMetadata(orgId, secretId, createdByUuid, ciphertextEnvelope);

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
            orgId,
            projectId: secret.projectId,
            environmentId: secret.environmentId,
            subjectKind: "secret",
            subjectId: secretId,
            requestId,
            payload: {
              operation: "rotate",
              scope: secret.scopeKind,
              key: secret.secretKey,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Secret metadata rotated: ${secret.secretKey}`,
            projectId: secret.projectId,
            environmentId: secret.environmentId,
          },
        });

        if (!eventResult.ok) {
          throw new Error("Failed to append event");
        }

        return { result };
      });

      if (!txResult.result.ok) {
        const err = txResult.result.error;
        if (err.kind === "not_found") {
          return errorResponse("not_found", "Secret not found", 404, requestId);
        }
        if (err.kind === "brokered") {
          return errorResponse("unsupported", "A brokered secret cannot be rotated with a value; remove and re-bind", 400, requestId, { reason: "brokered" });
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      return successResponse({ secret: toPublicSecretMetadata(txResult.result.value) }, requestId);
    }

    // Non-transactional path (deps injection for tests)
    if (deps) {
      const existing = await deps.repo.getSecretMetadata(orgId, secretId);
      if (!existing.ok) {
        const err = existing.error;
        if (err.kind === "not_found") {
          return errorResponse("not_found", "Secret not found", 404, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      if (!scopeMatchesRequested(existing.value, requestedScope)) {
        return errorResponse("not_found", "Secret not found", 404, requestId);
      }

      // Brokered guard (IH7): no stored value to rotate; re-bind = delete + recreate.
      if (existing.value.source === "brokered") {
        return errorResponse("unsupported", "A brokered secret cannot be rotated with a value; remove and re-bind", 400, requestId, { reason: "brokered" });
      }

      const result = await deps.repo.rotateSecretMetadata(orgId, secretId, createdByUuid, ciphertextEnvelope);

      if (!result.ok) {
        const err = result.error;
        if (err.kind === "not_found") {
          return errorResponse("not_found", "Secret not found", 404, requestId);
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
            orgId,
            subjectKind: "secret",
            subjectId: secretId,
            requestId,
            payload: {
              operation: "rotate",
              scope: result.value.scopeKind,
              key: result.value.secretKey,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Secret metadata rotated: ${result.value.secretKey}`,
          },
        });

        if (!eventResult.ok) {
          throw new Error("Failed to append event");
        }
      }

      return successResponse({ secret: toPublicSecretMetadata(result.value) }, requestId);
    }

    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/**
 * SC2: rotate a scoped credential — roll the connection's source credential and
 * stamp `last_rotated_at` (and, when provided, the cadence). Dual policy like a
 * brokered create/repoint (secret.write AND organization.integration.credential.
 * issue — "you cannot roll authority you could not mint"). `rotate: false` sets
 * the cadence only, without touching the source.
 */
async function rotateBrokeredSecret(
  env: Env,
  requestId: string,
  actor: ActorContext,
  head: SecretMetadata,
  opts: {
    rotationPolicy: string | null | undefined;
    rotate: boolean;
    repo: Pick<ConfigRepository, "touchBrokeredRotation">;
    eventsRepo?: Pick<EventsRepository, "appendEventWithAudit"> | undefined;
    genId: () => string;
    now: Date;
    rotateSource?: ((req: { orgId: string; connectionId: string }) => Promise<RotateSourceResult>) | undefined;
  },
): Promise<Response> {
  const orgId = head.orgId;

  // Dual policy — identical to a brokered create/repoint. Enforced whenever the
  // authz services are wired (absent only in the deps-injected test path).
  if (env.MEMBERSHIP_WORKER && env.POLICY_WORKER) {
    const contextResult = await fetchAuthContext(env.MEMBERSHIP_WORKER, actor.subjectId, actor.subjectType, orgId, requestId);
    if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const resource: PolicyResource = { kind: head.scopeKind === "organization" ? "organization" : "project", orgId };
    if (head.projectId) resource.projectId = head.projectId;
    const writeResult = await authorizeViaPolicy(env.POLICY_WORKER, actor.subjectId, actor.subjectType, "secret.write", resource, contextResult.memberships, requestId);
    if (!writeResult.allow) return errorResponse("not_found", "Not found", 404, requestId);
    const issueResult = await authorizeViaPolicy(env.POLICY_WORKER, actor.subjectId, actor.subjectType, INTEGRATION_POLICY_ACTIONS.CREDENTIAL_ISSUE, { kind: "organization", orgId }, contextResult.memberships, requestId);
    if (!issueResult.allow) return errorResponse("not_found", "Not found", 404, requestId);
  }

  // Roll the source credential (unless the caller only edits the cadence).
  if (opts.rotate) {
    if (!head.bindingConnectionId) {
      return errorResponse("unsupported", "This secret has no bound connection to rotate", 400, requestId, { reason: "not_brokered" });
    }
    const rotateSourceFn =
      opts.rotateSource ??
      (env.INTEGRATIONS_WORKER
        ? (req: { orgId: string; connectionId: string }) => rotateConnectionSource(env.INTEGRATIONS_WORKER!, req, requestId)
        : null);
    if (!rotateSourceFn) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const rotated = await rotateSourceFn({ orgId, connectionId: head.bindingConnectionId });
    if (!rotated.ok) {
      if (rotated.reason === "rotation_unsupported") {
        return errorResponse(
          "unsupported",
          "This connection's source credential cannot be rotated (e.g. a pasted API token Orun does not own)",
          400,
          requestId,
          { reason: "rotation_unsupported" },
        );
      }
      if (rotated.status === 412) {
        return errorResponse("precondition_failed", "The connection is not active", 412, requestId, { reason: rotated.reason });
      }
      return errorResponse("bad_gateway", "The provider refused the rotation", 502, requestId, { reason: "provider_error" });
    }
  }

  // rotationPolicy must be a simple duration ("90d","12w","720h",…) or null.
  if (opts.rotationPolicy && !/^[0-9]+[hdwmy]$/.test(opts.rotationPolicy)) {
    return validationError(requestId, { rotationPolicy: ["rotationPolicy must be a duration like \"90d\", \"12w\", or \"720h\", or null"] });
  }

  const result = await opts.repo.touchBrokeredRotation(orgId, head.id, {
    ...(opts.rotationPolicy !== undefined ? { rotationPolicy: opts.rotationPolicy } : {}),
    stampRotation: opts.rotate,
  });
  if (!result.ok) {
    return result.error.kind === "not_found"
      ? errorResponse("not_found", "Secret not found", 404, requestId)
      : errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  if (opts.eventsRepo) {
    await opts.eventsRepo.appendEventWithAudit({
      event: {
        id: opts.genId(),
        type: "secrets.updated",
        version: 1,
        source: "config-worker",
        occurredAt: opts.now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: head.projectId,
        environmentId: head.environmentId,
        subjectKind: "secret",
        subjectId: head.id,
        requestId,
        payload: {
          operation: opts.rotate ? "rotate-source" : "set-rotation-policy",
          scope: head.scopeKind,
          key: head.secretKey,
          ...(head.bindingProvider ? { provider: head.bindingProvider } : {}),
        },
      },
      audit: {
        id: opts.genId(),
        category: "config",
        description: opts.rotate
          ? `Scoped credential rotated (source rolled): ${head.secretKey}`
          : `Scoped credential rotation policy updated: ${head.secretKey}`,
        projectId: head.projectId,
        environmentId: head.environmentId,
      },
    });
  }

  return successResponse({ secret: toPublicSecretMetadata(result.value) }, requestId);
}

/**
 * RS3: rotate-now for a provider-rotated secret — the operator's break-glass
 * "roll it NOW", running the same mint→encrypt→append path the RS2 engine runs
 * on schedule. Non-destructive: any failing step leaves the prior version
 * current. The minted value exists only inside the encrypt scope; it is never
 * logged, echoed, or placed in an event.
 */
async function rotateProviderRotatedSecret(
  env: Env,
  requestId: string,
  actor: ActorContext,
  head: SecretMetadata,
  opts: {
    repo: Pick<ConfigRepository, "rotateProviderSecret">;
    eventsRepo?: Pick<EventsRepository, "appendEventWithAudit"> | undefined;
    genId: () => string;
    now: Date;
    createdByUuid: NonNullable<ReturnType<typeof uuidFromPublicId>>;
    encryptionAdapter: EncryptionAdapter | null | undefined;
    mintRotation?: ((req: InternalMintCredentialRequest) => Promise<BrokeredMintOutcome>) | undefined;
  },
): Promise<Response> {
  const orgId = head.orgId;

  // Dual policy — identical to a rotated create (RS1): secret.write plus the
  // broker's own issue action ("you cannot re-mint authority you could not
  // mint"). Enforced whenever the authz services are wired.
  if (env.MEMBERSHIP_WORKER && env.POLICY_WORKER) {
    const contextResult = await fetchAuthContext(env.MEMBERSHIP_WORKER, actor.subjectId, actor.subjectType, orgId, requestId);
    if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const resource: PolicyResource = { kind: head.scopeKind === "organization" ? "organization" : "project", orgId };
    if (head.projectId) resource.projectId = head.projectId;
    const writeResult = await authorizeViaPolicy(env.POLICY_WORKER, actor.subjectId, actor.subjectType, "secret.write", resource, contextResult.memberships, requestId);
    if (!writeResult.allow) return errorResponse("not_found", "Not found", 404, requestId);
    const issueResult = await authorizeViaPolicy(env.POLICY_WORKER, actor.subjectId, actor.subjectType, INTEGRATION_POLICY_ACTIONS.CREDENTIAL_ISSUE, { kind: "organization", orgId }, contextResult.memberships, requestId);
    if (!issueResult.allow) return errorResponse("not_found", "Not found", 404, requestId);
  }

  if (!head.rotationConnectionId || !head.rotationTemplate || !head.rotationProvider) {
    // Unreachable for a well-formed head (880 all-or-nothing CHECK) — fail
    // loudly rather than mint against a partial binding.
    return errorResponse("internal_error", "Rotation binding incomplete", 500, requestId);
  }
  if (!opts.encryptionAdapter) {
    return errorResponse("internal_error", "Encryption is not configured", 503, requestId);
  }

  const mintRotationFn =
    opts.mintRotation ??
    (env.INTEGRATIONS_WORKER
      ? (req: InternalMintCredentialRequest) => mintBrokeredCredential(env.INTEGRATIONS_WORKER!, req, requestId)
      : null);
  if (!mintRotationFn) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  // Mint the next value: TTL = interval + grace (the RS1/RS2 math) so the new
  // token outlives the next scheduled rotation.
  const ttlSeconds =
    rotationIntervalSeconds(head.rotationPolicy) +
    (head.rotationGraceSeconds ?? ROTATION_DEFAULT_GRACE_SECONDS);
  const mint = await mintRotationFn({
    orgId,
    connectionId: connectionPublicId(head.rotationConnectionId),
    template: head.rotationTemplate,
    ...(head.rotationParams && Object.keys(head.rotationParams).length > 0
      ? { params: head.rotationParams }
      : {}),
    ttlSeconds,
    purpose: "rotation",
    requestedBy: actor.subjectId,
    requestedByType: actor.subjectType,
  });
  if (!mint.ok) {
    if (mint.status === 503) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    return errorResponse("precondition_failed", `The rotation mint was refused (${mint.reason})`, 412, requestId, {
      reason: mint.reason,
    });
  }

  // Encrypt, then append — the prior version stays untouched on any failure.
  let envelope: string;
  try {
    envelope = JSON.stringify(await opts.encryptionAdapter.encrypt(mint.value));
  } catch {
    return errorResponse("internal_error", "Encryption failed", 503, requestId);
  }
  const mintExpiry = new Date(mint.expiresAt);
  const stored = await opts.repo.rotateProviderSecret(
    orgId,
    head.id,
    opts.createdByUuid,
    envelope,
    isNaN(mintExpiry.getTime()) ? null : mintExpiry,
  );
  if (!stored.ok) {
    return stored.error.kind === "not_found"
      ? errorResponse("not_found", "Secret not found", 404, requestId)
      : errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  if (opts.eventsRepo) {
    await opts.eventsRepo.appendEventWithAudit({
      event: {
        id: opts.genId(),
        type: SECRET_EVENT_TYPES.ROTATED,
        version: 1,
        source: "config-worker",
        occurredAt: opts.now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: head.projectId,
        environmentId: head.environmentId,
        subjectKind: "secret",
        subjectId: head.id,
        subjectName: head.secretKey,
        requestId,
        // Metadata only — NEVER a value.
        payload: {
          key: head.secretKey,
          scope: head.scopeKind,
          provider: head.rotationProvider,
          template: head.rotationTemplate,
          version: stored.value.version,
          expiresAt: stored.value.expiresAt ? stored.value.expiresAt.toISOString() : null,
          deliveryRequired: head.rotationDeliverTarget !== null,
          ...(head.rotationDeliverTarget ? { deliverTarget: head.rotationDeliverTarget } : {}),
        },
      },
      audit: {
        id: opts.genId(),
        category: "config",
        description: `Secret rotated (operator): ${head.secretKey} (${head.rotationProvider}/${head.rotationTemplate} → v${stored.value.version})`,
        projectId: head.projectId,
        environmentId: head.environmentId,
      },
    });
  }

  return successResponse({ secret: toPublicSecretMetadata(stored.value) }, requestId);
}
