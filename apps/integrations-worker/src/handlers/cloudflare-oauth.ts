// GET /ingress/cloudflare/oauth — the OAuth-callback half of the Cloudflare
// tenancy keystone (IH5, risks D3). Cloudflare shipped OAuth clients for the
// API, so the connect posture upgrades from token-paste to OAuth 2 (PKCE),
// structurally identical to the Supabase callback (IH6). The org binding comes
// ONLY from our signed state — `cloudflare_account ↔ org_id` is carried, never
// inferred:
//
//   valid single-use state → resolve pending connection → consume the PKCE
//                            verifier from custody → exchange the code →
//                            refresh-token custody + account facts → activate
//                            (+ event)
//   anything else          → fail popup
//
// Like Supabase there is NO orphan-record path: the PKCE exchange cannot run
// without the verifier, and the verifier lives only in the custody row bound
// to the pending connection our state names. A state-less (or replayed)
// callback therefore has nothing to exchange — it just gets the fail popup.
//
// The response is the same tiny self-contained popup page as the other
// callbacks: the console polls the connection until it activates.

import type { Env } from "../env.js";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { FetchLike } from "../github-app.js";
import { INTEGRATION_EVENT_TYPES } from "@saas/contracts/integrations";
import {
  createIntegrationHubRepository,
  createIntegrationsRepository,
} from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import {
  createEncryptionAdapter,
  type CiphertextEnvelope,
  type EncryptionAdapter,
} from "../encryption.js";
import { generateUuid } from "../ids.js";
import { getConfiguredProvider } from "../providers/registry.js";
import {
  discoverCloudflareAccount,
  exchangeCloudflareOauthCode,
} from "../providers/cloudflare.js";
import { hashStateNonce, verifyConnectState } from "../state.js";
import { popupPage } from "./setup.js";

export const CLOUDFLARE_OAUTH_CALLBACK_PATH = "/ingress/cloudflare/oauth";

const LINK_FAILED_MESSAGE =
  "We couldn't link this Cloudflare account to an organization. Start the connection again from your organization's Integrations settings.";

/** Test seam: inject a fake executor / Cloudflare fetch; production omits it. */
export interface CloudflareOauthDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

