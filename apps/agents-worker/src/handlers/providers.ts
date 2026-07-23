// Provider-connection handlers (saas-agents AG12, design §10): connect a
// Daytona account / add your Anthropic key. The apiKey is consumed at this
// boundary — forwarded to config-worker custody (reserved namespace) — and is
// never stored on, logged from, or readable back through the connection.
//
// saas-integration-registry IR5 (dual-write): every lifecycle transition here
// also maintains the connection's IDENTITY row in integrations.connections
// (create → pending, verified → active, invalid → suspended, delete →
// revoked) and emits `integration.connected` / `integration.revoked` audit
// events — the same vocabulary integrations-worker uses. The identity write
// is best-effort and NULL-tolerant (risks R3: pre-backfill rows / unbound
// deps never break the agents flow); custody and provisioning stay put.

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import { AgentsError, isProvider, PROVIDERS, providerSecretRef, type Provider } from "@saas/db/agents";
import { asUuid, uuidToHex } from "@saas/db/ids";
import { INTEGRATION_EVENT_TYPES } from "@saas/contracts/integrations";
import { errorResponse, listResponse, notFound, successResponse, validationError } from "../http.js";
import type { ProviderConnection as WireConnection } from "@saas/contracts/agents";
import type { ProviderConnection as DbConnection } from "@saas/db/agents";

/** The integrations-plane public id (`int_<32hex>`) for an identity row —
 *  the same prefix rule integrations-worker's ids.ts applies. */
function integrationPublicId(uuid: string): string {
  return `int_${uuidToHex(uuid)}`;
}

