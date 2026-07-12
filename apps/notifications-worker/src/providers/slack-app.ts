import type {
  NotificationProvider,
  ProviderSendContext,
  ProviderSendResult,
} from "@saas/contracts/notifications";
import type { SlackGroupMessagesRepository } from "@saas/db/notifications";
import { buildSlackMessage } from "./slack-webhook.js";

/**
 * Slack App (bot) provider — the slack_app channel kind (saas-integration-hub
 * IH2, design §4.2). Where the incoming-webhook provider append-posts, this
 * one gives an event GROUP a single message identity:
 *
 *   first fire per (channel, group)  → chat.postMessage, record {channel, ts}
 *   subsequent group fires           → chat.update of that message in place
 *   severity escalation              → …plus a thread reply under it
 *
 * The bot token arrives per send from integrations-worker custody and lives
 * in this isolate's memory only — never persisted, never logged (the reason
 * every error reason below is a bounded, non-secret token). Non-grouped
 * notifications (no groupKey in templateData) post normally.
 */

export interface SlackAppProviderOptions {
  /** Decrypted workspace bot token. Never logged. */
  botToken: string;
  /** Slack channel id (C…/G…) the notification channel is bound to. */
  channelExternalId: string;
  /** notification_channels row id — the group-message store key. */
  channelRowId: string;
  /** Event-group ↔ message identity store; absent ⇒ every send posts fresh. */
  groupsRepo?: SlackGroupMessagesRepository | undefined;
  consoleBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

interface SlackApiResult {
  ok: boolean;
  ts: string | null;
  channel: string | null;
  /** Slack's bounded error token (e.g. `channel_not_found`) — non-secret. */
  error: string | null;
}

async function slackCall(
  doFetch: typeof fetch,
  botToken: string,
  method: "chat.postMessage" | "chat.update",
  body: Record<string, unknown>,
): Promise<SlackApiResult> {
  try {
    const response = await doFetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { ok: false, ts: null, channel: null, error: `http_${response.status}` };
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      ok: payload.ok === true,
      ts: typeof payload.ts === "string" ? payload.ts : null,
      channel: typeof payload.channel === "string" ? payload.channel : null,
      error: typeof payload.error === "string" ? payload.error : null,
    };
  } catch {
    return { ok: false, ts: null, channel: null, error: "network_error" };
  }
}

/** Slack block-action ids for notification buttons (IH3, design §4.3). */
export const SLACK_ACTION_ACKNOWLEDGE = "orun_ack";
export const SLACK_ACTION_MUTE_RULE = "orun_mute";

/**
 * Append the IH3 action buttons to a GROUPED story message (design §4.3):
 * "Acknowledge" (value = the notification public id) and — only when the
 * rules lane put a rule public id on templateData — "Mute rule 1h" (value =
 * that rule id, handed back verbatim by the interactivity drain as
 * messaging.action.invoked). The block rides the severity-colored attachment
 * so chat.postMessage and chat.update both carry it; the escalation thread
 * reply overrides `blocks`/`attachments` and stays button-less. Non-grouped
 * sends never call this — they stay webhook-equivalent.
 */
function appendActionButtons(message: Record<string, unknown>, ctx: ProviderSendContext): void {
  const elements: Array<Record<string, unknown>> = [
    {
      type: "button",
      text: { type: "plain_text", text: "Acknowledge" },
      action_id: SLACK_ACTION_ACKNOWLEDGE,
      value: ctx.notificationId,
    },
  ];
  const ruleId = ctx.templateData.ruleId;
  if (typeof ruleId === "string" && ruleId) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Mute rule 1h" },
      action_id: SLACK_ACTION_MUTE_RULE,
      value: ruleId,
    });
  }
  const attachments = message.attachments as
    | Array<{ blocks?: Array<Record<string, unknown>> }>
    | undefined;
  attachments?.[0]?.blocks?.push({ type: "actions", elements });
}

function failure(error: string | null): ProviderSendResult {
  return { ok: false, providerMessageId: null, errorReason: `slack_api_${error ?? "unknown"}` };
}

