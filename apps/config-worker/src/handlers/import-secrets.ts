import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository, Scope } from "@saas/db/config";
import type { EventsRepository } from "@saas/db/events";
import type { MembershipRepository } from "@saas/db/membership";
import { createConfigRepository } from "@saas/db/config";
import { createMembershipRepository } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { uuidFromPublicId } from "@saas/db";
import { findLockedSecretAbove } from "../config-resolver.js";
import type { PolicyResource } from "@saas/contracts/policy";
import type { ImportSecretResult } from "@saas/contracts/config";
import type { EncryptionAdapter } from "../encryption.js";

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;
const MAX_IMPORT_ENTRIES = 100;

/**
 * Fields that must never appear in an import entry, EXCEPT `value` which is
 * accepted for write-only encrypted storage (same discipline as create-secret).
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

export interface ImportSecretsDeps {
  repo: Pick<ConfigRepository, "createSecretMetadata"> & Partial<Pick<ConfigRepository, "getSecretMetadataByScopeKey">>;
  /** Needed for the locked-guardrail probe; when omitted (test fakes) the deps
   * path skips the guardrail — the production path always enforces it. */
  membershipRepo?: Pick<MembershipRepository, "getOrganizationById">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  generateId?: () => string;
  now?: () => Date;
  encryptionAdapter?: EncryptionAdapter | null;
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

/**
 * Bulk write-only secret import (saas-secret-manager SM1):
 * `POST …/config/secrets/import`. Each entry rides the create path — encrypted
 * before persistence, guardrail-checked, per-key result — and the whole batch
 * lands ONE `secrets.updated` event + audit entry summarizing the count. No
 * value or ciphertext ever appears in any response, event, or audit payload.
 */
export async function handleImportSecrets(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
  deps?: ImportSecretsDeps,
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

  const { secrets } = body as { secrets?: unknown };
  if (!Array.isArray(secrets) || secrets.length === 0) {
    return validationError(requestId, { secrets: ["A non-empty secrets array is required"] });
  }
  if (secrets.length > MAX_IMPORT_ENTRIES) {
    return validationError(requestId, { secrets: [`At most ${MAX_IMPORT_ENTRIES} secrets per import`] });
  }

  // Resolve encryption adapter — import is write-only, so it is always required.
  let encryptionAdapter: EncryptionAdapter | null | undefined = deps?.encryptionAdapter;
  if (encryptionAdapter === undefined && !deps) {
    const { createEncryptionAdapter } = await import("../encryption.js");
    encryptionAdapter = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  }
  if (!encryptionAdapter) {
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

    const resource: PolicyResource = { kind: scope.kind === "organization" ? "organization" : "project", orgId: scope.orgId };
    if ("projectId" in scope) {
      resource.projectId = scope.projectId;
    }
    const policyResult = await authorizeViaPolicy(
      env.POLICY_WORKER!,
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
  }

  const genId = deps?.generateId ?? (() => randomHex(16));
  const now = deps?.now ? deps.now() : new Date();

  const createdByUuid = uuidFromPublicId(actor.subjectId);
  if (!createdByUuid) return errorResponse("validation_failed", "Invalid actor id", 422, requestId);

  // Deliberately NOT one transaction: per-key results allow partial success, and
  // a unique-violation inside a shared transaction would poison the whole batch.
  // Each create is itself atomic (head + version 1 in one statement).
  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);
    const membershipRepo = deps?.membershipRepo ?? (executor ? createMembershipRepository(executor) : undefined);
    const eventsRepo = deps ? deps.eventsRepo : createEventsRepository(executor!);

    const results: ImportSecretResult[] = [];
    let created = 0;

    for (const entry of secrets) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        results.push({ secretKey: "", status: "invalid" });
        continue;
      }
      const raw = entry as Record<string, unknown>;
      const secretKey = typeof raw.secretKey === "string" ? raw.secretKey : "";
      const invalid =
        !KEY_RE.test(secretKey) ||
        typeof raw.value !== "string" ||
        raw.value.length === 0 ||
        (raw.displayName !== undefined && raw.displayName !== null && typeof raw.displayName !== "string") ||
        SECRET_MATERIAL_FIELDS.some((f) => f in raw);
      if (invalid) {
        results.push({ secretKey, status: "invalid" });
        continue;
      }

      // Guardrail (SM1): a locked account/organization key cannot be overridden.
      if (membershipRepo && repo.getSecretMetadataByScopeKey) {
        const locked = await findLockedSecretAbove(
          repo as Pick<ConfigRepository, "getSecretMetadataByScopeKey">,
          membershipRepo,
          scope,
          secretKey,
        );
        if (locked) {
          results.push({ secretKey, status: "conflict" });
          continue;
        }
      }

      // Encrypt before any DB mutation — exactly like create-secret.
      let ciphertextEnvelope: string;
      try {
        ciphertextEnvelope = JSON.stringify(await encryptionAdapter.encrypt(raw.value as string));
      } catch {
        return errorResponse("internal_error", "Encryption failed", 503, requestId);
      }

      const result = await repo.createSecretMetadata({
        id: crypto.randomUUID(),
        scope,
        secretKey,
        displayName: (raw.displayName as string) ?? undefined,
        createdBy: createdByUuid,
        ciphertextEnvelope,
      });
      if (result.ok) {
        created++;
        results.push({ secretKey, status: "created" });
      } else if (result.error.kind === "conflict") {
        results.push({ secretKey, status: "conflict" });
      } else {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
    }

    // ONE event + audit entry for the whole batch — count only, never values.
    if (created > 0 && eventsRepo) {
      const eventResult = await eventsRepo.appendEventWithAudit({
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
          subjectId: "import",
          requestId,
          payload: {
            operation: "import",
            scope: scope.kind,
            requested: secrets.length,
            created,
          },
        },
        audit: {
          id: genId(),
          category: "config",
          description: `Secrets imported: ${created} of ${secrets.length} created`,
          projectId: "projectId" in scope ? scope.projectId : null,
          environmentId: "environmentId" in scope ? scope.environmentId : null,
        },
      });
      if (!eventResult.ok) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
    }

    return successResponse({ results }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
