// The Slack half of the inbox drain (IH3, design §4.3): attribute by
// team_id (the keystone carried by slack_workspaces, never inferred),
// handle the Slack lifecycle (uninstall/revoke → platform revoke + custody
// zeroize; channel rename/archive → messaging.channel.*), and normalize
// commands/actions into the versioned messaging.* taxonomy.
//
// Slack-side side effects (the /orun response via response_url, the
// Acknowledge thread reply, ephemeral action confirmations) are BEST-EFFORT
// and run after the event is durably emitted — a Slack hiccup never
// re-queues an already-emitted delivery. Platform mutations (rule mute,
// channel disable) are deliberately NOT here: the events-worker messaging
// lane reacts to the emitted events, keeping "events + rules" the
// composition point and this worker free of reverse service bindings.

import { MESSAGING_EVENT_TYPES, INTEGRATION_EVENT_TYPES } from "@saas/contracts/integrations";
import {
  createIntegrationHubRepository,
  type InboundDelivery,
  type IntegrationConnection,
} from "@saas/db/integrations";
import { asUuid } from "@saas/db/ids";
import { createEncryptionAdapter, type CiphertextEnvelope } from "./encryption.js";
import { connectionPublicId, generateUuid, inboundDeliveryPublicId } from "./ids.js";
import {
  emitAndMark,
  markRetryOrFail,
  markSkipped,
  type DeliveryOutcome,
  type ProcessCtx,
} from "./drain.js";

/** Slack event types the drain treats as connection/channel lifecycle. */
export const SLACK_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  "app_uninstalled",
  "tokens_revoked",
  "channel_rename",
  "channel_archive",
]);

/** team_id extraction across the three ingress shapes (events wrapper,
 *  form-encoded command fields, interactivity payload). */
export function teamIdFromSlackPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.team_id === "string" && payload.team_id) return payload.team_id;
  const team = payload.team as { id?: unknown } | null | undefined;
  if (typeof team?.id === "string" && team.id) return team.id;
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** The inner Events-API event, when this delivery came from /events. */
function innerEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const event = payload.event;
  return event && typeof event === "object" ? (event as Record<string, unknown>) : {};
}

async function decryptBotToken(
  ctx: ProcessCtx,
  connectionId: string,
): Promise<string | null> {
  const encryption = await createEncryptionAdapter(ctx.env.SECRET_ENCRYPTION_KEY);
  if (!encryption) return null;
  const hub = createIntegrationHubRepository(ctx.executor);
  const credential = await hub.getProviderCredential(asUuid(connectionId), "slack_bot_token");
  if (!credential.ok) return null;
  try {
    return await encryption.decrypt(JSON.parse(credential.value.ciphertext) as CiphertextEnvelope);
  } catch {
    return null;
  }
}

async function postJson(url: string, body: Record<string, unknown>, botToken?: string): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(botToken ? { authorization: `Bearer ${botToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Best-effort by contract — the event is already emitted.
  }
}

function consoleLink(ctx: ProcessCtx, path: string): string | null {
  const base = ctx.env.CONSOLE_BASE_URL?.replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
}

/** `/orun` command responses (design §4.3): org-scoped summaries with deep
 *  links into the console, where real RBAC applies — never sensitive detail
 *  embedded into a shared channel. */
export function buildOrunCommandResponse(
  text: string,
  orgName: string | null,
  links: { events: string | null; console: string | null },
): Record<string, unknown> {
  const sub = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const where = orgName ? ` for *${orgName}*` : "";
  if (sub === "status") {
    return {
      response_type: "ephemeral",
      text: `Orun status${where}: open the console for live run and catalog state.${
        links.events ? ` ${links.events}` : ""
      }`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Orun status${where}*\nLive run, event, and catalog state lives in the console${
              links.events ? ` — <${links.events}|open events>` : ""
            }.`,
          },
        },
      ],
    };
  }
  if (sub === "runs") {
    return {
      response_type: "ephemeral",
      text: `Recent runs${where} are in the console.${links.console ? ` ${links.console}` : ""}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Recent runs${where}*\n${
              links.console ? `<${links.console}|Open the console>` : "Open the console"
            } to see runs with full detail (RBAC applies there).`,
          },
        },
      ],
    };
  }
  return {
    response_type: "ephemeral",
    text: "Orun commands: /orun status · /orun runs [project] · /orun help",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Orun* — `/orun status` (org summary) · `/orun runs [project]` (recent runs) · `/orun help`",
        },
      },
    ],
  };
}

