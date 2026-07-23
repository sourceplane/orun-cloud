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
  InternalMintCredentialRequest,
  InternalMintCredentialResponse,
  ListMintedCredentialsResponse,
  MintCredentialResponse,
  PublicMintedCredential,
  RevokeMintedCredentialResponse,
  ValidateBrokerBindingResponse,
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
  type IntegrationConnection,
  type MintedCredential,
  type MintPurpose,
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
  parseConnectionPublicId,
  parseMintedCredentialPublicId,
} from "../ids.js";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { checkBillingEntitlement } from "../billing-client.js";
import { encodeCursor, parsePageParams } from "../pagination.js";
import { getConfiguredProvider } from "../providers/registry.js";
import { getCapability, type IntegrationProvider } from "../providers/types.js";
import { resolveCustomTemplate } from "./scope-templates.js";
import {
  readCustodyServedCredential,
  readParentCredential,
  reEnvelopeParentCredential,
  type ResolvedParentCredential,
} from "../custody.js";
import type { ProviderCredentialKind } from "@saas/db/integrations";
import { connectionMintLockRunner, type MintLockRunner } from "../mint-lock.js";
import type { MintCredentialOutcome } from "../providers/types.js";

/** D5: default 15 min, hard ceiling 1h — no template may exceed it. */
export const DEFAULT_TTL_SECONDS = 15 * 60;
export const MAX_TTL_SECONDS = 60 * 60;

/**
 * TTL bounds for `purpose: "rotation"` mints (provider-rotated-secrets RS1).
 * A rotation mint produces a rotated secret's STORED value, so its
 * provider-side lifetime must span the rotation interval plus the grace
 * overlap — not the ≤1h resolve ceiling (a 1h-clamped stored token would die
 * provider-side within the hour of being created). The default covers the
 * RS-D2 defaults (30d interval + 24h grace); the ceiling is a sanity bound —
 * the RS2 engine re-mints on schedule and the provider-side expiry is the
 * orphan backstop (IH9), exactly the sprawl-self-heal posture.
 */
export const ROTATION_DEFAULT_TTL_SECONDS = 31 * 24 * 60 * 60;
export const ROTATION_MAX_TTL_SECONDS = 400 * 24 * 60 * 60;

