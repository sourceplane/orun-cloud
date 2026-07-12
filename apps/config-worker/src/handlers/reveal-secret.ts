/**
 * Break-glass secret reveal (saas-secret-manager SEC7, pairs orun-secrets SD-3).
 *
 * POST /v1/organizations/.../config/secrets/{id}/reveal, body `{ reason }`.
 *
 * This is the ONE human-facing route that returns a secret VALUE. It is an
 * ELEVATED, AUDITED break-glass path: the caller must hold the dedicated
 * `secret.reveal` action (owner/admin only, SM1 matrices), a non-empty reason is
 * mandatory, and every reveal emits an alert-worthy `secret.revealed` event +
 * audit row naming the key + reason (NEVER the value).
 *
 * It is the SECOND authorized consumer of the decrypt path (the first is the
 * lease-verified internal resolve, SM3). The plaintext materializes only in this
 * handler's decrypt + the response body; it is NEVER logged, NEVER placed in an
 * event or audit payload.
 */

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository, Scope } from "@saas/db/config";
import type { EventsRepository } from "@saas/db/events";
import { createConfigRepository, createSecretDekRepository } from "@saas/db/config";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { scopeMatchesRequested } from "../scope-match.js";
import { decryptEnvelope } from "../decryption.js";
import { SECRET_EVENT_TYPES } from "../secret-events.js";
import type { PolicyResource } from "@saas/contracts/policy";

/** The elevated break-glass action (policy-engine catalog + SM1 owner/admin matrices). */
const REVEAL_ACTION = "secret.reveal";

export interface RevealSecretDeps {
  repo: Pick<ConfigRepository, "getSecretMetadata" | "getSecretCiphertext">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  /**
   * Injectable authorization for tests; production runs the membership+policy
   * round-trip. Receives the resolved action + resource so a test can assert the
   * `secret.reveal` action was evaluated and toggle allow/deny.
   */
  authorize?: (action: string, resource: PolicyResource) => Promise<boolean>;
  /** Decrypt injector for tests; production wires decryptEnvelope over the DEK repo. */
  decrypt?: (envelope: string, orgId: string) => Promise<string>;
  generateId?: () => string;
  now?: () => Date;
}

