// POST /internal/credentials/rotate-source (SC2, scoped-credential rotation).
//
// A scoped credential (brokered secret) resolves a fresh, scoped value every
// run — so "rotating" a scoped credential means rotating the org-owned SOURCE
// it draws from, not a stored value. config-worker calls this over the service
// binding when a user hits "Rotate now" (or the rotation cron fires) on a
// brokered secret; it rolls the connection's infrastructure custody:
//
//   cloudflare → roll the account-owned service token IN PLACE (same token id,
//     new secret) under the connection mint lock, re-enveloped inside the lock.
//     A paste/legacy connection with no service token can't be rolled by us →
//     rotation_unsupported.
//   supabase   → refresh the management session (the refresh token rotates on
//     use, re-enveloped) and re-fetch the per-project service keys into custody
//     (the `project-service-key` source). No OAuth app / no project custody →
//     rotation_unsupported.
//
// Service-binding-only (x-internal-caller: config-worker). Metadata only in and
// out — the rotated credential value never crosses this boundary; only the
// timestamp does.

import type { Env } from "../env.js";
import {
  createIntegrationsRepository,
  createIntegrationHubRepository,
  type IntegrationConnection,
} from "@saas/db/integrations";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { asUuid, type Uuid } from "@saas/db/ids";
import type { FetchLike } from "../github-app.js";
import { errorResponse, successResponse } from "../http.js";
import { resolveUsableConnection } from "../connection-access.js";
import { rotateCloudflareServiceIdentity } from "../providers/cloudflare.js";
import {
  fetchSupabaseProjectServiceKeys,
  listSupabaseProjects,
  refreshSupabaseAccess,
} from "../providers/supabase.js";
import { readParentCredentialOfKind, reEnvelopeParentCredential } from "../custody.js";
import { createEncryptionAdapter } from "../encryption.js";
import { connectionMintLockRunner, type MintLockRunner } from "../mint-lock.js";
import { generateUuid } from "../ids.js";

export const ROTATE_SOURCE_PATH = "/internal/credentials/rotate-source";

export type RotateSourceReason =
  | "rotation_unsupported"
  | "provider_error"
  | "service_error";

export type RotateSourceOutcome =
  | { ok: true; rotatedAt: Date }
  | { ok: false; reason: RotateSourceReason };

export interface RotateSourceDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
  mintLock?: MintLockRunner;
  now?: Date;
}

/**
 * Rotate the org-owned source credential behind a connection. Pure of HTTP —
 * the handler and the (future) rotation cron both call this.
 */
