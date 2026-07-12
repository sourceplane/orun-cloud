// Cloudflare token-paste connect (IH5, design §5.2) — the third connect
// kind. No popup, no state round-trip: the paste IS the proof. The worker
// verifies the parent token (`GET /user/tokens/verify`), discovers the
// account, stores the ONLY durable credential as a custody envelope, records
// verified facts, and activates — all in one authenticated request. The
// parent token is write-only from this moment: never re-shown, never logged.
//
// The caller (handleConnectIntegration) has already passed policy,
// entitlement, and the D1 registry gate.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConnectIntegrationResponse } from "@saas/contracts/integrations";
import { INTEGRATION_EVENT_TYPES } from "@saas/contracts/integrations";
import {
  createIntegrationHubRepository,
  createIntegrationsRepository,
} from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { asUuid, uuidFromPublicId, type Uuid } from "@saas/db/ids";
import type { FetchLike } from "../github-app.js";
import { createEncryptionAdapter } from "../encryption.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { generateUuid, orgPublicId } from "../ids.js";
import { toPublicConnection } from "../mappers.js";
import {
  discoverCloudflareAccount,
  verifyCloudflareParentToken,
} from "../providers/cloudflare.js";
import { CONNECT_STATE_TTL_MS, generateStateNonce, hashStateNonce } from "../state.js";

// Cloudflare API tokens are ~40 url-safe chars; accept a generous band
// without ever echoing the value back.
const PARENT_TOKEN_RE = /^[A-Za-z0-9._-]{20,256}$/;

export interface CloudflareConnectDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

