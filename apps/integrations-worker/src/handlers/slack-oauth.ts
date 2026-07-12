// GET /ingress/slack/oauth — the OAuth-callback half of the Slack tenancy
// keystone (design §4.1). Slack redirects the installing user here with a
// `code` and (always, for flows we initiated) the signed state. The org
// binding comes ONLY from our state — `team_id ↔ org_id` is carried, never
// inferred:
//
//   valid single-use state  → resolve pending connection → exchange the code
//                             (`oauth.v2.access`) → custody envelope +
//                             workspace facts → activate (+ event)
//   anything else           → exchange the code anyway to learn the team and
//                             record it ORPHANED (admin-visible, never
//                             auto-bound) — fail closed, the IG rule
//
// The response is the same tiny self-contained popup page as the GitHub
// setup callback: the console polls the connection until it activates.

import type { Env } from "../env.js";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { FetchLike } from "../github-app.js";
import { INTEGRATION_EVENT_TYPES } from "@saas/contracts/integrations";
import {
  createIntegrationHubRepository,
  createIntegrationsRepository,
  type IntegrationHubRepository,
} from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { createEncryptionAdapter, type EncryptionAdapter } from "../encryption.js";
import { generateUuid } from "../ids.js";
import type { IntegrationProvider, ProviderOauthGrant } from "../providers/types.js";
import { getConfiguredProvider } from "../providers/registry.js";
import { hashStateNonce, verifyConnectState } from "../state.js";
import { popupPage } from "./setup.js";

export const SLACK_OAUTH_CALLBACK_PATH = "/ingress/slack/oauth";

const LINK_FAILED_MESSAGE =
  "We couldn't link this Slack workspace to an organization. Start the connection again from your organization's Integrations settings.";

/** Record an unsolicited/unbindable grant as an orphaned workspace row —
 *  fail closed, mirroring the GitHub orphan-install rule. The code has to be
 *  exchanged to learn the team; the resulting bot token is deliberately NOT
 *  kept (no connection → no custody row → nothing to hold it under). */
async function recordOrphan(
  hub: IntegrationHubRepository,
  provider: IntegrationProvider | undefined,
  code: string | null,
  redirectUri: string | null,
): Promise<void> {
  if (!provider?.exchangeOauthCode || !code || !redirectUri) return;
  const grant = await provider.exchangeOauthCode({ code, redirectUri, nowMs: Date.now() });
  if (!grant) return;
  await hub.upsertSlackWorkspace({
    id: generateUuid(),
    connectionId: null,
    teamId: grant.teamId,
    teamName: grant.teamName,
    enterpriseId: grant.enterpriseId,
    botUserId: grant.botUserId,
    appId: grant.appId,
    grantedScopes: grant.grantedScopes,
    installedByExternalUser: grant.installedByExternalUser,
  });
  if (provider.revokeOauthToken) {
    // Best-effort: an orphaned grant's token should not stay live on the
    // Slack side either.
    await provider.revokeOauthToken(grant.accessToken, Date.now());
  }
}

/** Test seam: inject a fake executor / Slack fetch; production omits it. */
export interface SlackOauthDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