export async function handleCloudflareOauthCallback(
  request: Request,
  env: Env,
  requestId: string,
  deps?: CloudflareOauthDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return popupPage("error", "Service unavailable", "The integration service is not ready.");
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  // The user declined the Cloudflare consent screen — nothing was granted, the
  // pending connection simply expires with its state.
  if (providerError) {
    return popupPage(
      "error",
      "Connection not completed",
      "Cloudflare reported the authorization was cancelled.",
    );
  }
  if (!code) {
    return popupPage("error", "Invalid callback", "The authorization code is missing.");
  }

  const configured = getConfiguredProvider(env, "cloudflare", deps?.fetchImpl);
  const redirectBase = env.OAUTH_REDIRECT_BASE_URL?.replace(/\/+$/, "");
  const encryption: EncryptionAdapter | null = await createEncryptionAdapter(
    env.SECRET_ENCRYPTION_KEY,
  );
  // The registry only resolves an OAuth-kind Cloudflare adapter when the OAuth
  // client is configured; a token-paste adapter has no buildAuthorizeUrl and
  // therefore never mints a callback URL, so reaching here without OAuth
  // configured is a misconfiguration.
  if (
    !configured ||
    configured.provider.connectKind !== "oauth" ||
    !redirectBase ||
    !encryption ||
    !env.CLOUDFLARE_OAUTH_CLIENT_ID ||
    !env.CLOUDFLARE_OAUTH_CLIENT_SECRET
  ) {
    return popupPage(
      "error",
      "Not configured",
      "The Cloudflare OAuth client for this environment is not configured yet.",
    );
  }
  const credentials = {
    clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
    clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
  };
  const redirectUri = `${redirectBase}${CLOUDFLARE_OAUTH_CALLBACK_PATH}`;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const hub = createIntegrationHubRepository(executor);

    // No usable state → fail closed. Covers unsolicited callbacks, tampered
    // or expired state, and replays — identical observable outcome by design.
    const fail = (): Response =>
      popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);

    if (!state || !env.INTEGRATIONS_STATE_SECRET) {
      return fail();
    }

    const payload = await verifyConnectState(state, env.INTEGRATIONS_STATE_SECRET, Date.now());
    if (!payload || payload.p !== "cloudflare") {
      return fail();
    }

    const nonceHash = await hashStateNonce(payload.n);
    const consumed = await repo.consumeConnectionState(nonceHash);
    if (!consumed.ok) {
      return fail();
    }

    // Defense in depth: the consumed row must be exactly the connection and
    // org the state was minted for.
    const connection = consumed.value;
    if (
      connection.id !== payload.c ||
      connection.orgId !== payload.o ||
      connection.provider !== payload.p
    ) {
      return fail();
    }

    // PKCE verifier: read from custody, then DELETE immediately — it is
    // consumed by this callback whether or not the exchange succeeds.
    const verifierRow = await hub.getProviderCredential(
      asUuid(connection.id),
      "cloudflare_pkce_verifier",
    );
    if (!verifierRow.ok) {
      return fail();
    }
    await hub.deleteProviderCredential(asUuid(connection.id), "cloudflare_pkce_verifier");
    let codeVerifier: string;
    try {
      codeVerifier = await encryption.decrypt(
        JSON.parse(verifierRow.value.ciphertext) as CiphertextEnvelope,
      );
    } catch {
      return fail();
    }

    // Exchange the code with the verifier — Cloudflare verifies the code, the
    // redirect_uri, AND that the verifier matches the challenge the authorize
    // URL carried. This is the provider-side half of the keystone.
    const grant = await exchangeCloudflareOauthCode(
      credentials,
      { code, redirectUri, codeVerifier },
      deps?.fetchImpl,
    );
    if (!grant) {
      return popupPage(
        "error",
        "Verification failed",
        "Cloudflare did not confirm this authorization. Try connecting again.",
      );
    }

    // The account behind the grant — the connection's external anchor.
    const account = await discoverCloudflareAccount(grant.accessToken, deps?.fetchImpl);
    if (!account) {
      return popupPage(
        "error",
        "Verification failed",
        "Cloudflare did not confirm this authorization. Try connecting again.",
      );
    }

    // Re-auth (IH9): a Cloudflare account already bound to a connection means
    // this OAuth round is a re-authorization. Owned by the state's org →
    // refresh custody on the EXISTING connection and reactivate it (a suspended
    // connection heals; brokered secrets keep their binding); the pending
    // placeholder this state minted is retired. Owned elsewhere → refuse BEFORE
    // any facts write, so the binding can never flip across orgs. Only a
    // revoked own connection falls through to the fresh-create path.
    const existing = await hub.getCloudflareAccountByExternalId(account.accountExternalId);
    if (existing.ok && existing.value.connectionId && existing.value.connectionId !== connection.id) {
      const boundId = asUuid(existing.value.connectionId);
      const own = await repo.getConnection(asUuid(connection.orgId), boundId);
      if (own.ok && own.value.status !== "revoked") {
        const reEnvelope = await encryption.encrypt(grant.refreshToken);
        const restored = await hub.upsertProviderCredential({
          id: generateUuid(),
          connectionId: boundId,
          kind: "cloudflare_refresh_token",
          ciphertext: JSON.stringify(reEnvelope),
          externalRef: account.accountExternalId,
        });
        if (!restored.ok) {
          return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
        }
        await hub.upsertCloudflareAccount({
          id: generateUuid(),
          connectionId: boundId,
          accountExternalId: account.accountExternalId,
          accountName: account.accountName,
          parentTokenRef: null,
          tokenStatus: "active",
          parentExpiresAt: null,
        });
        if (own.value.status !== "active") {
          const reactivated = await repo.updateConnectionStatus(
            asUuid(connection.orgId),
            boundId,
            "active",
          );
          if (!reactivated.ok) {
            return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
          }
        }
        // Retire the placeholder this state minted — it never activates.
        await repo.updateConnectionStatus(asUuid(connection.orgId), asUuid(connection.id), "revoked");
        try {
          const events = createEventsRepository(executor);
          await events.appendEventWithAudit({
            event: {
              id: generateUuid(),
              type: INTEGRATION_EVENT_TYPES.REACTIVATED,
              version: 1,
              source: "integrations-worker",
              occurredAt: new Date(),
              actorType: "user",
              actorId: connection.createdBy ?? "unknown",
              orgId: asUuid(connection.orgId),
              subjectKind: "integration_connection",
              subjectId: existing.value.connectionId,
              requestId,
              payload: { provider: "cloudflare", reason: "reauthorized" },
            },
            audit: {
              id: generateUuid(),
              category: "integrations",
              description: "Cloudflare connection re-authorized (fresh OAuth grant)",
            },
          });
        } catch {
          // best-effort
        }
        return popupPage(
          "success",
          "Reconnected",
          "Cloudflare access was re-authorized.",
          env.CONSOLE_BASE_URL,
        );
      }
      if (!own.ok) {
        return popupPage(
          "error",
          "Already connected",
          "This Cloudflare account is already linked to a connection.",
        );
      }
    }

    // Custody first (design §3): by the time the connection is visible as
    // active, its REFRESH token is already at rest as an encrypted envelope.
    // The short-lived access token is never stored durable.
    const envelope = await encryption.encrypt(grant.refreshToken);
    const stored = await hub.upsertProviderCredential({
      id: generateUuid(),
      connectionId: asUuid(connection.id),
      kind: "cloudflare_refresh_token",
      ciphertext: JSON.stringify(envelope),
      externalRef: account.accountExternalId,
    });
    if (!stored.ok) {
      return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
    }

    const facts = await hub.upsertCloudflareAccount({
      id: generateUuid(),
      connectionId: asUuid(connection.id),
      accountExternalId: account.accountExternalId,
      accountName: account.accountName,
      parentTokenRef: null,
      tokenStatus: "active",
      parentExpiresAt: null,
    });
    if (!facts.ok) {
      return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
    }
    // The account row must end up bound to THIS connection — an account already
    // claimed by another live connection must not flip.
    if (facts.value.connectionId !== connection.id) {
      return popupPage(
        "error",
        "Already connected",
        "This Cloudflare account is already linked to a connection.",
      );
    }

    const activated = await repo.activateConnection(
      asUuid(connection.orgId),
      asUuid(connection.id),
      {
        displayName: connection.displayName ?? account.accountName ?? account.accountExternalId,
        externalAccountLogin: account.accountName ?? account.accountExternalId,
        externalAccountId: account.accountExternalId,
        externalAccountType: "account",
      },
    );
    if (!activated.ok) {
      if (activated.error.kind === "conflict") {
        return popupPage(
          "error",
          "Already connected",
          "An active connection for this Cloudflare account already exists in the organization.",
        );
      }
      return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
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
          actorType: "user",
          actorId: connection.createdBy ?? "unknown",
          orgId: connection.orgId,
          subjectKind: "integration_connection",
          subjectId: connection.id,
          requestId,
          payload: {
            provider: "cloudflare",
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

    return popupPage(
      "success",
      "Cloudflare connected",
      `The account${account.accountName ? ` ${account.accountName}` : ""} is now linked.`,
      env.CONSOLE_BASE_URL,
    );
  } catch {
    return popupPage("error", "Something went wrong", "Try connecting again from the console.");
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