export function toPublicConnection(c: DbConnection): WireConnection {
  const out: WireConnection = {
    id: c.publicId,
    provider: c.provider,
    name: c.name,
    config: c.config,
    status: c.status,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
  if (c.keyHint !== undefined) out.keyHint = c.keyHint;
  if (c.lastVerifiedAt !== undefined) out.lastVerifiedAt = c.lastVerifiedAt;
  if (c.statusReason !== undefined) out.statusReason = c.statusReason;
  // IR5 (additive): the registry identity, projected as its public id.
  if (c.connectionId !== undefined) out.connectionId = integrationPublicId(c.connectionId);
  return out;
}

/** Best-effort audit emission (IR5): the same `integration.*` vocabulary +
 *  events-repo pattern integrations-worker's connections handler uses. Never
 *  fails the calling flow. */
async function emitIntegrationAudit(
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
  type: string,
  connectionUuid: string,
  provider: string,
  name: string,
  description: string,
): Promise<void> {
  if (!deps.events) return;
  try {
    await deps.events.appendEventWithAudit({
      event: {
        id: crypto.randomUUID(),
        type,
        version: 1,
        source: "agents-worker",
        occurredAt: new Date(),
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        subjectKind: "integration_connection",
        subjectId: connectionUuid,
        requestId,
        payload: { provider, name },
      },
      audit: {
        id: crypto.randomUUID(),
        category: "integrations",
        description,
      },
    });
  } catch {
    // Best-effort: audit emission never fails the lifecycle write.
  }
}

export async function handleListConnections(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.provider.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider");
  const rows = await deps.repo.listConnections(
    { orgId },
    provider && isProvider(provider) ? provider : undefined,
  );
  return listResponse(rows.map(toPublicConnection), requestId, null);
}

export async function handleCreateConnection(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.provider.write", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["invalid JSON"] });
  }
  const b = body as Record<string, unknown>;
  const missing: Record<string, string[]> = {};
  if (typeof b.provider !== "string" || !isProvider(b.provider)) {
    missing.provider = [`one of ${PROVIDERS.join(", ")}`];
  }
  if (typeof b.apiKey !== "string" || b.apiKey.length === 0) {
    missing.apiKey = ["required"];
  }
  if (Object.keys(missing).length > 0) return validationError(requestId, missing);

  const provider = b.provider as Provider;
  const name = typeof b.name === "string" && b.name ? b.name : "default";
  const apiKey = b.apiKey as string;
  const config = (typeof b.config === "object" && b.config !== null ? b.config : {}) as Record<string, unknown>;
  const secretRef = providerSecretRef(provider, name);

  try {
    if (!deps.providerKeys) {
      return errorResponse("internal_error", "Key custody unavailable", 503, requestId);
    }

    // 1. Name guard: if a connection already owns this (provider, name), stop
    //    before touching custody — its key must never be clobbered. A duplicate
    //    is a connection conflict, surfaced as such.
    const existing = await deps.repo.listConnections({ orgId }, provider);
    if (existing.some((c) => c.name === name)) {
      return errorResponse("provider_connection_conflict", `A ${provider} connection named "${name}" already exists`, 409, requestId);
    }

    // 2. Clear an orphaned custody secret under this ref, if any. A prior
    //    connection under the same name may have been disconnected while its
    //    key lingered (pre-fix rows, or a partial teardown); the custody store
    //    conflicts on the reserved ref otherwise. Safe now: the guard above
    //    proved no live connection owns it. Best-effort — store is the arbiter.
    await deps.providerKeys.revoke(orgId, secretRef, actor, requestId);

    // 3. Key custody: if the store fails, no connection row exists.
    const stored = await deps.providerKeys.store(orgId, secretRef, apiKey, actor, requestId);
    if (!stored) {
      return errorResponse("internal_error", "Failed to store the key", 502, requestId);
    }

    // 4. IR5 dual-write, identity first: the integrations.connections row
    // (scope 'workspace' + share_mode 'auto' — IR-D4's private default) is
    // created before the facts row so connection_id rides the same INSERT.
    // Best-effort: an identity failure degrades to a NULL pointer (the same
    // pre-backfill shape the read path tolerates), never a failed connect.
    let connectionId: string | undefined;
    if (deps.integrations) {
      const identity = await deps.integrations.createConnection({
        id: crypto.randomUUID(),
        orgId: asUuid(orgId),
        provider,
        scope: "workspace",
        shareMode: "auto",
        displayName: name,
        createdBy: actor.subjectId,
      });
      if (identity.ok) connectionId = identity.value.id;
    }

    // 5. The connection facts row (no key material; last4 hint only).
    const connection = await deps.repo.createConnection(
      { orgId },
      {
        provider,
        name,
        config,
        secretRef,
        keyHint: `…${apiKey.slice(-4)}`,
        ...(connectionId !== undefined ? { connectionId } : {}),
        // Not the UUID-column bug class: provider_connections.created_by is
        // TEXT and stores the public membership subject (like sessions'
        // spawned_by), so no uuidFromPublicId decode here.
        // eslint-disable-next-line no-restricted-syntax
        createdBy: actor.subjectId,
      },
    );

    // 6. Verify the key with a cheap read-only ping (design §10.3). A failed
    // ping still creates the connection — as `invalid`, with a redacted
    // reason — so the user sees exactly what happened. The identity row
    // mirrors the outcome (verified→active + connected_at, invalid→suspended)
    // and a verified create emits `integration.connected` (IR5 audit gain).
    let verified = connection;
    if (deps.verifier) {
      const result = await deps.verifier.verify(provider, apiKey, config);
      verified = await deps.repo.setConnectionStatus(
        { orgId },
        {
          publicId: connection.publicId,
          status: result.ok ? "verified" : "invalid",
          ...(result.reason !== undefined ? { statusReason: result.reason } : {}),
        },
      );
      if (connectionId !== undefined && deps.integrations) {
        if (result.ok) {
          // pending → active; stamps connected_at (the identity was pending
          // from step 4, so the guarded activate always matches here).
          await deps.integrations.activateConnection(asUuid(orgId), asUuid(connectionId), {
            displayName: name,
          });
          await emitIntegrationAudit(
            deps,
            orgId,
            actor,
            requestId,
            INTEGRATION_EVENT_TYPES.CONNECTED,
            connectionId,
            provider,
            name,
            `${provider} provider connection "${name}" connected (key verified)`,
          );
        } else {
          await deps.integrations.updateConnectionStatus(
            asUuid(orgId),
            asUuid(connectionId),
            "suspended",
          );
        }
      }
    }
    return successResponse(toPublicConnection(verified), requestId, 201);
  } catch (e) {
    if (e instanceof AgentsError) {
      const status = e.code.endsWith("conflict") ? 409 : 400;
      return errorResponse(e.code, e.message, status, requestId);
    }
    throw e;
  }
}

