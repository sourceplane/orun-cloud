import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { NotificationsResult } from "./types.js";

// ---------------------------------------------------------------------------
// Event-group ↔ Slack message identity (saas-integration-hub IH2, design
// §4.2): behind a slack_app channel, the first post per (channel, group)
// records the root message's Slack coordinates; subsequent group fires edit
// that message in place (chat.update) plus a thread reply on severity
// escalation. Rows carry coordinates only — never message content, never
// credentials.
// ---------------------------------------------------------------------------

export interface SlackGroupMessage {
  channelId: string;
  groupKey: string;
  slackChannel: string;
  slackTs: string;
  lastSeverity: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertSlackGroupMessageInput {
  channelId: string;
  groupKey: string;
  slackChannel: string;
  slackTs: string;
  lastSeverity?: string | null;
  /**
   * By default an existing row keeps its root ts (the story keeps editing one
   * message). Set true only when the root message is gone provider-side
   * (chat.update said message_not_found) and a fresh root was posted.
   */
  replaceTs?: boolean;
}

export interface SlackGroupMessagesRepository {
  get(channelId: string, groupKey: string): Promise<NotificationsResult<SlackGroupMessage | null>>;
  upsert(input: UpsertSlackGroupMessageInput): Promise<NotificationsResult<SlackGroupMessage>>;
}

function safeError(message: string): NotificationsResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

function mapRow(row: Record<string, unknown>): SlackGroupMessage {
  return {
    channelId: row.channel_id as string,
    groupKey: row.group_key as string,
    slackChannel: row.slack_channel as string,
    slackTs: row.slack_ts as string,
    lastSeverity: (row.last_severity as string) ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at as string),
  };
}

export function createSlackGroupMessagesRepository(
  executor: SqlExecutor,
): SlackGroupMessagesRepository {
  return {
    async get(channelId, groupKey) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM notifications.slack_group_messages
           WHERE channel_id = $1 AND group_key = $2`,
          [channelId, groupKey],
        );
        const row = result.rows[0];
        return { ok: true, value: row ? mapRow(row) : null };
      } catch (err) {
        return safeError(`slack group message read failed: ${String(err)}`);
      }
    },

    async upsert(input) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO notifications.slack_group_messages
             (channel_id, group_key, slack_channel, slack_ts, last_severity)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (channel_id, group_key) DO UPDATE SET
             slack_channel = CASE WHEN $6 THEN EXCLUDED.slack_channel
               ELSE notifications.slack_group_messages.slack_channel END,
             slack_ts = CASE WHEN $6 THEN EXCLUDED.slack_ts
               ELSE notifications.slack_group_messages.slack_ts END,
             last_severity = EXCLUDED.last_severity,
             updated_at = now()
           RETURNING *`,
          [
            input.channelId,
            input.groupKey,
            input.slackChannel,
            input.slackTs,
            input.lastSeverity ?? null,
            input.replaceTs === true,
          ],
        );
        const row = result.rows[0];
        if (!row) return safeError("slack group message upsert returned no row");
        return { ok: true, value: mapRow(row) };
      } catch (err) {
        return safeError(`slack group message upsert failed: ${String(err)}`);
      }
    },
  };
}
