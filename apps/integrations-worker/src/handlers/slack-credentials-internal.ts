// POST /internal/slack/credentials — the delivery half of the custody split
// (IH2, design §4.2). notifications-worker calls this over its service
// binding when a slack_app channel needs to post: this worker alone can
// decrypt the custody envelope, and the bot token crosses ONLY the binding —
// the caller holds it in isolate memory (≤5 min), never durably.
//
// Authenticated by the service-binding boundary (x-internal-caller, enforced
// in the router), never a user bearer. Fail-soft: the response is always 200
// with a typed outcome, mirroring the write-back driver — a config problem on
// a delivery path should read as a bounded delivery error, not a 5xx storm.
//
// Tenancy: the caller sends the ORG of the notification plus the connection
// its channel references. Resolution goes through resolveUsableConnection —
// own or account-shared with admission (IT10) — so a channel row pointing at
// a connection the org may not use yields not_found, closing the
// paste-another-org's-connection-id hole at every send.

import type { Env } from "../env.js";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import {
  createIntegrationHubRepository,
  createIntegrationsRepository,
} from "@saas/db/integrations";
import { asUuid } from "@saas/db/ids";
import { resolveUsableConnection } from "../connection-access.js";
import { createEncryptionAdapter, type CiphertextEnvelope } from "../encryption.js";
import { parseConnectionPublicId, parseOrgPublicId } from "../ids.js";

export type SlackCredentialsOutcome =
  | { ok: true; botToken: string; teamId: string | null }
  | {
      ok: false;
      reason: "invalid_request" | "not_found" | "not_active" | "not_configured";
    };

function outcomeResponse(outcome: SlackCredentialsOutcome, requestId: string): Response {
  return Response.json(
    { data: outcome, meta: { requestId } },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export interface SlackCredentialsDeps {
  executor?: SqlExecutor;
}

export async function handleSlackCredentialsInternal(
  request: Request,
  env: Env,
  requestId: string,
  deps?: SlackCredentialsDeps,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return outcomeResponse({ ok: false, reason: "invalid_request" }, requestId);
  }
  const orgUuid = typeof body.orgId === "string" ? parseOrgPublicId(body.orgId) : null;
  const connectionUuid =
    typeof body.connectionId === "string" ? parseConnectionPublicId(body.connectionId) : null;
  if (!orgUuid || !connectionUuid) {
    return outcomeResponse({ ok: false, reason: "invalid_request" }, requestId);
  }

  const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  if (!encryption) {
    return outcomeResponse({ ok: false, reason: "not_configured" }, requestId);
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const connection = await resolveUsableConnection(
      env,
      repo,
      orgUuid,
      asUuid(connectionUuid),
      requestId,
    );
    if (!connection || connection.provider !== "slack") {
      return outcomeResponse({ ok: false, reason: "not_found" }, requestId);
    }
    if (connection.status !== "active") {
      return outcomeResponse({ ok: false, reason: "not_active" }, requestId);
    }

    const hub = createIntegrationHubRepository(executor);
    const credential = await hub.getProviderCredential(asUuid(connection.id), "slack_bot_token");
    if (!credential.ok) {
      return outcomeResponse({ ok: false, reason: "not_found" }, requestId);
    }
    let botToken: string;
    try {
      const envelope = JSON.parse(credential.value.ciphertext) as CiphertextEnvelope;
      botToken = await encryption.decrypt(envelope);
    } catch {
      return outcomeResponse({ ok: false, reason: "not_configured" }, requestId);
    }

    return outcomeResponse(
      { ok: true, botToken, teamId: credential.value.externalRef },
      requestId,
    );
  } catch {
    return outcomeResponse({ ok: false, reason: "not_configured" }, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
