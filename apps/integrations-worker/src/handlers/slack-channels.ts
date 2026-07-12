// GET /v1/organizations/{orgId}/integrations/{connectionId}/slack/channels —
// the channel picker behind the slack_app notification channel (IH2, design
// §4.2). MessagingCapability.listChannels over the connection's custody bot
// token; the token is decrypted here, used for one provider call, and never
// leaves this isolate. Policy: organization.integration.messaging.manage
// (design §7 — picking channels administers messaging, it is more than read).

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PolicyResource } from "@saas/contracts/policy";
import type { ListSlackChannelsResponse } from "@saas/contracts/integrations";
import { INTEGRATION_POLICY_ACTIONS } from "@saas/contracts/integrations";
import {
  createIntegrationHubRepository,
  createIntegrationsRepository,
} from "@saas/db/integrations";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { asUuid } from "@saas/db/ids";
import type { FetchLike } from "../github-app.js";
import { resolveUsableConnection } from "../connection-access.js";
import { createEncryptionAdapter, type CiphertextEnvelope } from "../encryption.js";
import { errorResponse, successResponse } from "../http.js";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { getConfiguredProvider } from "../providers/registry.js";
import { getCapability } from "../providers/types.js";

export interface SlackChannelsDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

export async function handleListSlackChannels(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: SlackChannelsDeps,
): Promise<Response> {
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
    INTEGRATION_POLICY_ACTIONS.MESSAGING_MANAGE,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const configured = getConfiguredProvider(env, "slack", deps?.fetchImpl);
  const messaging = configured ? getCapability(configured.provider, "messaging") : null;
  const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  if (!messaging || !encryption) {
    return errorResponse(
      "precondition_failed",
      "The Slack App for this environment is not configured yet",
      412,
      requestId,
      { reason: "not_configured", gate: "slack_app_registration" },
    );
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    // Own or account-shared (IT10 admission) — same rule as repo listing.
    const connection = await resolveUsableConnection(env, repo, orgId, connectionId, requestId);
    if (!connection || connection.provider !== "slack") {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    if (connection.status !== "active") {
      return errorResponse("conflict", "The connection is not active", 409, requestId);
    }

    const hub = createIntegrationHubRepository(executor);
    const credential = await hub.getProviderCredential(asUuid(connection.id), "slack_bot_token");
    if (!credential.ok) {
      return errorResponse("conflict", "The connection has no Slack credential", 409, requestId);
    }
    let accessToken: string;
    try {
      const envelope = JSON.parse(credential.value.ciphertext) as CiphertextEnvelope;
      accessToken = await encryption.decrypt(envelope);
    } catch {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const url = new URL(request.url);
    const query = url.searchParams.get("query") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const page = await messaging.listChannels({
      accessToken,
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (!page) {
      return errorResponse("bad_gateway", "Slack did not return the channel list", 502, requestId);
    }

    const payload: ListSlackChannelsResponse = {
      channels: page.channels.map((c) => ({
        id: c.externalId,
        name: c.name,
        isPrivate: c.isPrivate,
      })),
      nextCursor: page.nextCursor,
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