export async function handleVerifyConnection(
  deps: AgentsDeps,
  orgId: string,
  connectionId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.provider.write", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const connection = await deps.repo.getConnection({ orgId }, connectionId);
  if (!connection) return notFound(requestId, connectionId);
  if (!deps.providerKeys || !deps.verifier) {
    return errorResponse("internal_error", "Verification unavailable", 503, requestId);
  }
  const apiKey = await deps.providerKeys.resolve(orgId, connection.secretRef, actor, requestId);
  if (!apiKey) {
    return errorResponse("provider_connection_invalid", "No key material for this connection", 409, requestId);
  }
  const result = await deps.verifier.verify(connection.provider, apiKey, connection.config);
  const updated = await deps.repo.setConnectionStatus(
    { orgId },
    {
      publicId: connection.publicId,
      status: result.ok ? "verified" : "invalid",
      ...(result.reason !== undefined ? { statusReason: result.reason } : {}),
    },
  );
  // IR5: mirror the verification outcome onto the identity row. Skip silently
  // when connection_id is null — pre-backfill tolerance (risks R3 dual-read).
  if (connection.connectionId !== undefined && deps.integrations) {
    await deps.integrations.updateConnectionStatus(
      asUuid(orgId),
      asUuid(connection.connectionId),
      result.ok ? "active" : "suspended",
    );
    if (result.ok) {
      await emitIntegrationAudit(
        deps,
        orgId,
        actor,
        requestId,
        INTEGRATION_EVENT_TYPES.CONNECTED,
        connection.connectionId,
        connection.provider,
        connection.name,
        `${connection.provider} provider connection "${connection.name}" verified`,
      );
    }
  }
  return successResponse(toPublicConnection(updated), requestId);
}

export async function handleDeleteConnection(
  deps: AgentsDeps,
  orgId: string,
  connectionId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.provider.write", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  // Read the connection's secretRef before deleting the row — the row is the
  // only pointer to the custody secret, so we capture it first, then tear down
  // both. Without this the key is orphaned and blocks a same-name re-connect.
  const connection = await deps.repo.getConnection({ orgId }, connectionId);
  const removed = await deps.repo.deleteConnection({ orgId }, connectionId);
  if (!removed) return notFound(requestId, connectionId);
  if (connection && deps.providerKeys) {
    // Best-effort custody teardown: a lingering key is a hygiene problem the
    // next connect's orphan-clear also handles — never fail the disconnect.
    await deps.providerKeys.revoke(orgId, connection.secretRef, actor, requestId);
  }
  // IR5: revoke the identity row (status 'revoked' + revoked_at) and emit
  // `integration.revoked`. Skip silently on a null pointer (pre-backfill).
  if (connection?.connectionId !== undefined && deps.integrations) {
    await deps.integrations.updateConnectionStatus(
      asUuid(orgId),
      asUuid(connection.connectionId),
      "revoked",
    );
    await emitIntegrationAudit(
      deps,
      orgId,
      actor,
      requestId,
      INTEGRATION_EVENT_TYPES.REVOKED,
      connection.connectionId,
      connection.provider,
      connection.name,
      `${connection.provider} provider connection "${connection.name}" revoked`,
    );
  }
  return successResponse({ deleted: true }, requestId);
}
