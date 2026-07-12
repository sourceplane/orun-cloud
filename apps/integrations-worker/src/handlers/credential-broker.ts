// The credential broker core (IH4, design §5.1): the provider-generic mint
// API over the IH0 CredentialBrokerCapability seam and the minted_credentials
// ledger. All IG4 rules, generalized:
//
//   templates, not raw scopes  — a mint names a published template + params;
//                                the adapter computes the provider grant.
//   TTL requested, clamped     — min(request, template max, hard ceiling 1h);
//                                the ledger records the ACTUAL expiry.
//   reveal-once                — the response is the only time the platform
//                                emits the value; ledger + events carry
//                                template/params/ttl/actor, never credentials.
//                                A credential is revealed ONLY once ledgered.
//   revocable                  — DELETE …/credentials/{mintId} best-effort
//                                revokes provider-side and marks the ledger;
//                                TTL is the backstop. Connection revoke fans
//                                out over live mints (connections.ts).
//
// Policy organization.integration.credential.issue; entitlement
// feature.integrations.credential_broker; per-org daily mint rate limit
// (limit.credential_mints_per_day) enforced against the ledger itself.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PolicyResource } from "@saas/contracts/policy";
import type {
  ListMintedCredentialsResponse,
  MintCredentialResponse,
  PublicMintedCredential,
  RevokeMintedCredentialResponse,
} from "@saas/contracts/integrations";
import {
  INTEGRATION_ENTITLEMENTS,
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_POLICY_ACTIONS,
  type IntegrationProviderId,
} from "@saas/contracts/integrations";
import {
  createIntegrationHubRepository,
  createIntegrationsRepository,
  type MintedCredential,
} from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { asUuid, type Uuid } from "@saas/db/ids";
import type { FetchLike } from "../github-app.js";
import { resolveUsableConnection } from "../connection-access.js";
import { errorResponse, listResponse, successResponse, validationError } from "../http.js";
import {
  generateUuid,
  mintedCredentialPublicId,
  connectionPublicId,
  orgPublicId,
  parseMintedCredentialPublicId,
} from "../ids.js";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { checkBillingEntitlement } from "../billing-client.js";
import { encodeCursor, parsePageParams } from "../pagination.js";
import { getConfiguredProvider } from "../providers/registry.js";
import { getCapability, type IntegrationProvider } from "../providers/types.js";

/** D5: default 15 min, hard ceiling 1h — no template may exceed it. */
export const DEFAULT_TTL_SECONDS = 15 * 60;
export const MAX_TTL_SECONDS = 60 * 60;

const MAX_PARAM_KEYS = 10;
const TEMPLATE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export interface CredentialBrokerDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
  /** Test seam: bypass the registry with a prebuilt provider adapter. */
  provider?: IntegrationProvider;
}

export function toPublicMintedCredential(mint: MintedCredential): PublicMintedCredential {
  return {
    id: mintedCredentialPublicId(mint.id),
    orgId: orgPublicId(mint.orgId),
    connectionId: connectionPublicId(mint.connectionId),
    provider: mint.provider as IntegrationProviderId,
    template: mint.template,
    params: mint.params,
    purpose: mint.purpose,
    requestedBy: mint.requestedBy,
    runId: mint.runId,
    jobId: mint.jobId,
    ttlSeconds: mint.ttlSeconds,
    mintedAt: mint.mintedAt.toISOString(),
    expiresAt: mint.expiresAt.toISOString(),
    revokedAt: mint.revokedAt ? mint.revokedAt.toISOString() : null,
    revokeStatus: mint.revokeStatus,
  };
}

async function authorize(
  env: Env,
  actor: ActorContext,
  orgId: Uuid,
  action: string,
  requestId: string,
): Promise<boolean> {
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) return false;
  const resource: PolicyResource = { kind: "organization", orgId };
  const decision = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    action,
    resource,
    contextResult.memberships,
    requestId,
  );
  return decision.allow;
}

function resolveProvider(
  env: Env,
  providerId: string,
  deps?: CredentialBrokerDeps,
): IntegrationProvider | null {
  if (deps?.provider) return deps.provider;
  return getConfiguredProvider(env, providerId, deps?.fetchImpl)?.provider ?? null;
}