export async function handleRevealSecret(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  requestedScope: Scope,
  secretId: string,
  deps?: RevealSecretDeps,
): Promise<Response> {
  const orgId = requestedScope.orgId;

  // ── Parse + validate the mandatory reason ──
  let reason: string;
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object") {
      return validationError(requestId, { reason: ["A non-empty reason is required"] });
    }
    const raw = (body as Record<string, unknown>).reason;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return validationError(requestId, { reason: ["A non-empty reason is required"] });
    }
    reason = raw.trim();
  } catch {
    return validationError(requestId, { reason: ["A non-empty reason is required"] });
  }

  // Optional version pin (?version=N); default is the serving head version.
  const url = new URL(request.url);
  const versionParam = url.searchParams.get("version");
  let pinnedVersion: number | undefined;
  if (versionParam !== null) {
    const n = Number(versionParam);
    if (!Number.isInteger(n) || n < 1) {
      return validationError(requestId, { version: ["version must be a positive integer"] });
    }
    pinnedVersion = n;
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

  const genId = deps?.generateId ?? (() => crypto.randomUUID());
  const now = deps?.now ? deps.now() : new Date();
  const decisionId = `dec_${genId().replace(/-/g, "")}`;

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? (executor ? createEventsRepository(executor) : null);

    // ── Resolve the secret head (404 when absent or scope-mismatched). ──
    const existing = await repo.getSecretMetadata(orgId, secretId);
    if (!existing.ok) {
      return errorResponse("not_found", "Secret not found", 404, requestId);
    }
    const secret = existing.value;
    if (!scopeMatchesRequested(secret, requestedScope)) {
      return errorResponse("not_found", "Secret not found", 404, requestId);
    }

    // ── Authorize the ELEVATED reveal action. Deny → 403 (unlike the write
    //    handlers' resource-hiding 404: the caller already proved the secret
    //    exists, and break-glass denials are meant to be observable). ──
    const resource: PolicyResource = {
      kind: secret.scopeKind === "organization" ? "organization" : "project",
      orgId,
    };
    if (secret.projectId) resource.projectId = secret.projectId;

    let allowed: boolean;
    if (deps?.authorize) {
      allowed = await deps.authorize(REVEAL_ACTION, resource);
    } else if (deps) {
      // A deps fake without an authorize hook cannot vouch for the elevated
      // action — fail closed rather than reveal.
      allowed = false;
    } else {
      const contextResult = await fetchAuthorizationContext(
        env.MEMBERSHIP_WORKER!,
        actor.subjectId,
        actor.subjectType,
        orgId,
        requestId,
      );
      if (!contextResult.ok) {
        return errorResponse("forbidden", "Not authorized to reveal this secret", 403, requestId, { decisionId });
      }
      const policyResult = await authorizeViaPolicy(
        env.POLICY_WORKER!,
        actor.subjectId,
        actor.subjectType,
        REVEAL_ACTION,
        resource,
        contextResult.memberships,
        requestId,
      );
      allowed = policyResult.allow;
    }
    if (!allowed) {
      return errorResponse("forbidden", "Not authorized to reveal this secret", 403, requestId, { decisionId });
    }

    // ── Brokered guard (IH7): a brokered head has no stored value — its
    //    envelope is a binding pointer, so there is nothing to reveal. ──
    if (secret.source === "brokered") {
      return errorResponse("unsupported", "A brokered secret has no stored value to reveal", 400, requestId, { reason: "brokered" });
    }

    // ── Load the serving version's ciphertext (404 when the version is gone). ──
    const version = pinnedVersion ?? secret.version;
    const cipherResult = await repo.getSecretCiphertext(secretId, version);
    if (!cipherResult.ok) {
      return errorResponse("not_found", "Secret version not found", 404, requestId, { decisionId });
    }

    // Belt-and-braces (IH7): even if the metadata flag is missing, an envelope
    // that parses as the brokered pointer must never reach decrypt.
    if (isBrokeredPointer(cipherResult.value)) {
      return errorResponse("unsupported", "A brokered secret has no stored value to reveal", 400, requestId, { reason: "brokered" });
    }

    // ── Decrypt — the plaintext materializes ONLY here + the response body. ──
    const decrypt = deps?.decrypt ?? buildProdDecrypt(env, executor);
    let value: string;
    try {
      value = await decrypt(cipherResult.value, secret.orgId);
    } catch {
      // Never surface key material or ciphertext in the error.
      return errorResponse("internal_error", "Decryption failed", 503, requestId, { decisionId });
    }

    // ── Audit the reveal — key + version + reason + decisionId, NEVER the value.
    //    The audit MUST succeed for a break-glass reveal: on failure we return
    //    503 and DO NOT return the value (an un-audited reveal is not allowed). ──
    if (eventsRepo) {
      const eventResult = await eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: SECRET_EVENT_TYPES.REVEALED,
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
          subjectName: secret.secretKey,
          requestId,
          // Key + version + reason + decisionId only. NEVER the value.
          payload: { key: secret.secretKey, version, reason, decisionId },
        },
        audit: {
          id: genId(),
          category: "config",
          description: `Secret revealed (break-glass): ${secret.secretKey} (v${version}) — reason: ${reason}`,
          projectId: secret.projectId,
          environmentId: secret.environmentId,
        },
      });
      if (!eventResult.ok) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId, { decisionId });
      }
    }

    // The ONE value-returning response in the product.
    return successResponse({ secret: { value, version } }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/** True when the envelope text is the IH7 brokered binding pointer, not ciphertext. */
function isBrokeredPointer(envelope: string): boolean {
  try {
    const parsed = JSON.parse(envelope) as unknown;
    return !!parsed && typeof parsed === "object" && (parsed as { v?: unknown }).v === "brokered";
  } catch {
    return false;
  }
}

/**
 * The production decrypt closure — the same envelope deps the internal resolve
 * builds (static key + KEK + wrapped-DEK lookup). Extracted so the reveal path
 * and the resolve path share one decrypt surface.
 */
function buildProdDecrypt(
  env: Env,
  executor: ReturnType<typeof createSqlExecutor> | null,
): (envelope: string, orgId: string) => Promise<string> {
  const dekRepo = executor ? createSecretDekRepository(executor) : null;
  return async (envelope: string): Promise<string> =>
    decryptEnvelope(envelope, {
      ...(env.SECRET_ENCRYPTION_KEY ? { staticKeyHex: env.SECRET_ENCRYPTION_KEY } : {}),
      ...(env.SECRET_KEK ? { kekHex: env.SECRET_KEK } : {}),
      getWrappedDek: async (o: string, gen: number) => {
        const r = await dekRepo!.getWrappedDek(o, gen);
        return r.ok ? r.value : null;
      },
    });
}