const MAX_PARAM_KEYS = 10;
const TEMPLATE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export interface CredentialBrokerDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
  /** Test seam: bypass the registry with a prebuilt provider adapter. */
  provider?: IntegrationProvider;
  /** Per-connection mint serialization seam (IH6 custody); production wires
   *  connectionMintLockRunner over the MINT_LOCKS Durable Object namespace. */
  mintLock?: MintLockRunner;
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
    parentKind: mint.parentKind,
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

    // Own or account-shared with admission (IT10) — the IG rule, uniformly.
    const connection = await resolveUsableConnection(env, repo, orgId, connectionId, requestId);
    if (!connection) return errorResponse("not_found", "Not found", 404, requestId);
    if (connection.status !== "active") {
      return errorResponse("precondition_failed", "The connection is not active", 412, requestId, {
        reason: "disabled",
      });
    }

    const core = await executeMintCore(
      env,
      requestId,
      executor,
      orgId,
      connection,
      { templateId, params, requestedTtl },
      {
        purpose: "api",
        requestedBy: actor.subjectId,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
      },
      deps,
    );
    if (!core.ok) {
      return publicMintFailureResponse(core.failure, requestId, templateId, connection.provider);
    }

    const payload: MintCredentialResponse = {
      credential: core.credential,
      mint: toPublicMintedCredential(core.mint),
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

// ── The shared mint core (IH4 public surface + IH7 internal surface) ──

/** Ledger + event attribution for one mint execution. */
interface MintAttribution {
  purpose: MintPurpose;
  /** Ledger requested_by — the subject the mint is FOR (never an authz input). */
  requestedBy: string | null;
  runId?: string | null;
  jobId?: string | null;
  /** Event-log actor. Internal (platform-executed) paths pass the verified
   *  resolve subject when known, else "system"/"config-worker". */
  actorType: string;
  actorId: string;
}

type MintCoreFailure =
  | { kind: "capability_not_supported" }
  | { kind: "template_unknown" }
  | { kind: "params_invalid"; unknownParams: string[] }
  | { kind: "limit_reached"; limit: number }
  | { kind: "parent_credential_missing" }
  | { kind: "mint_failed"; reason: string; detail?: string }
  | { kind: "mint_lock_timeout" }
  | { kind: "service_error" };

type MintCoreResult =
  | { ok: true; credential: Record<string, string>; mint: MintedCredential }
  | { ok: false; failure: MintCoreFailure };

/**
 * Everything between "the connection is usable" and "the credential leaves the
 * platform": capability + template validation, the per-org daily rate limit,
 * TTL clamping, parent custody, the provider mint, rotation re-envelope, and
 * ledger-before-reveal. Both the public handler (purpose "api") and the
 * internal brokered-secret path (purpose "secret_resolve", design §5.4) run
 * THIS code — the custody invariants cannot diverge between surfaces.
 */
async function executeMintCore(
  env: Env,
  requestId: string,
  executor: SqlExecutor,
  // The REQUESTING org — for an account-shared connection this differs from
  // connection.orgId, and the rate limit + ledger row bind to the requester.
  orgId: Uuid,
  connection: IntegrationConnection,
  input: { templateId: string; params: Record<string, unknown>; requestedTtl: number },
  attribution: MintAttribution,
  deps?: CredentialBrokerDeps,
): Promise<MintCoreResult> {
  const { templateId, params, requestedTtl } = input;
  const hub = createIntegrationHubRepository(executor);

  const provider = resolveProvider(env, connection.provider, deps);
  const broker = provider ? getCapability(provider, "broker") : null;
  if (!broker) {
    // Typed capability miss — a provider without a broker (or an
    // unconfigured environment) is a 4xx, never a 500 (design §2).
    return { ok: false, failure: { kind: "capability_not_supported" } };
  }

  // SP4: an id outside the code catalog may be an org-curated custom template
  // — resolve it to its BASE, which supplies every mint semantic (permission
  // grammar, custody, params, TTL ceiling), so a custom can never exceed what
  // its base grants. Any status resolves: soft-retire only hides creation.
  const declared = broker.scopeTemplates();
  const template =
    declared.find((t) => t.id === templateId) ??
    (await resolveCustomTemplate(executor, orgId, connection.provider, templateId, declared));
  if (!template) {
    return { ok: false, failure: { kind: "template_unknown" } };
  }
  const unknownParams = Object.keys(params).filter((k) => !template.params.includes(k));
  if (unknownParams.length > 0) {
    return { ok: false, failure: { kind: "params_invalid", unknownParams } };
  }

  // Per-org daily mint rate limit, enforced against the ledger itself.
  const limit = await checkBillingEntitlement(
    env.BILLING_WORKER!,
    orgPublicId(orgId),
    INTEGRATION_ENTITLEMENTS.CREDENTIAL_MINTS_PER_DAY_LIMIT,
    requestId,
  );
  if (limit.kind === "service_error") {
    return { ok: false, failure: { kind: "service_error" } };
  }
  if (
    limit.decision.allowed &&
    limit.decision.limitValue !== null &&
    limit.decision.limitValue !== undefined
  ) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await hub.countMintedCredentialsSince(orgId, since);
    if (!count.ok) return { ok: false, failure: { kind: "service_error" } };
    if (count.value >= limit.decision.limitValue) {
      return { ok: false, failure: { kind: "limit_reached", limit: limit.decision.limitValue } };
    }
  }

  // TTL requested, clamped (D5): the ledger will record the ACTUAL expiry.
  // Rotation mints (RS1) clamp against the rotation-class ceiling instead of
  // the resolve ceiling — the token must outlive the rotation interval; the
  // template's resolve max encodes short-lived-issue semantics that do not
  // apply to a stored, engine-rotated value.
  const ttlSeconds =
    attribution.purpose === "rotation"
      ? Math.min(requestedTtl, ROTATION_MAX_TTL_SECONDS)
      : Math.min(requestedTtl, template.maxTtlSeconds, MAX_TTL_SECONDS);

  // The mint id is generated BEFORE the provider call so the minted
  // credential carries its ledger identity provider-side (IH9 reconcile).
  const mintId = generateUuid();
  const nowMs = Date.now();

  // ── Custody-served templates (SI4) ──────────────────────────
  // The value is an org-owned infrastructure credential captured at connect
  // (e.g. a Supabase project service key) — read it from custody instead of
  // minting against the provider. No provider call, no parent-token spend,
  // no mint lock (the read is static); everything else (rate limit above,
  // ledger-before-reveal, events below the section) is identical.
  if (template.custodyKind) {
    const selector =
      typeof params.projectRef === "string" && params.projectRef ? params.projectRef : undefined;
    if (template.params.includes("projectRef") && !selector) {
      return { ok: false, failure: { kind: "mint_failed", reason: `${templateId} requires projectRef` } };
    }
    const served = await readCustodyServedCredential(
      env,
      executor,
      asUuid(connection.id),
      template.custodyKind as ProviderCredentialKind,
      selector,
    );
    if (!served.ok) {
      return served.reason === "custody_missing"
        ? { ok: false, failure: { kind: "parent_credential_missing" } }
        : // The connection is live but custody has no entry for this project —
          // the reconcile cron hasn't captured it (or the project is gone).
          { ok: false, failure: { kind: "mint_failed", reason: "parent_grant_insufficient" } };
    }
    const inserted = await hub.insertMintedCredential({
      id: mintId,
      orgId,
      connectionId: asUuid(connection.id),
      provider: connection.provider,
      template: templateId,
      params: Object.keys(params).length > 0 ? params : null,
      purpose: attribution.purpose,
      parentKind: template.custodyKind as ProviderCredentialKind,
      requestedBy: attribution.requestedBy,
      runId: attribution.runId ?? null,
      jobId: attribution.jobId ?? null,
      ttlSeconds,
      providerRef: null,
      expiresAt: new Date(nowMs + ttlSeconds * 1000),
    });
    if (!inserted.ok) {
      return { ok: false, failure: { kind: "service_error" } };
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
          actorType: attribution.actorType,
          actorId: attribution.actorId,
          orgId,
          subjectKind: "integration_connection",
          subjectId: connection.id,
          requestId,
          payload: {
            provider: connection.provider,
            template: templateId,
            params,
            ttlSeconds,
            mintId: mintedCredentialPublicId(mintId),
            expiresAt: inserted.value.expiresAt.toISOString(),
            purpose: attribution.purpose,
            ...(attribution.runId ? { runId: attribution.runId } : {}),
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `Credential minted: ${connection.provider}/${templateId} (custody-served)`,
        },
      });
    } catch {
      // Audit emission is best-effort; the mint is already ledgered.
    }
    return { ok: true, credential: { value: served.value }, mint: inserted.value };
  }

  // ── Custody critical section, serialized PER CONNECTION (IH6). ──
  // read-parent → provider mint → rotation re-envelope is a read-modify-write
  // on custody: on rotating-parent providers a concurrent mint that reads the
  // same parent presents an already-consumed refresh token, which trips the
  // provider's reuse detection (family revocation — sibling tokens die
  // mid-flight). Only this window holds the lock; validation, rate limits,
  // the ledger, and events stay outside, so the hold is ~one provider call.
  const runLocked: MintLockRunner = deps?.mintLock ?? connectionMintLockRunner(env.MINT_LOCKS);
  type CustodySection =
    | { parent: ResolvedParentCredential | undefined; outcome: MintCredentialOutcome }
    | { failure: MintCoreFailure };
  const section = await runLocked(String(connection.id), async (): Promise<CustodySection> => {
    // Parent custody (IH5+): decrypted for this one call, never held.
    const parent = await readParentCredential(env, executor, asUuid(connection.id), connection.provider);
    if (parent === null) {
      return { failure: { kind: "parent_credential_missing" } };
    }
    const outcome = await broker.mintCredential({
      template: templateId,
      params,
      ttlSeconds,
      nowMs,
      ...(parent ? { parent } : {}),
      mintRef: `orun/${orgPublicId(orgId)}/${templateId}/${mintedCredentialPublicId(mintId)}`,
    });

    // Rotating parents (IH6 Supabase, IH5 Cloudflare OAuth): the mint consumed
    // the parent and the provider handed back a NEW one — re-envelope custody
    // INSIDE the lock (and before the ledger insert) so the rotation lands
    // before any sibling's read. Best-effort: a re-envelope failure logs
    // nothing sensitive and does NOT fail the mint; a lost rotation surfaces
    // as parent_grant_insufficient on the NEXT mint — an IH9 health concern,
    // not a data-loss one.
    if (outcome.ok && outcome.value.rotatedParentCredential && parent?.kind) {
      await reEnvelopeParentCredential(
        env,
        executor,
        asUuid(connection.id),
        parent.kind,
        outcome.value.rotatedParentCredential,
        // Keep the custody row anchored to the same provider-side ref.
        parent.externalRef,
      );
    }
    return { parent, outcome };
  });
  if (!section.ok) {
    // Wait budget exhausted under contention — typed and retryable; the
    // resolve surface names it via brokerReason.
    return { ok: false, failure: { kind: "mint_lock_timeout" } };
  }
  if ("failure" in section.value) {
    return { ok: false, failure: section.value.failure };
  }
  const { parent, outcome } = section.value;
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
          actorType: attribution.actorType,
          actorId: attribution.actorId,
          orgId,
          subjectKind: "integration_connection",
          subjectId: connection.id,
          requestId,
          // `detail` is operator telemetry (org event log): which live provider
          // call failed and its HTTP status / truncated provider message — e.g.
          // "permission_groups http_401", "mint http_404". No secret, no token.
          // It pins the generic `provider_error` to a specific cause. NOT echoed
          // into the tenant/CI resolve error, which stays typed-slug only.
          payload: {
            provider: connection.provider,
            template: templateId,
            reason: outcome.reason,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `Credential mint failed (${templateId}): ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}`,
        },
      });
    } catch {
      // best-effort
    }
    return {
      ok: false,
      failure: { kind: "mint_failed", reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) },
    };
  }

  // (The rotation re-envelope happened INSIDE the custody lock above.)

  // Ledger BEFORE reveal: an unledgered credential must never leave the
  // platform. If the insert fails, best-effort revoke and refuse.
  const inserted = await hub.insertMintedCredential({
    id: mintId,
    orgId,
    connectionId: asUuid(connection.id),
    provider: connection.provider,
    template: templateId,
    params: Object.keys(params).length > 0 ? params : null,
    purpose: attribution.purpose,
    // SI1: record which custody kind authorized the mint — user-derived
    // parent kinds here are the SI3/SI5 deprecation metric.
    parentKind: parent?.kind ?? null,
    requestedBy: attribution.requestedBy,
    runId: attribution.runId ?? null,
    jobId: attribution.jobId ?? null,
    ttlSeconds,
    providerRef: outcome.value.providerRef,
    expiresAt: outcome.value.expiresAt,
  });
  if (!inserted.ok) {
    if (outcome.value.providerRef) {
      await broker.revokeCredential(outcome.value.providerRef, Date.now(), parent);
    }
    return { ok: false, failure: { kind: "service_error" } };
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
        actorType: attribution.actorType,
        actorId: attribution.actorId,
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
          purpose: attribution.purpose,
          ...(attribution.runId ? { runId: attribution.runId } : {}),
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

  return { ok: true, credential: outcome.value.credential, mint: inserted.value };
}