/** Slack lifecycle: uninstall/token-revoke → platform revoke + custody
 *  zeroize; rename/archive → messaging.channel.* (the events-worker lane
 *  reacts to archive by disabling dependent channels). */
async function processSlackLifecycle(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  connection: IntegrationConnection,
  teamId: string,
): Promise<DeliveryOutcome> {
  const orgId = asUuid(connection.orgId);
  const connectionId = asUuid(connection.id);
  const event = innerEvent(delivery.payload);
  const subject = { kind: "integration_connection", id: connection.id };
  const base = {
    provider: "slack",
    connectionId: connectionPublicId(connection.id),
    workspaceExternalId: teamId,
  };

  if (delivery.eventType === "app_uninstalled" || delivery.eventType === "tokens_revoked") {
    if (connection.status !== "revoked") {
      await ctx.repo.updateConnectionStatus(orgId, connectionId, "revoked");
    }
    // Custody zeroize (design §3): the workspace pulled the plug provider-side;
    // nothing to auth.revoke — the token is already dead over there.
    const hub = createIntegrationHubRepository(ctx.executor);
    await hub.deleteProviderCredentials(connectionId);
    return emitAndMark(
      ctx,
      delivery,
      connection,
      INTEGRATION_EVENT_TYPES.REVOKED,
      subject,
      { ...base, origin: "provider_uninstall", slackEvent: delivery.eventType },
      `Slack connection revoked by the workspace (${delivery.eventType})`,
    );
  }

  if (delivery.eventType === "channel_rename") {
    const channel = (event.channel ?? {}) as Record<string, unknown>;
    const channelExternalId = str(channel.id);
    if (!channelExternalId) {
      return markSkipped(ctx, delivery, "malformed_channel_event", {
        orgId: connection.orgId,
        connectionId: connection.id,
      });
    }
    // Catalog posture: renamed is informational, audit:false — plain append.
    const eventId = generateUuid();
    const appended = await ctx.events.appendEvent({
      id: eventId,
      type: MESSAGING_EVENT_TYPES.CHANNEL_RENAMED,
      version: 1,
      source: "integrations-worker",
      occurredAt: ctx.now(),
      actorType: "system",
      actorId: "integrations-worker",
      orgId: connection.orgId,
      subjectKind: "integration_connection",
      subjectId: connection.id,
      requestId: inboundDeliveryPublicId(delivery.id),
      payload: { ...base, channelExternalId, channelName: str(channel.name) },
    });
    if (!appended.ok) return markRetryOrFail(ctx, delivery, "emit_failed");
    await ctx.repo.markInboundDelivery(asUuid(delivery.id), {
      status: "emitted",
      orgId,
      connectionId,
      emittedEventId: asUuid(eventId),
      failureReason: null,
    });
    return { kind: "emitted", eventType: MESSAGING_EVENT_TYPES.CHANNEL_RENAMED };
  }

  // channel_archive
  const channel = (event.channel ?? {}) as Record<string, unknown>;
  const channelExternalId = str(channel.id) ?? str(event.channel);
  if (!channelExternalId) {
    return markSkipped(ctx, delivery, "malformed_channel_event", {
      orgId: connection.orgId,
      connectionId: connection.id,
    });
  }
  return emitAndMark(
    ctx,
    delivery,
    connection,
    MESSAGING_EVENT_TYPES.CHANNEL_ARCHIVED,
    subject,
    { ...base, channelExternalId, channelName: str(channel.name) },
    "Slack channel archived — dependent notification channels flip to disabled",
  );
}

