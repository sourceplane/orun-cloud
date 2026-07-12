import type { Env } from "../env.js";
import type { InternalActor } from "../router.js";
import {
  createNotificationChannelsRepository,
  type NotificationChannelsRepository,
} from "@saas/db/notifications";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { createEncryptionAdapter } from "../encryption.js";
import { emitEvent } from "../events-client.js";
import { emitChannelEvent } from "./channels.js";
import { successResponse } from "../http.js";
import { parseOrgIdInput } from "../ids.js";

/**
 * Channel freshness on Slack archive (saas-integration-hub IH3, design §4.3).
 *
 * POST /internal/notification-channels/slack-disable — called by the
 * events-worker messaging lane when a `messaging.channel.archived` event
 * lands. Body: `{orgId (org_…), connectionId (int_…), channelExternalId}`.
 * slack_app channel rows store their `{connectionId, channelExternalId}`
 * reference ENCRYPTED, so matching requires a decrypt-scan of the org's
 * slack_app channels; every active match flips to `disabled` and emits the
 * catalogued `notification_channel.updated` event (the console's signal).
 *
 * Fail-soft by design: this is a best-effort reaction, so a malformed body,
 * missing encryption key / DB binding, or an unreadable ciphertext all
 * degrade to `200 {disabled: 0}` — never an error the caller must handle.
 * (The 403 for a missing/unknown internal actor is the router's.) The
 * mutation is idempotent: an already-disabled channel never re-matches, so
 * replaying the archive event is a no-op.
 */

const CONNECTION_ID_RE = /^int_[0-9a-f]{32}$/;

export interface ChannelFreshnessDeps {
  channelsRepo?: NotificationChannelsRepository;
  emit?: typeof emitEvent;
}

export async function handleSlackChannelDisable(
  request: Request,
  env: Env,
  requestId: string,
  actor: InternalActor,
  deps: ChannelFreshnessDeps = {},
): Promise<Response> {
  const ok = (disabled: number) => successResponse({ disabled }, requestId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return ok(0);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const orgUuid = typeof b.orgId === "string" ? parseOrgIdInput(b.orgId) : null;
  const connectionId =
    typeof b.connectionId === "string" && CONNECTION_ID_RE.test(b.connectionId)
      ? b.connectionId
      : null;
  const channelExternalId =
    typeof b.channelExternalId === "string" && b.channelExternalId ? b.channelExternalId : null;
  if (!orgUuid || !connectionId || !channelExternalId) return ok(0);

  if (!env.SECRET_ENCRYPTION_KEY) return ok(0);
  const adapter = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  if (!adapter) return ok(0);
  if (!deps.channelsRepo && !env.PLATFORM_DB) return ok(0);

  const executor = deps.channelsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps.channelsRepo ?? createNotificationChannelsRepository(executor!);
    const listed = await repo.listChannelConfigsByKind(asUuid(orgUuid), "slack_app");
    if (!listed.ok) return ok(0);

    let disabled = 0;
    for (const cfg of listed.value) {
      if (cfg.status !== "active") continue;
      let ref: { connectionId?: unknown; channelExternalId?: unknown };
      try {
        ref = JSON.parse(await adapter.decrypt(JSON.parse(cfg.configCiphertext))) as typeof ref;
      } catch {
        continue; // unreadable config — not this route's problem
      }
      if (ref.connectionId !== connectionId || ref.channelExternalId !== channelExternalId) {
        continue;
      }
      const updated = await repo.updateChannel(asUuid(orgUuid), cfg.id, { status: "disabled" });
      if (!updated.ok || !updated.value) continue;
      disabled++;
      await emitChannelEvent(env, deps.emit ?? emitEvent, {
        type: "notification_channel.updated",
        orgUuid,
        channel: updated.value,
        actor,
        requestId,
        description: `Notification channel disabled: ${updated.value.name} (linked Slack channel was archived)`,
      });
    }
    return ok(disabled);
  } catch {
    return ok(0);
  } finally {
    if (executor) await executor.dispose();
  }
}
