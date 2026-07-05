import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";
import type { NotificationsResult } from "./types.js";

// ---------------------------------------------------------------------------
// Notification channels storage (saas-event-streaming ES3): per-org delivery
// channel config with an encrypted bearer credential. The ciphertext is
// write-only — the safe read shape (StoredNotificationChannel) deliberately
// omits it, exactly as webhooks does for endpoint secrets. Only the internal
// send path reads it via getChannelConfigForSend.
// ---------------------------------------------------------------------------

export type NotificationChannelKind = "slack_incoming_webhook";
export type NotificationChannelStatus = "active" | "disabled";

/** Safe channel projection — never carries config_ciphertext. */
export interface StoredNotificationChannel {
  id: string;
  orgId: string;
  kind: NotificationChannelKind;
  name: string;
  status: NotificationChannelStatus;
  lastVerifiedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Send-path projection — the only shape that exposes the ciphertext. */
export interface NotificationChannelConfigForSend {
  id: string;
  orgId: string;
  kind: NotificationChannelKind;
  status: NotificationChannelStatus;
  configCiphertext: string;
}

export interface CreateNotificationChannelInput {
  id: string;
  orgId: Uuid;
  kind: NotificationChannelKind;
  name: string;
  configCiphertext: string;
  createdBy: Uuid;
}

export interface UpdateNotificationChannelPatch {
  name?: string;
  status?: NotificationChannelStatus;
  /** Rotate the encrypted config; omit to leave it untouched. */
  configCiphertext?: string;
  /** Stamp a successful verify (test send). */
  lastVerifiedAt?: Date;
}

export interface NotificationChannelsRepository {
  createChannel(
    input: CreateNotificationChannelInput,
  ): Promise<NotificationsResult<StoredNotificationChannel>>;
  getChannel(orgId: Uuid, id: string): Promise<NotificationsResult<StoredNotificationChannel | null>>;
  /** Send-path read: exposes the ciphertext. Not for any CRUD response. */
  getChannelConfigForSend(
    orgId: Uuid,
    id: string,
  ): Promise<NotificationsResult<NotificationChannelConfigForSend | null>>;
  listChannels(orgId: Uuid): Promise<NotificationsResult<StoredNotificationChannel[]>>;
  countChannels(orgId: Uuid): Promise<NotificationsResult<number>>;
  updateChannel(
    orgId: Uuid,
    id: string,
    patch: UpdateNotificationChannelPatch,
  ): Promise<NotificationsResult<StoredNotificationChannel | null>>;
  deleteChannel(orgId: Uuid, id: string): Promise<NotificationsResult<boolean>>;
}

// ---------------------------------------------------------------------------
// Mappers / helpers
// ---------------------------------------------------------------------------

function mapChannel(row: Record<string, unknown>): StoredNotificationChannel {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    kind: row.kind as NotificationChannelKind,
    name: row.name as string,
    status: row.status as NotificationChannelStatus,
    lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at as string) : null,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

function safeError(message: string): NotificationsResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNotificationChannelsRepository(
  executor: SqlExecutor,
): NotificationChannelsRepository {
  return {
    async createChannel(input) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO notifications.notification_channels (
             id, org_id, kind, name, config_ciphertext, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, org_id, kind, name, status, last_verified_at, created_by, created_at, updated_at`,
          [input.id, input.orgId, input.kind, input.name, input.configCiphertext, input.createdBy],
        );
        return { ok: true, value: mapChannel(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "notification_channel" } };
        }
        return safeError("Failed to create notification channel");
      }
    },

    async getChannel(orgId, id) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, kind, name, status, last_verified_at, created_by, created_at, updated_at
           FROM notifications.notification_channels
           WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        return { ok: true, value: result.rows.length ? mapChannel(result.rows[0]!) : null };
      } catch {
        return safeError("Failed to read notification channel");
      }
    },

    async getChannelConfigForSend(orgId, id) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, kind, status, config_ciphertext
           FROM notifications.notification_channels
           WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        if (result.rows.length === 0) return { ok: true, value: null };
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            id: row.id as string,
            orgId: row.org_id as string,
            kind: row.kind as NotificationChannelKind,
            status: row.status as NotificationChannelStatus,
            configCiphertext: row.config_ciphertext as string,
          },
        };
      } catch {
        return safeError("Failed to read notification channel config");
      }
    },

    async listChannels(orgId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, kind, name, status, last_verified_at, created_by, created_at, updated_at
           FROM notifications.notification_channels
           WHERE org_id = $1
           ORDER BY created_at DESC, id DESC`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapChannel) };
      } catch {
        return safeError("Failed to list notification channels");
      }
    },

    async countChannels(orgId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT count(*)::int AS total FROM notifications.notification_channels WHERE org_id = $1`,
          [orgId],
        );
        return { ok: true, value: (result.rows[0]?.total as number) ?? 0 };
      } catch {
        return safeError("Failed to count notification channels");
      }
    },

    async updateChannel(orgId, id, patch) {
      try {
        const sets: string[] = [];
        const values: unknown[] = [orgId, id];
        const push = (fragment: string, value: unknown) => {
          values.push(value);
          sets.push(`${fragment} = $${values.length}`);
        };
        if (patch.name !== undefined) push("name", patch.name);
        if (patch.status !== undefined) push("status", patch.status);
        if (patch.configCiphertext !== undefined) push("config_ciphertext", patch.configCiphertext);
        if (patch.lastVerifiedAt !== undefined) push("last_verified_at", patch.lastVerifiedAt.toISOString());
        if (sets.length === 0) {
          const current = await executor.execute<Record<string, unknown>>(
            `SELECT id, org_id, kind, name, status, last_verified_at, created_by, created_at, updated_at
             FROM notifications.notification_channels WHERE org_id = $1 AND id = $2`,
            [orgId, id],
          );
          return { ok: true, value: current.rows.length ? mapChannel(current.rows[0]!) : null };
        }
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE notifications.notification_channels
           SET ${sets.join(", ")}, updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING id, org_id, kind, name, status, last_verified_at, created_by, created_at, updated_at`,
          values,
        );
        return { ok: true, value: result.rows.length ? mapChannel(result.rows[0]!) : null };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "notification_channel" } };
        }
        return safeError("Failed to update notification channel");
      }
    },

    async deleteChannel(orgId, id) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM notifications.notification_channels WHERE org_id = $1 AND id = $2 RETURNING id`,
          [orgId, id],
        );
        return { ok: true, value: result.rows.length > 0 };
      } catch {
        return safeError("Failed to delete notification channel");
      }
    },
  };
}