export async function handleSlackOauthCallback(
  request: Request,
  env: Env,
  requestId: string,
  deps?: SlackOauthDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return popupPage("error", "Service unavailable", "The integration service is not ready.");
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  // The user declined the Slack consent screen — nothing was granted, the
  // pending connection simply expires with its state.
  if (providerError) {
    return popupPage(
      "error",
      "Connection not completed",
      "Slack reported the authorization was cancelled.",
    );
  }
  if (!code) {
    return popupPage("error", "Invalid callback", "The authorization code is missing.");
  }

  const configured = getConfiguredProvider(env, "slack", deps?.fetchImpl);
  const provider = configured?.provider;
  const redirectBase = env.OAUTH_REDIRECT_BASE_URL?.replace(/\/+$/, "");
  const encryption: EncryptionAdapter | null = await createEncryptionAdapter(
    env.SECRET_ENCRYPTION_KEY,
  );
  if (!provider?.exchangeOauthCode || !redirectBase || !encryption) {
    return popupPage(
      "error",
      "Not configured",
      "The Slack App for this environment is not configured yet.",
    );
  }
  const redirectUri = `${redirectBase}${SLACK_OAUTH_CALLBACK_PATH}`;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const hub = createIntegrationHubRepository(executor);

    // No usable state → orphan. Covers unsolicited grants, tampered or
    // expired state, and replays — identical observable outcome by design.
    const fail = async (): Promise<Response> => {
      await recordOrphan(hub, provider, code, redirectUri);
      return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
    };

    if (!state || !env.INTEGRATIONS_STATE_SECRET) {
      return await fail();
    }

    const payload = await verifyConnectState(state, env.INTEGRATIONS_STATE_SECRET, Date.now());
    if (!payload || payload.p !== "slack") {
      return await fail();
    }

    const nonceHash = await hashStateNonce(payload.n);
    const consumed = await repo.consumeConnectionState(nonceHash);
    if (!consumed.ok) {
      return await fail();
    }

    // Defense in depth: the consumed row must be exactly the connection and
    // org the state was minted for.
    const connection = consumed.value;
    if (
      connection.id !== payload.c ||
      connection.orgId !== payload.o ||
      connection.provider !== payload.p
    ) {
      return await fail();
    }

    // Exchange the code as the App — Slack verifies both the code and that
    // redirect_uri matches the authorize request. This is the provider-side
    // half of the keystone; the state above is ours.
    const grant: ProviderOauthGrant | null = await provider.exchangeOauthCode({
      code,
      redirectUri,
      nowMs: Date.now(),
    });
    if (!grant) {
      return popupPage(
        "error",
        "Verification failed",
        "Slack did not confirm this authorization. Try connecting again.",
      );
    }

    // Re-auth (IH9): a workspace already bound to a connection means this
    // OAuth round is a re-authorization. Owned by the state's org and not
    // revoked → refresh custody on the EXISTING connection and reactivate
    // it (suspended connections heal; slack_app channels keep their
    // binding); the pending placeholder is retired. Owned but REVOKED →
    // explicitly rebind the workspace to this fresh connection (the
    // COALESCE upsert deliberately never flips, which would otherwise make
    // a revoked workspace unreconnectable forever). Owned elsewhere →
    // refuse.
    const existingWs = await hub.getSlackWorkspaceByTeamId(grant.teamId);
    if (
      existingWs.ok &&
      existingWs.value.connectionId &&
      existingWs.value.connectionId !== connection.id
    ) {
      const boundId = asUuid(existingWs.value.connectionId);
      const own = await repo.getConnection(asUuid(connection.orgId), boundId);
      if (own.ok && own.value.status !== "revoked") {
        const reEnvelope = await encryption.encrypt(grant.accessToken);
        const restored = await hub.upsertProviderCredential({
          id: generateUuid(),
          connectionId: boundId,
          kind: "slack_bot_token",
          ciphertext: JSON.stringify(reEnvelope),
          scopes: grant.grantedScopes,
          externalRef: grant.teamId,
        });
        if (!restored.ok) {
          return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
        }
        await hub.upsertSlackWorkspace({
          id: generateUuid(),
          connectionId: boundId,
          teamId: grant.teamId,
          teamName: grant.teamName,
          enterpriseId: grant.enterpriseId,
          botUserId: grant.botUserId,
          appId: grant.appId,
          grantedScopes: grant.grantedScopes,
          installedByExternalUser: grant.installedByExternalUser,
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
              subjectId: existingWs.value.connectionId,
              requestId,
              payload: { provider: "slack", reason: "reauthorized" },
            },
            audit: {
              id: generateUuid(),
              category: "integrations",
              description: "Slack connection re-authorized (fresh grant)",
            },
          });
        } catch {
          // best-effort
        }
        return popupPage(
          "success",
          "Reconnected",
          "Slack access was re-authorized. You can close this window.",
        );
      }
      if (own.ok) {
        // Revoked own connection: reconnect-after-revoke. Rebind the
        // workspace row to THIS connection so the normal path below can
        // bind and activate it.
        const rebound = await hub.rebindSlackWorkspace(grant.teamId, asUuid(connection.id));
        if (!rebound.ok) {
          return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
        }
      } else {
        return popupPage(
          "error",
          "Already connected",
          "This Slack workspace is already linked to a connection.",
        );
      }
    }

    // Custody first (design §3): by the time the connection is visible as
    // active, its bot token is already at rest as an encrypted envelope.
    const envelope = await encryption.encrypt(grant.accessToken);
    const stored = await hub.upsertProviderCredential({
      id: generateUuid(),
      connectionId: asUuid(connection.id),
      kind: "slack_bot_token",
      ciphertext: JSON.stringify(envelope),
      scopes: grant.grantedScopes,
      externalRef: grant.teamId,
    });
    if (!stored.ok) {
      return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
    }

    const workspace = await hub.upsertSlackWorkspace({
      id: generateUuid(),
      connectionId: asUuid(connection.id),
      teamId: grant.teamId,
      teamName: grant.teamName,
      enterpriseId: grant.enterpriseId,
      botUserId: grant.botUserId,
      appId: grant.appId,
      grantedScopes: grant.grantedScopes,
      installedByExternalUser: grant.installedByExternalUser,
    });
    if (!workspace.ok) {
      return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
    }
    // The workspace row must end up bound to THIS connection — a team already
    // claimed by another live connection must not flip.
    if (workspace.value.connectionId !== connection.id) {
      return popupPage(
        "error",
        "Already connected",
        "This Slack workspace is already linked to a connection.",
      );
    }

    const activated = await repo.activateConnection(
      asUuid(connection.orgId),
      asUuid(connection.id),
      {
        displayName: connection.displayName ?? grant.teamName ?? grant.teamId,
        externalAccountLogin: grant.teamName ?? grant.teamId,
        externalAccountId: grant.teamId,
        externalAccountType: "workspace",
      },
    );
    if (!activated.ok) {
      if (activated.error.kind === "conflict") {
        return popupPage(
          "error",
          "Already connected",
          "An active connection for this Slack workspace already exists in the organization.",
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
            provider: "slack",
            teamId: grant.teamId,
            teamName: grant.teamName,
            grantedScopes: grant.grantedScopes,
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `Slack connected${grant.teamName ? ` (${grant.teamName})` : ""}`,
        },
      });
    } catch {
      // Best-effort: the connection is active; audit emission is not a gate.
    }

    return popupPage(
      "success",
      "Slack connected",
      `The workspace${grant.teamName ? ` ${grant.teamName}` : ""} is now linked.`,
    );
  } catch {
    return popupPage("error", "Something went wrong", "Try connecting again from the console.");
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