export async function rotateConnectionSource(
  env: Env,
  executor: SqlExecutor,
  connection: IntegrationConnection,
  deps?: RotateSourceDeps,
): Promise<RotateSourceOutcome> {
  const now = deps?.now ?? new Date();
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const runLocked = deps?.mintLock ?? connectionMintLockRunner(env.MINT_LOCKS);
  const connectionUuid = asUuid(connection.id);
  const hub = createIntegrationHubRepository(executor);

  if (connection.provider === "cloudflare") {
    const facts = await hub.getCloudflareAccountByConnectionId(connectionUuid);
    // No service-token id to roll (pasted parent token / legacy) — the pasted
    // token is the CUSTOMER's; we never roll it. Nothing for us to rotate.
    if (!facts.ok || !facts.value.parentTokenRef) return { ok: false, reason: "rotation_unsupported" };
    const tokenRef = facts.value.parentTokenRef;
    const section = await runLocked(String(connection.id), async (): Promise<boolean | "unsupported"> => {
      const parent = await readParentCredentialOfKind(env, executor, connectionUuid, "cloudflare_service_token");
      if (!parent) return "unsupported";
      const rotated = await rotateCloudflareServiceIdentity(
        { current: parent, providerRef: tokenRef, nowMs: now.getTime() },
        fetchImpl,
      );
      if (!rotated.ok) return false;
      // Re-envelope INSIDE the lock: no mint may read the retired value after
      // the provider has already invalidated it.
      return reEnvelopeParentCredential(
        env,
        executor,
        connectionUuid,
        "cloudflare_service_token",
        rotated.value.credential,
        parent.externalRef,
      );
    });
    if (!section.ok) return { ok: false, reason: "provider_error" }; // lock timeout — retryable upstream
    if (section.value === "unsupported") return { ok: false, reason: "rotation_unsupported" };
    return section.value ? { ok: true, rotatedAt: now } : { ok: false, reason: "provider_error" };
  }

  if (connection.provider === "supabase") {
    if (!env.SUPABASE_OAUTH_CLIENT_ID || !env.SUPABASE_OAUTH_CLIENT_SECRET) {
      return { ok: false, reason: "rotation_unsupported" };
    }
    const credentials = {
      clientId: env.SUPABASE_OAUTH_CLIENT_ID,
      clientSecret: env.SUPABASE_OAUTH_CLIENT_SECRET,
    };
    const orgFacts = await hub.getSupabaseOrgByConnectionId(connectionUuid);
    if (!orgFacts.ok) return { ok: false, reason: "rotation_unsupported" };
    const section = await runLocked(String(connection.id), async (): Promise<boolean> => {
      const parent = await readParentCredentialOfKind(env, executor, connectionUuid, "supabase_refresh_token");
      if (!parent) return false;
      const grant = await refreshSupabaseAccess(credentials, parent.credential, fetchImpl);
      if (!grant) return false;
      // Supabase rotates the refresh token on use — re-envelope FIRST.
      if (grant.refreshToken !== parent.credential) {
        await reEnvelopeParentCredential(
          env,
          executor,
          connectionUuid,
          "supabase_refresh_token",
          grant.refreshToken,
          parent.externalRef,
        );
      }
      const projects = await listSupabaseProjects(grant.accessToken, fetchImpl);
      if (!projects || projects.length === 0) return false;
      const keys = await fetchSupabaseProjectServiceKeys(
        grant.accessToken,
        projects.map((p) => p.ref),
        fetchImpl,
      );
      if (!keys) return false;
      const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
      if (!encryption) return false;
      const envelope = await encryption.encrypt(JSON.stringify(keys));
      const stored = await hub.upsertProviderCredential({
        id: generateUuid(),
        connectionId: connectionUuid,
        kind: "supabase_project_secret",
        ciphertext: JSON.stringify(envelope),
        scopes: Object.keys(keys),
        externalRef: orgFacts.value.supabaseOrgId,
      });
      return stored.ok;
    });
    if (!section.ok) return { ok: false, reason: "provider_error" };
    return section.value ? { ok: true, rotatedAt: now } : { ok: false, reason: "provider_error" };
  }

  return { ok: false, reason: "rotation_unsupported" };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** POST /internal/credentials/rotate-source — the config-worker-driven rotate.
 *  Both ids are raw UUIDs (config-worker holds them from the secret's binding
 *  columns), never public ids. */
export async function handleInternalRotateSource(
  request: Request,
  env: Env,
  requestId: string,
  deps?: RotateSourceDeps,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const rawOrg = typeof body.orgId === "string" ? body.orgId : "";
  const rawConnection = typeof body.connectionId === "string" ? body.connectionId : "";
  if (!UUID_RE.test(rawOrg) || !UUID_RE.test(rawConnection)) {
    return errorResponse("validation_failed", "orgId and connectionId must be raw UUIDs", 422, requestId, {
      reason: "params_invalid",
    });
  }
  const orgId = asUuid(rawOrg);

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const connection = await resolveUsableConnection(env, repo, orgId, asUuid(rawConnection) as Uuid, requestId);
    if (!connection) {
      return errorResponse("not_found", "Not found", 404, requestId, { reason: "connection_not_found" });
    }
    if (connection.status !== "active") {
      return errorResponse("precondition_failed", "The connection is not active", 412, requestId, {
        reason: "connection_inactive",
      });
    }

    const outcome = await rotateConnectionSource(env, executor, connection, deps);
    if (!outcome.ok) {
      if (outcome.reason === "rotation_unsupported") {
        return errorResponse(
          "unsupported",
          "This connection's source credential cannot be rotated by Orun",
          400,
          requestId,
          { reason: "rotation_unsupported" },
        );
      }
      return errorResponse("bad_gateway", "The provider refused the rotation", 502, requestId, {
        reason: "provider_error",
      });
    }
    return successResponse({ rotatedAt: outcome.rotatedAt.toISOString() }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId, { reason: "unavailable" });
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