/** POST …/integrations/{connectionId}/credentials — mint. */
export async function handleMintCredential(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: CredentialBrokerDeps,
): Promise<Response> {
  if (!(await authorize(env, actor, orgId, INTEGRATION_POLICY_ACTIONS.CREDENTIAL_ISSUE, requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const entitlement = await checkBillingEntitlement(
    env.BILLING_WORKER!,
    orgPublicId(orgId),
    INTEGRATION_ENTITLEMENTS.CREDENTIAL_BROKER,
    requestId,
  );
  if (entitlement.kind === "service_error") {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!entitlement.decision.allowed) {
    return errorResponse(
      "precondition_failed",
      "The credential broker is not included in your current plan",
      412,
      requestId,
      {
        reason: entitlement.decision.reason ?? "not_configured",
        entitlementKey: INTEGRATION_ENTITLEMENTS.CREDENTIAL_BROKER,
      },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const templateId = typeof body.template === "string" ? body.template : "";
  if (!TEMPLATE_ID_RE.test(templateId)) {
    return validationError(requestId, { template: ["Required: a template id"] });
  }
  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  if (Object.keys(params).length > MAX_PARAM_KEYS) {
    return validationError(requestId, { params: [`At most ${MAX_PARAM_KEYS} params`] });
  }
  const requestedTtl =
    typeof body.ttlSeconds === "number" && Number.isInteger(body.ttlSeconds) && body.ttlSeconds > 0
      ? body.ttlSeconds
      : DEFAULT_TTL_SECONDS;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const hub = createIntegrationHubRepository(executor);

    // Own or account-shared with admission (IT10) — the IG rule, uniformly.
    const connection = await resolveUsableConnection(env, repo, orgId, connectionId, requestId);
    if (!connection) return errorResponse("not_found", "Not found", 404, requestId);
    if (connection.status !== "active") {
      return errorResponse("precondition_failed", "The connection is not active", 412, requestId, {
        reason: "disabled",
      });
    }

    const provider = resolveProvider(env, connection.provider, deps);
    const broker = provider ? getCapability(provider, "broker") : null;
    if (!broker) {
      // Typed capability miss — a provider without a broker (or an
      // unconfigured environment) is a 4xx, never a 500 (design §2).
      return errorResponse(
        "unsupported",
        "This connection's provider does not mint credentials",
        400,
        requestId,
        { reason: "capability_not_supported" },
      );
    }

    const template = broker.scopeTemplates().find((t) => t.id === templateId);
    if (!template) {
      return validationError(requestId, {
        template: [`Unknown template "${templateId}" for provider ${connection.provider}`],
      });
    }
    const unknownParams = Object.keys(params).filter((k) => !template.params.includes(k));
    if (unknownParams.length > 0) {
      return validationError(requestId, {
        params: [`Unknown params for ${templateId}: ${unknownParams.join(", ")}`],
      });
    }

    // Per-org daily mint rate limit, enforced against the ledger itself.
    const limit = await checkBillingEntitlement(
      env.BILLING_WORKER!,
      orgPublicId(orgId),
      INTEGRATION_ENTITLEMENTS.CREDENTIAL_MINTS_PER_DAY_LIMIT,
      requestId,
    );
    if (limit.kind === "service_error") {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    if (
      limit.decision.allowed &&
      limit.decision.limitValue !== null &&
      limit.decision.limitValue !== undefined
    ) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const count = await hub.countMintedCredentialsSince(orgId, since);
      if (!count.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
      if (count.value >= limit.decision.limitValue) {
        return errorResponse(
          "precondition_failed",
          "Credential mint limit reached for the current plan",
          412,
          requestId,
          {
            reason: "limit_reached",
            entitlementKey: INTEGRATION_ENTITLEMENTS.CREDENTIAL_MINTS_PER_DAY_LIMIT,
            limit: limit.decision.limitValue,
          },
        );
      }
    }

    // TTL requested, clamped (D5): the ledger will record the ACTUAL expiry.
    const ttlSeconds = Math.min(requestedTtl, template.maxTtlSeconds, MAX_TTL_SECONDS);

    const nowMs = Date.now();
    const outcome = await broker.mintCredential({ template: templateId, params, ttlSeconds, nowMs });
    if (!outcome.ok) {
      // Best-effort failure event — surfaced in connection health.
      try {
        const events = createEventsRepository(executor);
        await events.appendEventWithAudit({
          event: {
            id: generateUuid(),
            type: INTEGRATION_EVENT_TYPES.CREDENTIAL_MINT_FAILED,
            version: 1,
            source: "integrations-worker",
            occurredAt: new Date(),
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId,
            subjectKind: "integration_connection",
            subjectId: connection.id,
            requestId,
            payload: { provider: connection.provider, template: templateId, reason: outcome.reason },
          },
          audit: {
            id: generateUuid(),
            category: "integrations",
            description: `Credential mint failed (${templateId}): ${outcome.reason}`,
          },
        });
      } catch {
        // best-effort
      }
      switch (outcome.reason) {
        case "not_implemented":
          return errorResponse(
            "precondition_failed",
            "This provider's credential minting is not live yet",
            412,
            requestId,
            { reason: "not_implemented" },
          );
        case "template_unknown":
          return validationError(requestId, { template: ["Unknown template"] });
        case "parent_grant_insufficient":
          return errorResponse(
            "precondition_failed",
            "The parent credential cannot cover this template",
            412,
            requestId,
            { reason: "parent_grant_insufficient" },
          );
        default:
          return errorResponse("bad_gateway", "The provider refused the mint", 502, requestId, {
            reason: "provider_error",
          });
      }
    }

    // Ledger BEFORE reveal: an unledgered credential must never leave the
    // platform. If the insert fails, best-effort revoke and refuse.
    const mintId = generateUuid();
    const inserted = await hub.insertMintedCredential({
      id: mintId,
      orgId,
      connectionId: asUuid(connection.id),
      provider: connection.provider,
      template: templateId,
      params: Object.keys(params).length > 0 ? params : null,
      purpose: "api",
      requestedBy: actor.subjectId,
      ttlSeconds,
      providerRef: outcome.value.providerRef,
      expiresAt: outcome.value.expiresAt,
    });
    if (!inserted.ok) {
      if (outcome.value.providerRef) {
        await broker.revokeCredential(outcome.value.providerRef, Date.now());
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    try {
      const events = createEventsRepository(executor);
      await events.appendEventWithAudit({
        event: {
          id: generateUuid(),
          type: INTEGRATION_EVENT_TYPES.CREDENTIAL_ISSUED,
          version: 1,
          source: "integrations-worker",
          occurredAt: new Date(),
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          subjectKind: "integration_connection",
          subjectId: connection.id,
          requestId,
          // template/params/ttl/actor/mint id — NEVER the credential.
          payload: {
            provider: connection.provider,
            template: templateId,
            params,
            ttlSeconds,
            mintId: mintedCredentialPublicId(mintId),
            expiresAt: outcome.value.expiresAt.toISOString(),
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `Credential minted: ${connection.provider}/${templateId} (ttl ${ttlSeconds}s)`,
        },
      });
    } catch {
      // Audit emission is best-effort; the mint is already ledgered.
    }

    const payload: MintCredentialResponse = {
      credential: outcome.value.credential,
      mint: toPublicMintedCredential(inserted.value),
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

/** GET …/integrations/{connectionId}/credentials — the mint ledger. */
export async function handleListMintedCredentials(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: CredentialBrokerDeps,
): Promise<Response> {
  if (!(await authorize(env, actor, orgId, INTEGRATION_POLICY_ACTIONS.READ, requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const page = parsePageParams(new URL(request.url));
  if (!page.ok) {
    return errorResponse("validation_failed", "Validation failed", 422, requestId, {
      fields: { [page.field]: [page.reason] },
    });
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const connection = await resolveUsableConnection(env, repo, orgId, connectionId, requestId);
    if (!connection) return errorResponse("not_found", "Not found", 404, requestId);

    const hub = createIntegrationHubRepository(executor);
    const listed = await hub.listMintedCredentials(
      orgId,
      {
        limit: page.value.limit,
        cursor: page.value.cursor
          ? { createdAt: page.value.cursor.createdAt, id: page.value.cursor.id }
          : null,
      },
      { connectionId: asUuid(connection.id) },
    );
    if (!listed.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const payload: ListMintedCredentialsResponse = {
      mints: listed.value.items.map(toPublicMintedCredential),
      nextCursor: null,
    };
    const cursor = listed.value.nextCursor
      ? encodeCursor(listed.value.nextCursor.createdAt, listed.value.nextCursor.id)
      : null;
    return listResponse(payload, requestId, cursor);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}

/** DELETE …/credentials/{mintId} — best-effort revoke; TTL is the backstop. */
export async function handleRevokeMintedCredential(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  mintPublicId: string,
  deps?: CredentialBrokerDeps,
): Promise<Response> {
  if (!(await authorize(env, actor, orgId, INTEGRATION_POLICY_ACTIONS.CREDENTIAL_ISSUE, requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const mintUuid = parseMintedCredentialPublicId(mintPublicId);
  if (!mintUuid) return errorResponse("not_found", "Not found", 404, requestId);

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const hub = createIntegrationHubRepository(executor);
    const mint = await hub.getMintedCredential(orgId, asUuid(mintUuid));
    if (!mint.ok) return errorResponse("not_found", "Not found", 404, requestId);

    if (mint.value.revokeStatus === "revoked") {
      const payload: RevokeMintedCredentialResponse = { revoked: true };
      return successResponse(payload, requestId);
    }

    // Best-effort provider-side revoke; TTL is the backstop when the
    // provider offers none (or the call fails).
    if (mint.value.providerRef) {
      const provider = resolveProvider(env, mint.value.provider, deps);
      const broker = provider ? getCapability(provider, "broker") : null;
      if (broker) {
        await broker.revokeCredential(mint.value.providerRef, Date.now());
      }
    }

    const marked = await hub.markMintedCredential(asUuid(mintUuid), {
      revokeStatus: "revoked",
      revokedAt: new Date(),
    });
    if (!marked.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    try {
      const events = createEventsRepository(executor);
      await events.appendEventWithAudit({
        event: {
          id: generateUuid(),
          type: INTEGRATION_EVENT_TYPES.CREDENTIAL_REVOKED,
          version: 1,
          source: "integrations-worker",
          occurredAt: new Date(),
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          subjectKind: "integration_connection",
          subjectId: mint.value.connectionId,
          requestId,
          payload: {
            provider: mint.value.provider,
            template: mint.value.template,
            mintId: mintedCredentialPublicId(mint.value.id),
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `Minted credential revoked: ${mint.value.provider}/${mint.value.template}`,
        },
      });
    } catch {
      // best-effort
    }

    const payload: RevokeMintedCredentialResponse = { revoked: true };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}

/**
 * Revoke fan-out (design §5.1): when a connection is revoked, sweep its live
 * mints — best-effort provider-side revoke, ledger marked either way. Called
 * from handleRevokeIntegration; failures never block the platform revoke.
 */
export async function revokeLiveMintsForConnection(
  env: Env,
  executor: SqlExecutor,
  connectionUuid: Uuid,
  providerId: string,
  fetchImpl?: FetchLike,
): Promise<number> {
  const hub = createIntegrationHubRepository(executor);
  const live = await hub.listLiveMintedCredentials(connectionUuid);
  if (!live.ok || live.value.length === 0) return 0;

  const provider = getConfiguredProvider(env, providerId, fetchImpl)?.provider ?? null;
  const broker = provider ? getCapability(provider, "broker") : null;
  let swept = 0;
  for (const mint of live.value) {
    if (broker && mint.providerRef) {
      try {
        await broker.revokeCredential(mint.providerRef, Date.now());
      } catch {
        // TTL is the backstop.
      }
    }
    const marked = await hub.markMintedCredential(asUuid(mint.id), {
      revokeStatus: "revoked",
      revokedAt: new Date(),
    });
    if (marked.ok) swept += 1;
  }
  return swept;
}