export async function handleCloudflareTokenConnect(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  input: { parentToken: unknown; displayName: string | null; scope: "account" | "workspace" },
  deps?: CloudflareConnectDeps,
): Promise<Response> {
  if (typeof input.parentToken !== "string" || !PARENT_TOKEN_RE.test(input.parentToken)) {
    return validationError(requestId, { parentToken: ["Required: a Cloudflare API token"] });
  }
  const parentToken = input.parentToken;

  const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  if (!encryption) {
    return errorResponse(
      "precondition_failed",
      "Credential custody is not configured for this environment",
      412,
      requestId,
      { reason: "not_configured", gate: "cloudflare_custody" },
    );
  }

  // Verify BEFORE any write: the paste must be a live token that can see an
  // account. Anything else fails closed with a bounded reason.
  const verification = await verifyCloudflareParentToken(parentToken, deps?.fetchImpl);
  if (!verification || verification.status !== "active") {
    return errorResponse(
      "precondition_failed",
      "Cloudflare did not verify this token",
      412,
      requestId,
      { reason: "token_verification_failed" },
    );
  }
  const account = await discoverCloudflareAccount(parentToken, deps?.fetchImpl);
  if (!account) {
    return errorResponse(
      "precondition_failed",
      "The token cannot see any Cloudflare account",
      412,
      requestId,
      { reason: "no_account_visible" },
    );
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const hub = createIntegrationHubRepository(executor);

    // Re-auth (IH9): if this account is already bound to a connection, the
    // paste is a re-authorization, not a new connect. Owned by THIS org →
    // refresh custody + facts on the EXISTING connection and reactivate it
    // (a suspended connection heals; its mints/brokered secrets keep their
    // binding). Owned elsewhere → refuse — the binding must never flip
    // across orgs. Only a revoked own connection falls through to a fresh
    // create (revoke was an explicit removal; the flip-style facts upsert
    // rebinds the account to the new connection).
    const existing = await hub.getCloudflareAccountByExternalId(account.accountExternalId);
    if (existing.ok && existing.value.connectionId) {
      const boundId = asUuid(existing.value.connectionId);
      const own = await repo.getConnection(orgId, boundId);
      if (own.ok && own.value.status !== "revoked") {
        const envelope = await encryption.encrypt(parentToken);
        const stored = await hub.upsertProviderCredential({
          id: generateUuid(),
          connectionId: boundId,
          kind: "cloudflare_parent_token",
          ciphertext: JSON.stringify(envelope),
          externalRef: account.accountExternalId,
          expiresAt: verification.expiresOn ? new Date(verification.expiresOn) : null,
        });
        if (!stored.ok) {
          return errorResponse("internal_error", "Service unavailable", 503, requestId);
        }
        const facts = await hub.upsertCloudflareAccount({
          id: generateUuid(),
          connectionId: boundId,
          accountExternalId: account.accountExternalId,
          accountName: account.accountName,
          parentTokenRef: verification.tokenId,
          tokenStatus: "active",
          parentExpiresAt: verification.expiresOn ? new Date(verification.expiresOn) : null,
        });
        if (!facts.ok) {
          return errorResponse("internal_error", "Service unavailable", 503, requestId);
        }
        let connection = own.value;
        if (connection.status !== "active") {
          const reactivated = await repo.updateConnectionStatus(orgId, boundId, "active");
          if (!reactivated.ok) {
            return errorResponse("internal_error", "Service unavailable", 503, requestId);
          }
          connection = reactivated.value;
        }
        try {
          const events = createEventsRepository(executor);
          await events.appendEventWithAudit({
            event: {
              id: generateUuid(),
              type: INTEGRATION_EVENT_TYPES.REACTIVATED,
              version: 1,
              source: "integrations-worker",
              occurredAt: new Date(),
              actorType: actor.subjectType,
              actorId: actor.subjectId,
              orgId,
              subjectKind: "integration_connection",
              subjectId: connection.id,
              requestId,
              payload: { provider: "cloudflare", reason: "reauthorized" },
            },
            audit: {
              id: generateUuid(),
              category: "integrations",
              description: "Cloudflare connection re-authorized (fresh parent token)",
            },
          });
        } catch {
          // best-effort
        }
        const payload: ConnectIntegrationResponse = { connection: toPublicConnection(connection) };
        return successResponse(payload, requestId, 200);
      }
      if (!own.ok) {
        // Bound to a connection this org cannot see — never flip it.
        return errorResponse(
          "conflict",
          "This Cloudflare account is already linked to a connection",
          409,
          requestId,
        );
      }
    }

    // The pending row exists only inside this request; the state nonce is
    // never issued anywhere (token connect has no callback to redeem it).
    const connectionId = generateUuid();
    const created = await repo.createConnection({
      id: connectionId,
      orgId,
      provider: "cloudflare",
      scope: input.scope,
      displayName: input.displayName,
      createdBy: uuidFromPublicId(actor.subjectId),
      stateNonceHash: await hashStateNonce(generateStateNonce()),
      stateExpiresAt: new Date(Date.now() + CONNECT_STATE_TTL_MS),
    });
    if (!created.ok) {
      if (created.error.kind === "conflict") {
        return errorResponse("conflict", "A connection for this account already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    // Custody first (design §3): the envelope's externalRef anchors every
    // future mint to the verified account.
    const envelope = await encryption.encrypt(parentToken);
    const stored = await hub.upsertProviderCredential({
      id: generateUuid(),
      connectionId: asUuid(connectionId),
      kind: "cloudflare_parent_token",
      ciphertext: JSON.stringify(envelope),
      externalRef: account.accountExternalId,
      expiresAt: verification.expiresOn ? new Date(verification.expiresOn) : null,
    });
    if (!stored.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const facts = await hub.upsertCloudflareAccount({
      id: generateUuid(),
      connectionId: asUuid(connectionId),
      accountExternalId: account.accountExternalId,
      accountName: account.accountName,
      parentTokenRef: verification.tokenId,
      tokenStatus: "active",
      parentExpiresAt: verification.expiresOn ? new Date(verification.expiresOn) : null,
    });
    if (!facts.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    // An account already claimed by another live connection must not flip.
    if (facts.value.connectionId !== connectionId) {
      return errorResponse(
        "conflict",
        "This Cloudflare account is already linked to a connection",
        409,
        requestId,
      );
    }

    const activated = await repo.activateConnection(orgId, asUuid(connectionId), {
      displayName: input.displayName ?? account.accountName ?? account.accountExternalId,
      externalAccountLogin: account.accountName ?? account.accountExternalId,
      externalAccountId: account.accountExternalId,
      externalAccountType: "account",
    });
    if (!activated.ok) {
      if (activated.error.kind === "conflict") {
        return errorResponse(
          "conflict",
          "An active connection for this Cloudflare account already exists in the organization",
          409,
          requestId,
        );
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    try {
      const events = createEventsRepository(executor);
      await events.appendEventWithAudit({
        event: {
          id: generateUuid(),
          type: INTEGRATION_EVENT_TYPES.CONNECTED,
          version: 1,
          source: "integrations-worker",
          occurredAt: new Date(),
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          subjectKind: "integration_connection",
          subjectId: connectionId,
          requestId,
          payload: {
            provider: "cloudflare",
            orgId: orgPublicId(orgId),
            accountExternalId: account.accountExternalId,
            accountName: account.accountName,
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `Cloudflare connected${account.accountName ? ` (${account.accountName})` : ""}`,
        },
      });
    } catch {
      // Best-effort: the connection is active; audit emission is not a gate.
    }

    const payload: ConnectIntegrationResponse = {
      connection: toPublicConnection(activated.value),
    };
    return successResponse(payload, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
