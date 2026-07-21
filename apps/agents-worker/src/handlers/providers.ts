// Provider-connection handlers (saas-agents AG12, design §10): connect a
// Daytona account / add your Anthropic key. The apiKey is consumed at this
// boundary — forwarded to config-worker custody (reserved namespace) — and is
// never stored on, logged from, or readable back through the connection.

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import { AgentsError, isProvider, PROVIDERS, providerSecretRef, type Provider } from "@saas/db/agents";
import { errorResponse, listResponse, notFound, successResponse, validationError } from "../http.js";
import type { ProviderConnection as WireConnection } from "@saas/contracts/agents";
import type { ProviderConnection as DbConnection } from "@saas/db/agents";

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
  return out;
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

    // 2. The connection row (no key material; last4 hint only).
    const connection = await deps.repo.createConnection(
      { orgId },
      {
        provider,
        name,
        config,
        secretRef,
        keyHint: `…${apiKey.slice(-4)}`,
        // Not the UUID-column bug class: provider_connections.created_by is
        // TEXT and stores the public membership subject (like sessions'
        // spawned_by), so no uuidFromPublicId decode here.
        // eslint-disable-next-line no-restricted-syntax
        createdBy: actor.subjectId,
      },
    );

    // 3. Verify the key with a cheap read-only ping (design §10.3). A failed
    // ping still creates the connection — as `invalid`, with a redacted
    // reason — so the user sees exactly what happened.
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
  return successResponse({ deleted: true }, requestId);
}