/** Process one Slack inbox row end to end (the GitHub processDelivery twin). */
export async function processSlackDelivery(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
): Promise<DeliveryOutcome> {
  const teamId = teamIdFromSlackPayload(delivery.payload);
  if (!teamId) {
    return markSkipped(ctx, delivery, "no_team_reference");
  }

  // Attribution: team_id → workspace facts → connection. A workspace row
  // without a connection is an orphaned callback — recorded, never bound.
  const hub = createIntegrationHubRepository(ctx.executor);
  const workspace = await hub.getSlackWorkspaceByTeamId(teamId);
  if (!workspace.ok || workspace.value.connectionId == null) {
    return markSkipped(ctx, delivery, "unattributed_workspace");
  }
  const connection = await ctx.repo.getConnectionById(asUuid(workspace.value.connectionId));
  if (!connection.ok) {
    return markSkipped(ctx, delivery, "connection_missing");
  }

  if (SLACK_LIFECYCLE_EVENTS.has(delivery.eventType)) {
    return processSlackLifecycle(ctx, delivery, connection.value, teamId);
  }

  if (connection.value.status !== "active") {
    return markSkipped(ctx, delivery, "connection_revoked", {
      orgId: connection.value.orgId,
      connectionId: connection.value.id,
    });
  }

  const base = {
    provider: "slack",
    connectionId: connectionPublicId(connection.value.id),
    workspaceExternalId: teamId,
  };
  const subject = { kind: "integration_connection", id: connection.value.id };
  const payload = delivery.payload;

  if (delivery.eventType === "slash_command") {
    const command = str(payload.command) ?? "/orun";
    const text = str(payload.text) ?? "";
    const outcome = await emitAndMark(
      ctx,
      delivery,
      connection.value,
      MESSAGING_EVENT_TYPES.COMMAND_INVOKED,
      subject,
      {
        ...base,
        command,
        text,
        channelExternalId: str(payload.channel_id),
        invokedByExternalUser: str(payload.user_id),
      },
      `Slack command invoked: ${command}`,
    );
    // Real response via response_url (valid 30 min) — after the durable emit.
    const responseUrl = str(payload.response_url);
    if (outcome.kind === "emitted" && responseUrl) {
      await postJson(
        responseUrl,
        buildOrunCommandResponse(text, connection.value.displayName, {
          events: consoleLink(ctx, "/events"),
          console: consoleLink(ctx, "/"),
        }),
      );
    }
    return outcome;
  }

  if (delivery.eventType === "interactivity") {
    const actions = Array.isArray(payload.actions) ? (payload.actions as Array<Record<string, unknown>>) : [];
    const action = actions[0] ?? {};
    const rawActionId = str(action.action_id);
    const actionId =
      rawActionId === "orun_ack" ? "acknowledge" : rawActionId === "orun_mute" ? "mute_rule" : null;
    if (!actionId) {
      return markSkipped(ctx, delivery, "unsupported_action", {
        orgId: connection.value.orgId,
        connectionId: connection.value.id,
      });
    }
    const user = (payload.user ?? {}) as Record<string, unknown>;
    const channel = (payload.channel ?? {}) as Record<string, unknown>;
    const message = (payload.message ?? {}) as Record<string, unknown>;
    const invokedBy = str(user.id);

    const outcome = await emitAndMark(
      ctx,
      delivery,
      connection.value,
      MESSAGING_EVENT_TYPES.ACTION_INVOKED,
      subject,
      {
        ...base,
        actionId,
        value: str(action.value),
        channelExternalId: str(channel.id),
        invokedByExternalUser: invokedBy,
      },
      `Slack notification action invoked: ${actionId}`,
    );
    if (outcome.kind !== "emitted") return outcome;

    // Slack-side follow-through, best-effort after the durable emit.
    if (actionId === "acknowledge") {
      const channelId = str(channel.id);
      const threadTs = str(message.ts);
      if (channelId && threadTs) {
        const botToken = await decryptBotToken(ctx, connection.value.id);
        if (botToken) {
          await postJson(
            "https://slack.com/api/chat.postMessage",
            {
              channel: channelId,
              thread_ts: threadTs,
              text: `Acknowledged by <@${invokedBy ?? "unknown"}>.`,
            },
            botToken,
          );
        }
      }
    } else {
      const responseUrl = str(payload.response_url);
      if (responseUrl) {
        await postJson(responseUrl, {
          response_type: "ephemeral",
          replace_original: false,
          text: "Rule muted for 1 hour.",
        });
      }
    }
    return outcome;
  }

  // link_shared unfurls and everything else in the subscribed set land later
  // (design §4.3 names them; the inbox keeps the rows for replay when they do).
  return markSkipped(ctx, delivery, "unsupported_event", {
    orgId: connection.value.orgId,
    connectionId: connection.value.id,
  });
}
