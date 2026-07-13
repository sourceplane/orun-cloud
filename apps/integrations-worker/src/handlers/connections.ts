import type { Env } from "../env.js";
import type { FetchLike } from "../github-app.js";
import type { ActorContext } from "../router.js";
import type { PolicyResource } from "@saas/contracts/policy";
import type {
  ConnectIntegrationResponse,
  GetIntegrationResponse,
  ListIntegrationsResponse,
  PublicConnection,
  RevokeIntegrationResponse,
} from "@saas/contracts/integrations";
import {
  INTEGRATION_ENTITLEMENTS,
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_POLICY_ACTIONS,
} from "@saas/contracts/integrations";
import { createIntegrationHubRepository, createIntegrationsRepository } from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext, resolveIntegrationParent } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { checkBillingEntitlement } from "../billing-client.js";
import { errorResponse, listResponse, successResponse } from "../http.js";
import {
  toInheritedPublicConnection,
  toPublicConnection,
  toPublicConnectionWithSelection,
} from "../mappers.js";
import { generateUuid, orgPublicId, parseOrgPublicId } from "../ids.js";
import { asUuid, uuidFromPublicId } from "@saas/db/ids";
import { encodeCursor, parsePageParams } from "../pagination.js";
import { getConfiguredProvider } from "../providers/registry.js";
import { createEncryptionAdapter, type CiphertextEnvelope } from "../encryption.js";
import { revokeLiveMintsForConnection } from "./credential-broker.js";
import { handleCloudflareTokenConnect } from "./cloudflare-connect.js";
import { computeCodeChallenge, generateCodeVerifier } from "../pkce.js";
import {
  CONNECT_STATE_TTL_MS,
  generateStateNonce,
  hashStateNonce,
  signConnectState,
} from "../state.js";

function providerDisplayName(provider: string): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "slack":
      return "Slack";
    case "cloudflare":
      return "Cloudflare";
    case "supabase":
      return "Supabase";
    default:
      return provider;
  }
}

/** Test seam: inject a fake executor / provider fetch; production omits it. */
export interface HandlerDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

function resolveExecutor(env: Env, deps?: HandlerDeps): { executor: SqlExecutor; owned: boolean } {
  if (deps?.executor) return { executor: deps.executor, owned: false };
  return { executor: createSqlExecutor(env.PLATFORM_DB!), owned: true };
}

