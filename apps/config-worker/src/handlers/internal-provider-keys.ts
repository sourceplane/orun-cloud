/**
 * Internal provider-key custody (saas-agents AG12, design §10.2).
 *
 * Two service-binding-only routes — reachable ONLY over the agents-worker →
 * config-worker binding; api-edge never forwards /v1/internal/*:
 *
 *   POST /v1/internal/config/provider-keys/store    — encrypt + store a BYO
 *     provider API key (Daytona / Anthropic) under the RESERVED namespace
 *     `agents/providers/<provider>/<name>/API_KEY`, org scope.
 *   POST /v1/internal/config/provider-keys/resolve  — decrypt it for exactly
 *     two moments: a verification ping and a session spawn.
 *
 * config-worker stays the ONLY decrypt path in the codebase. This is
 * deliberately NOT the SM3 run-lease resolve: session spawn has a session
 * lease, not a job lease; the two contracts stay distinct. Both routes are
 * restricted to the reserved namespace so this seam can never become a
 * general-purpose secret backdoor. The plaintext is never logged, never in an
 * event payload, and returned only inside the resolve response body.
 */

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository } from "@saas/db/config";
import { createConfigRepository, createSecretDekRepository } from "@saas/db/config";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { uuidFromPublicId } from "@saas/db";
import { errorResponse, successResponse, validationError } from "../http.js";
import { decryptEnvelope } from "../decryption.js";
import type { EncryptionAdapter } from "../encryption.js";

const RESERVED_PREFIX = "agents/providers/";
// The closed provider vocabulary mirrors @saas/db/agents PROVIDERS; this seam
// stays namespace-restricted so it can never become a general-purpose secret
// backdoor. Widen both together (and the provider_connections CHECK migration).
const RESERVED_KEY_RE = /^agents\/providers\/(daytona|anthropic|openai|openrouter)\/[a-z0-9][a-z0-9-]*\/API_KEY$/;

export interface ProviderKeyDeps {
  repo: Pick<
    ConfigRepository,
    "createSecretMetadata" | "getSecretMetadataByScopeKey" | "getSecretCiphertext"
  >;
  encryptionAdapter?: EncryptionAdapter | null;
  decrypt?: (envelope: string) => Promise<string>;
}

function isReservedKey(key: unknown): key is string {
  return typeof key === "string" && RESERVED_KEY_RE.test(key);
}

/** POST /v1/internal/config/provider-keys/store — { orgId, key, value }. */
export async function handleProviderKeyStore(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  deps?: ProviderKeyDeps,
): Promise<Response> {
  let body: { orgId?: string; key?: string; value?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return validationError(requestId, { body: ["invalid JSON"] });
  }
  if (!body.orgId) return validationError(requestId, { orgId: ["required"] });
  if (!isReservedKey(body.key)) {
    return validationError(requestId, { key: [`must match ${RESERVED_PREFIX}<provider>/<name>/API_KEY`] });
  }
  if (typeof body.value !== "string" || body.value.length === 0 || body.value.length > 4096) {
    return validationError(requestId, { value: ["required (≤ 4096 chars)"] });
  }

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);

    let adapter: EncryptionAdapter | null | undefined = deps?.encryptionAdapter;
    if (adapter === undefined && !deps) {
      const { createSecretEncryptionAdapter } = await import("../encryption.js");
      adapter = await createSecretEncryptionAdapter(env, body.orgId);
    }
    if (!adapter) {
      return errorResponse("internal_error", "Encryption is not configured", 503, requestId);
    }

    const envelope = JSON.stringify(await adapter.encrypt(body.value));
    const createdBy = uuidFromPublicId(actor.subjectId) ?? actor.subjectId;
    const result = await repo.createSecretMetadata({
      id: crypto.randomUUID(),
      scope: { kind: "organization", orgId: body.orgId },
      secretKey: body.key,
      displayName: `Provider key (${body.key.split("/")[2] ?? "agents"})`,
      createdBy: createdBy as never,
      ciphertextEnvelope: envelope,
    });
    if (!result.ok) {
      // Namespace collision = the connection name is taken.
      return errorResponse("provider_connection_conflict", "Key already stored for this connection", 409, requestId);
    }
    return successResponse({ stored: true, key: body.key }, requestId, 201);
  } finally {
    if (executor) await executor.dispose();
  }
}

/** POST /v1/internal/config/provider-keys/resolve — { orgId, key } → { value }. */
export async function handleProviderKeyResolve(
  request: Request,
  env: Env,
  requestId: string,
  _actor: ActorContext,
  deps?: ProviderKeyDeps,
): Promise<Response> {
  let body: { orgId?: string; key?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return validationError(requestId, { body: ["invalid JSON"] });
  }
  if (!body.orgId) return validationError(requestId, { orgId: ["required"] });
  if (!isReservedKey(body.key)) {
    return validationError(requestId, { key: [`must match ${RESERVED_PREFIX}<provider>/<name>/API_KEY`] });
  }

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);
    const dekRepo = executor ? createSecretDekRepository(executor) : null;
    const decrypt =
      deps?.decrypt ??
      (async (envelope: string): Promise<string> =>
        decryptEnvelope(envelope, {
          ...(env.SECRET_ENCRYPTION_KEY ? { staticKeyHex: env.SECRET_ENCRYPTION_KEY } : {}),
          ...(env.SECRET_KEK ? { kekHex: env.SECRET_KEK } : {}),
          getWrappedDek: async (o: string, gen: number) => {
            const r = await dekRepo!.getWrappedDek(o, gen);
            return r.ok ? r.value : null;
          },
        }));

    const meta = await repo.getSecretMetadataByScopeKey(
      { kind: "organization", orgId: body.orgId },
      body.key,
    );
    if (!meta.ok) {
      return errorResponse("provider_connection_not_found", "No key stored under this connection", 404, requestId);
    }
    const cipher = await repo.getSecretCiphertext(meta.value.id, meta.value.version);
    if (!cipher.ok) {
      return errorResponse("provider_connection_not_found", "No key material for this connection", 404, requestId);
    }
    let value: string;
    try {
      value = await decrypt(cipher.value);
    } catch {
      // Never surface key material or envelope details in the error.
      return errorResponse("internal_error", "Decryption failed", 500, requestId);
    }
    return successResponse({ key: body.key, value, ttlSeconds: 300 }, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