/** Map a core failure onto the PUBLIC surface's shipped error shapes (IH4). */
function publicMintFailureResponse(
  failure: MintCoreFailure,
  requestId: string,
  templateId: string,
  providerId: string,
): Response {
  switch (failure.kind) {
    case "capability_not_supported":
      return errorResponse(
        "unsupported",
        "This connection's provider does not mint credentials",
        400,
        requestId,
        { reason: "capability_not_supported" },
      );
    case "template_unknown":
      return validationError(requestId, {
        template: [`Unknown template "${templateId}" for provider ${providerId}`],
      });
    case "params_invalid":
      return validationError(requestId, {
        params: [`Unknown params for ${templateId}: ${failure.unknownParams.join(", ")}`],
      });
    case "limit_reached":
      return errorResponse(
        "precondition_failed",
        "Credential mint limit reached for the current plan",
        412,
        requestId,
        {
          reason: "limit_reached",
          entitlementKey: INTEGRATION_ENTITLEMENTS.CREDENTIAL_MINTS_PER_DAY_LIMIT,
          limit: failure.limit,
        },
      );
    case "parent_credential_missing":
      return errorResponse(
        "precondition_failed",
        "The connection's parent credential is unavailable",
        412,
        requestId,
        { reason: "parent_credential_missing" },
      );
    case "mint_failed":
      switch (failure.reason) {
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
    case "mint_lock_timeout":
      // Contention on this connection's custody lock — bounded queueing, not
      // an outage. 503 signals retryable; the reason names the cause.
      return errorResponse(
        "unavailable",
        "Too many concurrent credential mints for this connection — retry shortly",
        503,
        requestId,
        { reason: "mint_lock_timeout" },
      );
    case "service_error":
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

/** Map a core failure onto the INTERNAL surface's machine-readable envelope
 *  (IH7): every failure carries `details.reason` so config-worker can map it
 *  to its typed `binding_unavailable` without parsing messages. */
function internalMintFailureResponse(failure: MintCoreFailure, requestId: string): Response {
  switch (failure.kind) {
    case "capability_not_supported":
      return errorResponse("unsupported", "This connection's provider does not mint credentials", 400, requestId, {
        reason: "capability_not_supported",
      });
    case "template_unknown":
      return errorResponse("validation_failed", "Unknown template", 422, requestId, {
        reason: "template_unknown",
      });
    case "params_invalid":
      return errorResponse("validation_failed", "Unknown template params", 422, requestId, {
        reason: "params_invalid",
        params: failure.unknownParams,
      });
    case "limit_reached":
      return errorResponse("precondition_failed", "Credential mint limit reached", 412, requestId, {
        reason: "limit_reached",
        entitlementKey: INTEGRATION_ENTITLEMENTS.CREDENTIAL_MINTS_PER_DAY_LIMIT,
        limit: failure.limit,
      });
    case "parent_credential_missing":
      return errorResponse("precondition_failed", "The connection's parent credential is unavailable", 412, requestId, {
        reason: "parent_credential_missing",
      });
    case "mint_failed":
      switch (failure.reason) {
        case "not_implemented":
          return errorResponse("precondition_failed", "Minting is not live for this provider", 412, requestId, {
            reason: "not_implemented",
          });
        case "template_unknown":
          return errorResponse("validation_failed", "Unknown template", 422, requestId, {
            reason: "template_unknown",
          });
        case "parent_grant_insufficient":
          return errorResponse("precondition_failed", "The parent credential cannot cover this template", 412, requestId, {
            reason: "parent_grant_insufficient",
          });
        default:
          return errorResponse("bad_gateway", "The provider refused the mint", 502, requestId, {
            reason: "provider_error",
          });
      }
    case "mint_lock_timeout":
      return errorResponse("unavailable", "Concurrent mint contention on this connection", 503, requestId, {
        reason: "mint_lock_timeout",
      });
    case "service_error":
      return errorResponse("internal_error", "Service unavailable", 503, requestId, {
        reason: "unavailable",
      });
  }
}

// ── Internal brokered-secret surface (IH7, design §5.4) ─────
//
// Both routes are service-binding-only (router: x-internal-caller
// "config-worker") — there is NO bearer/user policy here BY DESIGN: the dual
// policy already ran where it belongs. At BIND time config-worker enforced
// `secret.write` AND `organization.integration.credential.issue` ("you cannot
// bind authority you could not mint"); at RESOLVE time state-worker enforced
// bearer authz + a live job lease and config-worker enforced Layer-2 secret
// policy. The broker still enforces everything that is ITS OWN: entitlement,
// the per-org daily rate limit, template validation, custody, and
// ledger-before-reveal — via the same executeMintCore as the public surface.

const INTERNAL_CONNECTION_ID_RE = /^int_[0-9a-f]{32}$/;

interface ParsedInternalBinding {
  orgId: Uuid;
  connectionUuid: Uuid;
  templateId: string;
  params: Record<string, unknown>;
}

function parseInternalBindingBody(body: Record<string, unknown>): ParsedInternalBinding | string {
  const rawOrg = typeof body.orgId === "string" ? body.orgId : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rawOrg)) {
    return "orgId must be a raw org UUID";
  }
  const rawConnection = typeof body.connectionId === "string" ? body.connectionId : "";
  if (!INTERNAL_CONNECTION_ID_RE.test(rawConnection)) {
    return "connectionId must be a public connection id (int_…)";
  }
  const connectionUuid = parseConnectionPublicId(rawConnection);
  if (!connectionUuid) return "connectionId must be a public connection id (int_…)";
  const templateId = typeof body.template === "string" ? body.template : "";
  if (!TEMPLATE_ID_RE.test(templateId)) return "template must be a template id";
  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  if (Object.keys(params).length > MAX_PARAM_KEYS) {
    return `params may carry at most ${MAX_PARAM_KEYS} keys`;
  }
  return { orgId: asUuid(rawOrg), connectionUuid: asUuid(connectionUuid), templateId, params };
}

/**
 * POST /internal/credentials/validate-binding — config-worker validates a
 * brokered binding at secret-CREATE time and learns the provider for chain
 * provenance. Read-only: no mint, no ledger row, no entitlement spend.
 */
export async function handleValidateBrokerBinding(
  request: Request,
  env: Env,
  requestId: string,
  deps?: CredentialBrokerDeps,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const parsed = parseInternalBindingBody(body);
  if (typeof parsed === "string") {
    return errorResponse("validation_failed", parsed, 422, requestId, { reason: "params_invalid" });
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const connection = await resolveUsableConnection(env, repo, parsed.orgId, parsed.connectionUuid, requestId);
    if (!connection) {
      return errorResponse("not_found", "Not found", 404, requestId, { reason: "connection_not_found" });
    }
    if (connection.status !== "active") {
      return errorResponse("precondition_failed", "The connection is not active", 412, requestId, {
        reason: "connection_inactive",
      });
    }

    const provider = resolveProvider(env, connection.provider, deps);
    const broker = provider ? getCapability(provider, "broker") : null;
    if (!broker) {
      return errorResponse("unsupported", "This connection's provider does not mint credentials", 400, requestId, {
        reason: "capability_not_supported",
      });
    }
    const template = broker.scopeTemplates().find((t) => t.id === parsed.templateId);
    if (!template) {
      return errorResponse("validation_failed", "Unknown template", 422, requestId, {
        reason: "template_unknown",
      });
    }
    const unknownParams = Object.keys(parsed.params).filter((k) => !template.params.includes(k));
    if (unknownParams.length > 0) {
      return errorResponse("validation_failed", "Unknown template params", 422, requestId, {
        reason: "params_invalid",
        params: unknownParams,
      });
    }

    const payload: ValidateBrokerBindingResponse = {
      provider: connection.provider as ValidateBrokerBindingResponse["provider"],
      maxTtlSeconds: Math.min(template.maxTtlSeconds, MAX_TTL_SECONDS),
      // SP0b: the mode-eligibility the create gate enforces, from the provider's
      // declared secrets capability (empty when the provider declares none).
      supportedModes: provider?.secrets?.supportedModes ?? [],
    };
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
 * POST /internal/credentials/mint — the brokered-secret mint (design §5.4).
 * The minted material must be a SINGLE opaque value: it is injected into the
 * resolve response's `secrets{}` map as-is, indistinguishable from a stored
 * value to the runner.
 */
export async function handleInternalMintCredential(
  request: Request,
  env: Env,
  requestId: string,
  deps?: CredentialBrokerDeps,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  // Two internal purposes ride this route (contracts): "secret_resolve" (the
  // IH7 lease-bound brokered resolve) and "rotation" (a provider-rotated
  // secret's stored value being produced — RS1 create-from-parent / RS2
  // engine). Anything else is rejected; the public "api" purpose never
  // reaches this internal handler.
  if (body.purpose !== "secret_resolve" && body.purpose !== "rotation") {
    return errorResponse("validation_failed", 'purpose must be "secret_resolve" or "rotation"', 422, requestId, {
      reason: "params_invalid",
    });
  }
  const internalPurpose: "secret_resolve" | "rotation" = body.purpose;
  // Rotation mints default to the rotation-class TTL (interval + grace), not
  // the 15-minute resolve default — see ROTATION_DEFAULT_TTL_SECONDS.
  const defaultTtl = internalPurpose === "rotation" ? ROTATION_DEFAULT_TTL_SECONDS : DEFAULT_TTL_SECONDS;
  const parsed = parseInternalBindingBody(body);
  if (typeof parsed === "string") {
    return errorResponse("validation_failed", parsed, 422, requestId, { reason: "params_invalid" });
  }
  const req = body as unknown as InternalMintCredentialRequest;
  const requestedTtl =
    typeof body.ttlSeconds === "number" && Number.isInteger(body.ttlSeconds) && body.ttlSeconds > 0
      ? body.ttlSeconds
      : defaultTtl;

  const entitlement = await checkBillingEntitlement(
    env.BILLING_WORKER!,
    orgPublicId(parsed.orgId),
    INTEGRATION_ENTITLEMENTS.CREDENTIAL_BROKER,
    requestId,
  );
  if (entitlement.kind === "service_error") {
    return errorResponse("internal_error", "Service unavailable", 503, requestId, { reason: "unavailable" });
  }
  if (!entitlement.decision.allowed) {
    return errorResponse("precondition_failed", "The credential broker is not included in the plan", 412, requestId, {
      reason: entitlement.decision.reason ?? "not_configured",
      entitlementKey: INTEGRATION_ENTITLEMENTS.CREDENTIAL_BROKER,
    });
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const connection = await resolveUsableConnection(env, repo, parsed.orgId, parsed.connectionUuid, requestId);
    if (!connection) {
      return errorResponse("not_found", "Not found", 404, requestId, { reason: "connection_not_found" });
    }
    if (connection.status !== "active") {
      // The design's fail-closed rung: a revoked/suspended connection makes
      // dependent keys resolve to a typed binding_unavailable upstream.
      return errorResponse("precondition_failed", "The connection is not active", 412, requestId, {
        reason: "connection_inactive",
      });
    }

    const core = await executeMintCore(
      env,
      requestId,
      executor,
      parsed.orgId,
      connection,
      { templateId: parsed.templateId, params: parsed.params, requestedTtl },
      {
        purpose: internalPurpose,
        requestedBy: typeof req.requestedBy === "string" ? req.requestedBy : null,
        runId: typeof req.runId === "string" ? req.runId : null,
        jobId: typeof req.jobId === "string" ? req.jobId : null,
        actorType: typeof req.requestedByType === "string" ? req.requestedByType : "system",
        actorId: typeof req.requestedBy === "string" ? req.requestedBy : "config-worker",
      },
      deps,
    );
    if (!core.ok) {
      return internalMintFailureResponse(core.failure, requestId);
    }

    // Exactly ONE opaque value may cross (both live brokers mint a single
    // token). More/less is a provider-contract violation — revoke the orphan
    // and refuse rather than guess which entry is the secret.
    const values = Object.values(core.credential);
    if (values.length !== 1 || typeof values[0] !== "string") {
      const provider = resolveProvider(env, connection.provider, deps);
      const broker = provider ? getCapability(provider, "broker") : null;
      if (broker && core.mint.providerRef) {
        try {
          const parent = await readParentCredential(env, executor, asUuid(connection.id), connection.provider);
          await broker.revokeCredential(core.mint.providerRef, Date.now(), parent ?? undefined);
        } catch {
          // TTL is the backstop.
        }
      }
      await createIntegrationHubRepository(executor).markMintedCredential(asUuid(core.mint.id), {
        revokeStatus: "orphaned",
        revokedAt: new Date(),
      });
      return errorResponse("bad_gateway", "The provider returned an unusable credential shape", 502, requestId, {
        reason: "provider_error",
      });
    }

    const payload: InternalMintCredentialResponse = {
      value: values[0],
      mint: toPublicMintedCredential(core.mint),
    };
    return successResponse(payload, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId, { reason: "unavailable" });
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
        const parent = await readParentCredential(
          env,
          executor,
          asUuid(mint.value.connectionId),
          mint.value.provider,
        );
        await broker.revokeCredential(mint.value.providerRef, Date.now(), parent ?? undefined);
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
  // The sweep runs BEFORE custody zeroize in the revoke flow, so the parent
  // is still readable for provider-side child revocation.
  const parent = broker
    ? await readParentCredential(env, executor, connectionUuid, providerId)
    : undefined;
  let swept = 0;
  for (const mint of live.value) {
    if (broker && mint.providerRef) {
      try {
        await broker.revokeCredential(mint.providerRef, Date.now(), parent ?? undefined);
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