async function disposeIfOwned(executor: SqlExecutor, owned: boolean): Promise<void> {
  if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

// ── Authorization helper ─────────────────────────────────────

async function authorizeIntegration(
  env: Env,
  actor: ActorContext,
  orgId: string,
  action: string,
  requestId: string,
): Promise<Response | null> {
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const resource: PolicyResource = { kind: "organization", orgId };
  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    action,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  return null;
}

// ── Connect ─────────────────────────────────────────────────

/** Per-provider connect wiring: entitlement key, D1 gate naming, and — for
 *  oauth-kind providers — the ingress path their redirect_uri points at. */
const CONNECT_PROVIDERS = {
  github: {
    displayName: "GitHub",
    entitlementKey: INTEGRATION_ENTITLEMENTS.GITHUB,
    planMessage: "GitHub integration is not included in your current plan",
    notConfiguredMessage: "The GitHub App for this environment is not configured yet",
    gate: "github_app_registration",
    oauthCallbackPath: null,
  },
  slack: {
    displayName: "Slack",
    entitlementKey: INTEGRATION_ENTITLEMENTS.SLACK,
    planMessage: "Slack integration is not included in your current plan",
    notConfiguredMessage: "The Slack App for this environment is not configured yet",
    gate: "slack_app_registration",
    oauthCallbackPath: "/ingress/slack/oauth",
  },
  cloudflare: {
    displayName: "Cloudflare",
    entitlementKey: INTEGRATION_ENTITLEMENTS.CLOUDFLARE,
    planMessage: "Cloudflare integration is not included in your current plan",
    notConfiguredMessage: "Credential custody is not configured for this environment",
    gate: "cloudflare_custody",
    // Used only when an OAuth client is registered (connectKind "oauth", risks
    // D3); the token-paste posture ignores it and returns an active connection
    // in-request without any callback.
    oauthCallbackPath: "/ingress/cloudflare/oauth",
  },
  supabase: {
    displayName: "Supabase",
    entitlementKey: INTEGRATION_ENTITLEMENTS.SUPABASE,
    planMessage: "Supabase integration is not included in your current plan",
    notConfiguredMessage: "The Supabase OAuth app for this environment is not configured yet",
    gate: "supabase_oauth_registration",
    oauthCallbackPath: "/ingress/supabase/oauth",
  },
} as const;

export type ConnectableProviderId = keyof typeof CONNECT_PROVIDERS;

export function isConnectableProvider(value: string): value is ConnectableProviderId {
  return value in CONNECT_PROVIDERS;
}

/** OAuth-kind providers that carry a server-side PKCE verifier between the
 *  authorize redirect and the callback, and the custody kind it rides under
 *  (Slack is oauth but PKCE-less, so it is absent). Cloudflare only reaches
 *  this map when it is OAuth-kind — the token-paste posture returns earlier. */
const PKCE_VERIFIER_KIND: Partial<
  Record<ConnectableProviderId, "supabase_pkce_verifier" | "cloudflare_pkce_verifier">
> = {
  supabase: "supabase_pkce_verifier",
  cloudflare: "cloudflare_pkce_verifier",
};

export async function handleConnectIntegration(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  providerId: ConnectableProviderId,
  deps?: HandlerDeps,
): Promise<Response> {
  const wiring = CONNECT_PROVIDERS[providerId];

  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.CONNECT,
    requestId,
  );
  if (denied) return denied;

  // Entitlement gate (fails closed on service error).
  const entitlement = await checkBillingEntitlement(
    env.BILLING_WORKER!,
    orgPublicId(orgId),
    wiring.entitlementKey,
    requestId,
  );
  if (entitlement.kind === "service_error") {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!entitlement.decision.allowed) {
    const reason = entitlement.decision.reason ?? "not_configured";
    return errorResponse("precondition_failed", wiring.planMessage, 412, requestId, {
      reason,
      entitlementKey: wiring.entitlementKey,
    });
  }

  // D1 gate: live connect parks until the environment's provider app exists.
  // An oauth-kind provider additionally needs the public redirect origin
  // (OAUTH_REDIRECT_BASE_URL) its redirect_uri is built from.
  const configured = getConfiguredProvider(env, providerId);
  const provider = configured?.provider;
  const canConnect =
    provider &&
    (provider.connectKind === "token" ||
      provider.buildInstallUrl ||
      (provider.buildAuthorizeUrl && wiring.oauthCallbackPath && env.OAUTH_REDIRECT_BASE_URL));
  if (!provider || !canConnect || !env.INTEGRATIONS_STATE_SECRET) {
    return errorResponse("precondition_failed", wiring.notConfiguredMessage, 412, requestId, {
      reason: "not_configured",
      gate: wiring.gate,
    });
  }

  let displayName: string | null = null;
  // IT7: the connect surface chooses ownership scope — an account Integrations
  // page connects 'account' (shared, the default); a workspace Integrations page
  // connects 'workspace' (private to this org, never resolved up). Default to
  // 'account' for back-compat when the field is absent.
  let scope: "account" | "workspace" = "account";
  // Token-kind connect (IH5 Cloudflare): the pasted parent credential.
  // Write-only from the moment it is read — never echoed, never logged.
  let parentToken: unknown;
  if (request.headers.get("content-length") !== "0" && request.body) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      if (typeof body.displayName === "string" && body.displayName.trim()) {
        displayName = body.displayName.trim().slice(0, 200);
      }
      if (body.scope === "workspace") {
        scope = "workspace";
      }
      parentToken = body.parentToken;
    } catch {
      // Empty/absent body is fine — displayName + scope are optional.
    }
  }

  // IT11: sharing is account-only. Only an **Account root** may own a shareable
  // (`account`-scoped) connection; a **child** workspace is forced to
  // `workspace` (private) regardless of the requested scope — a child can never
  // share. This hardens IT7's surface rule into a server check. (Managing an
  // account connection's share_mode/grants stays gated by the account-scoped
  // MANAGE authorization, which WID6 already cascades to account admins.)
  if (scope === "account" && env.MEMBERSHIP_WORKER) {
    const parent = await resolveIntegrationParent(
      env.MEMBERSHIP_WORKER,
      orgPublicId(orgId),
      requestId,
    );
    if (parent.ok && parent.isChild) {
      scope = "workspace";
    }
  }

  // Token-kind connect (IH5): no state round-trip, no popup — verify the
  // paste, store custody, activate, all in this request.
  if (provider.connectKind === "token") {
    return handleCloudflareTokenConnect(
      env,
      requestId,
      actor,
      orgId,
      { parentToken, displayName, scope },
      deps,
    );
  }

  // PKCE (IH6 Supabase, IH5 Cloudflare OAuth): the verifier must live
  // server-side in custody between the authorize redirect and the callback, so
  // custody (the envelope key) is a hard gate — checked BEFORE the pending
  // connection is created. Only reached for the PKCE providers; a token-paste
  // Cloudflare returned above, and Slack (oauth, PKCE-less) is absent from the
  // map.
  const pkceKind = PKCE_VERIFIER_KIND[providerId];
  let pkce: {
    verifier: string;
    challenge: string;
    encryption: NonNullable<Awaited<ReturnType<typeof createEncryptionAdapter>>>;
  } | null = null;
  if (pkceKind) {
    const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
    if (!encryption) {
      return errorResponse("precondition_failed", wiring.notConfiguredMessage, 412, requestId, {
        reason: "not_configured",
        gate: wiring.gate,
      });
    }
    const verifier = generateCodeVerifier();
    pkce = { verifier, challenge: await computeCodeChallenge(verifier), encryption };
  }

  // created_by stores the decoded actor UUID (repo-wide convention enforced
  // by lint); the public form is re-derivable for display.
  const createdByUuid = uuidFromPublicId(actor.subjectId);

  const connectionId = generateUuid();
  const nonce = generateStateNonce();
  const nonceHash = await hashStateNonce(nonce);
  const now = Date.now();
  const expiresAt = new Date(now + CONNECT_STATE_TTL_MS);

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    const created = await repo.createConnection({
      id: connectionId,
      orgId,
      provider: providerId,
      scope,
      displayName,
      createdBy: createdByUuid,
      stateNonceHash: nonceHash,
      stateExpiresAt: expiresAt,
    });
    if (!created.ok) {
      if (created.error.kind === "conflict") {
        return errorResponse("conflict", "A connection for this account already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    // PKCE custody (IH6): the verifier rides the custody table as its own
    // kind, bound to the just-created pending connection; the callback reads
    // it once, deletes it, and hands it to the code exchange.
    if (pkce && pkceKind) {
      const hub = createIntegrationHubRepository(executor);
      const envelope = await pkce.encryption.encrypt(pkce.verifier);
      const stored = await hub.upsertProviderCredential({
        id: generateUuid(),
        connectionId: asUuid(connectionId),
        kind: pkceKind,
        ciphertext: JSON.stringify(envelope),
      });
      if (!stored.ok) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
    }

    const state = await signConnectState(
      { n: nonce, p: providerId, c: connectionId, o: orgId, exp: now + CONNECT_STATE_TTL_MS },
      env.INTEGRATIONS_STATE_SECRET,
    );
    const installUrl = provider.buildInstallUrl
      ? provider.buildInstallUrl({ state })
      : provider.buildAuthorizeUrl!({
          state,
          redirectUri: `${env.OAUTH_REDIRECT_BASE_URL!.replace(/\/+$/, "")}${wiring.oauthCallbackPath}`,
          ...(pkce ? { codeChallenge: pkce.challenge } : {}),
        });

    const payload: ConnectIntegrationResponse = {
      connection: toPublicConnection(created.value),
      installUrl,
    };
    return successResponse(payload, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}

// ── List / Get ──────────────────────────────────────────────

export async function handleListIntegrations(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandlerDeps,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.READ,
    requestId,
  );
  if (denied) return denied;

  const page = parsePageParams(new URL(request.url));
  if (!page.ok) {
    return errorResponse("validation_failed", "Validation failed", 422, requestId, {
      fields: { [page.field]: [page.reason] },
    });
  }

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    const result = await repo.listConnections(orgId, {
      limit: page.value.limit,
      cursor: page.value.cursor
        ? { createdAt: page.value.cursor.createdAt, id: page.value.cursor.id }
        : null,
    });
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const connections: PublicConnection[] = result.value.items.map(toPublicConnection);

    // IT10: on the first page, a child workspace also sees its Account's shared
    // (`account`-scoped) connections, READ-ONLY and attributed. Fail-soft — any
    // resolution error just omits the inherited rows. Under `granted` share mode
    // a connection is shown only if this workspace holds an active grant (D7).
    if (!page.value.cursor && env.MEMBERSHIP_WORKER) {
      const parent = await resolveIntegrationParent(
        env.MEMBERSHIP_WORKER,
        orgPublicId(orgId),
        requestId,
      );
      if (parent.ok && parent.isChild && parent.account) {
        const accountUuid = parseOrgPublicId(parent.account.orgId);
        if (accountUuid) {
          const shared = await repo.listActiveAccountScopedConnections(asUuid(accountUuid));
          if (shared.ok) {
            const account = parent.account;
            for (const conn of shared.value) {
              if (conn.shareMode === "granted") {
                const admitted = await repo.isWorkspaceAdmitted(asUuid(conn.id), orgId);
                if (!admitted.ok || !admitted.value) continue;
              }
              connections.push(toInheritedPublicConnection(conn, account));
            }
          }
        }
      }
    }

    const payload: ListIntegrationsResponse = {
      connections,
      nextCursor: result.value.nextCursor,
    };
    const cursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;
    return listResponse(payload, requestId, cursor);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}

export async function handleGetIntegration(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: HandlerDeps,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.READ,
    requestId,
  );
  if (denied) return denied;

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    const result = await repo.getConnection(orgId, connectionId);
    if (!result.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    let repositorySelection: string | null = null;
    const installation = await repo.getGithubInstallationByConnectionId(connectionId);
    if (installation.ok) {
      repositorySelection = installation.value.repositorySelection;
    }

    const payload: GetIntegrationResponse = {
      connection: toPublicConnectionWithSelection(result.value, repositorySelection),
    };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}

// ── Revoke ──────────────────────────────────────────────────

export async function handleRevokeIntegration(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: HandlerDeps,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.MANAGE,
    requestId,
  );
  if (denied) return denied;

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    const existing = await repo.getConnection(orgId, connectionId);
    if (!existing.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    if (existing.value.status === "revoked") {
      const payload: RevokeIntegrationResponse = { revoked: true };
      return successResponse(payload, requestId);
    }

    const updated = await repo.updateConnectionStatus(orgId, connectionId, "revoked");
    if (!updated.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    // Cached platform token is dead the moment the connection is.
    await repo.deleteInstallationToken(connectionId);

    // Revoke fan-out (IH4, design §5.1): sweep the connection's live mints —
    // best-effort provider-side revoke, ledger marked either way. Never
    // blocks the platform revoke.
    try {
      await revokeLiveMintsForConnection(
        env,
        executor,
        connectionId,
        existing.value.provider,
        deps?.fetchImpl,
      );
    } catch {
      // TTL is the backstop.
    }

    if (existing.value.provider !== "github") {
      // Custody zeroize (design §3) for every custody-holding provider, plus
      // Slack's best-effort provider-side `auth.revoke` (decrypt-then-revoke
      // before the envelope rows are deleted). Cloudflare's parent token is
      // the CUSTOMER'S credential — never revoked provider-side, only
      // forgotten. Nothing here blocks the platform revoke.
      const hub = createIntegrationHubRepository(executor);
      if (existing.value.provider === "slack") {
        const credential = await hub.getProviderCredential(connectionId, "slack_bot_token");
        if (credential.ok) {
          const configured = getConfiguredProvider(env, "slack", deps?.fetchImpl);
          const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
          if (configured?.provider.revokeOauthToken && encryption) {
            try {
              const envelope = JSON.parse(credential.value.ciphertext) as CiphertextEnvelope;
              const token = await encryption.decrypt(envelope);
              await configured.provider.revokeOauthToken(token, Date.now());
            } catch {
              // Unreadable envelope or provider error — the zeroize below still runs.
            }
          }
        }
      }
      await hub.deleteProviderCredentials(connectionId);
    } else {
      // Best-effort GitHub-side uninstall (the inverse arrives via IG2 once the
      // inbound pipeline lands). Failure here never blocks the platform revoke.
      const installation = await repo.getGithubInstallationByConnectionId(connectionId);
      if (installation.ok) {
        const configured = getConfiguredProvider(env, "github");
        if (configured?.provider.revokeInstallation) {
          await configured.provider.revokeInstallation(
            installation.value.installationId,
            Date.now(),
          );
        }
      }
    }

    try {
      const events = createEventsRepository(executor);
      await events.appendEventWithAudit({
        event: {
          id: generateUuid(),
          type: INTEGRATION_EVENT_TYPES.REVOKED,
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
            provider: existing.value.provider,
            externalAccountLogin: existing.value.externalAccountLogin,
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `${providerDisplayName(existing.value.provider)} connection revoked${existing.value.externalAccountLogin ? ` (${existing.value.externalAccountLogin})` : ""}`,
        },
      });
    } catch {
      // Best-effort: audit emission never fails the revoke.
    }

    const payload: RevokeIntegrationResponse = { revoked: true };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}