function success(channel: string | null, ts: string | null): ProviderSendResult {
  return { ok: true, providerMessageId: `slack:${channel ?? "?"}:${ts ?? "?"}` };
}

export function createSlackAppProvider(opts: SlackAppProviderOptions): NotificationProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name: "slack-app",
    async send(ctx: ProviderSendContext): Promise<ProviderSendResult> {
      const message = buildSlackMessage(ctx.templateData, opts.consoleBaseUrl);
      const groupKey =
        typeof ctx.templateData.groupKey === "string" && ctx.templateData.groupKey
          ? ctx.templateData.groupKey
          : null;
      const escalation = ctx.templateData.escalation === true;
      const severity =
        typeof ctx.templateData.severity === "string" ? ctx.templateData.severity : null;

      // Grouped story messages carry the IH3 action buttons; plain posts do
      // not (a non-grouped notification has no story to act on).
      if (groupKey) appendActionButtons(message, ctx);

      const post = (extra?: Record<string, unknown>) =>
        slackCall(doFetch, opts.botToken, "chat.postMessage", {
          channel: opts.channelExternalId,
          ...message,
          ...(extra ?? {}),
        });

      // Non-grouped (or store unavailable): plain post, webhook-equivalent.
      if (!groupKey || !opts.groupsRepo) {
        const posted = await post();
        return posted.ok ? success(posted.channel, posted.ts) : failure(posted.error);
      }

      const existing = await opts.groupsRepo.get(opts.channelRowId, groupKey);
      const root = existing.ok ? existing.value : null;

      if (!root) {
        // The story's first message. Record its coordinates best-effort — a
        // failed record degrades the NEXT fire to a fresh post, never this one.
        const posted = await post();
        if (!posted.ok) return failure(posted.error);
        if (posted.ts) {
          await opts.groupsRepo.upsert({
            channelId: opts.channelRowId,
            groupKey,
            slackChannel: posted.channel ?? opts.channelExternalId,
            slackTs: posted.ts,
            lastSeverity: severity,
          });
        }
        return success(posted.channel, posted.ts);
      }

      // The story already has a message: edit it in place.
      let rootChannel = root.slackChannel;
      let rootTs = root.slackTs;
      const updated = await slackCall(doFetch, opts.botToken, "chat.update", {
        channel: rootChannel,
        ts: rootTs,
        ...message,
      });
      if (!updated.ok) {
        // The root message is gone (deleted / channel pruned): post a fresh
        // root and repoint the story at it. Any other error retries normally.
        if (updated.error !== "message_not_found") return failure(updated.error);
        const reposted = await post();
        if (!reposted.ok) return failure(reposted.error);
        rootChannel = reposted.channel ?? opts.channelExternalId;
        rootTs = reposted.ts ?? rootTs;
        if (reposted.ts) {
          await opts.groupsRepo.upsert({
            channelId: opts.channelRowId,
            groupKey,
            slackChannel: rootChannel,
            slackTs: reposted.ts,
            lastSeverity: severity,
            replaceTs: true,
          });
        }
        return success(rootChannel, rootTs);
      }

      if (escalation) {
        // The visible half of the escalation: a thread reply under the story.
        // The root edit above already carries the new severity; a failed
        // reply must not fail the delivery.
        const title =
          typeof ctx.templateData.title === "string" && ctx.templateData.title
            ? ctx.templateData.title
            : "This story";
        await post({
          thread_ts: rootTs,
          text: `Severity escalated${severity ? ` to ${severity}` : ""}: ${title}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:warning: Severity escalated${severity ? ` to *${severity}*` : ""}.`,
              },
            },
          ],
          attachments: [],
        });
      }

      await opts.groupsRepo.upsert({
        channelId: opts.channelRowId,
        groupKey,
        slackChannel: rootChannel,
        slackTs: rootTs,
        lastSeverity: severity,
      });
      return success(rootChannel, rootTs);
    },
  };
}
