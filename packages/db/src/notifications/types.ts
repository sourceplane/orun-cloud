export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type NotificationsRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "suppressed" }
  | { kind: "internal"; message: string };

export type NotificationsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: NotificationsRepositoryError };

// ---------------------------------------------------------------------------
// Domain types (transport-safe; no platform clients leak through)
// ---------------------------------------------------------------------------

export interface StoredNotification {
  id: string;
  orgId: string;
  category: string;
  templateKey: string;
  templateData: Record<string, unknown>;
  channel: string;
  recipientAddress: string;
  recipientSubjectKind: string | null;
  recipientSubjectId: string | null;
  status: string;
  providerMessageId: string | null;
  lastError: string | null;
  idempotencyKey: string | null;
  correlationId: string | null;
  queuedAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  updatedAt: Date;
  /** Retry-drain schedule (ES3): set when status='failed' and retries remain. */
  nextRetryAt: Date | null;
  /** Monotone attempt counter across the synchronous send + async retries. */
  attemptCount: number;
}

export interface StoredNotificationAttempt {
  id: string;
  notificationId: string;
  orgId: string;
  attemptNumber: number;
  status: string;
  providerMessageId: string | null;
  errorReason: string | null;
  attemptedAt: Date;
}

export interface StoredNotificationPreference {
  id: string;
  orgId: string;
  subjectKind: string;
  subjectId: string;
  channel: string;
  categories: Record<string, boolean | null>;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredNotificationSuppression {
  id: string;
  orgId: string;
  channel: string;
  address: string;
  reason: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateNotificationInput {
  id: string;
  orgId: Uuid;
  category: string;
  templateKey: string;
  templateData: Record<string, unknown>;
  channel: string;
  recipientAddress: string;
  recipientSubjectKind?: string | null;
  recipientSubjectId?: string | null;
  status: string;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  queuedAt: Date;
}

export interface CreateNotificationAttemptInput {
  id: string;
  notificationId: string;
  orgId: string;
  attemptNumber: number;
  status: string;
  providerMessageId?: string | null;
  errorReason?: string | null;
  attemptedAt: Date;
}

export interface MarkNotificationStatusInput {
  id: string;
  orgId: string;
  status: string;
  providerMessageId?: string | null;
  lastError?: string | null;
  sentAt?: Date | null;
  failedAt?: Date | null;
  updatedAt: Date;
  /**
   * Retry schedule (ES3). Pass a Date to schedule a retry, or `null` to clear
   * it (terminal success or exhausted retries). Omit (`undefined`) to leave
   * the existing value untouched.
   */
  nextRetryAt?: Date | null;
  /** New absolute attempt count; omit to leave untouched. */
  attemptCount?: number;
}

export interface UpsertNotificationPreferenceInput {
  id: string;
  orgId: Uuid;
  subjectKind: string;
  subjectId: string;
  channel: string;
  categories: Record<string, boolean | null>;
  updatedAt: Date;
}

export interface CreateNotificationSuppressionInput {
  id: string;
  orgId: Uuid;
  channel: string;
  address: string;
  reason: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface NotificationsRepository {
  createNotification(
    input: CreateNotificationInput,
  ): Promise<NotificationsResult<StoredNotification>>;
  getNotificationById(
    id: string,
  ): Promise<NotificationsResult<StoredNotification>>;
  findNotificationByIdempotencyKey(
    orgId: Uuid,
    idempotencyKey: string,
  ): Promise<NotificationsResult<StoredNotification>>;
  markNotificationStatus(
    input: MarkNotificationStatusInput,
  ): Promise<NotificationsResult<StoredNotification>>;

  recordAttempt(
    input: CreateNotificationAttemptInput,
  ): Promise<NotificationsResult<StoredNotificationAttempt>>;
  listAttempts(
    notificationId: string,
  ): Promise<NotificationsResult<StoredNotificationAttempt[]>>;

  listPreferences(
    orgId: Uuid,
    subjectKind: string,
    subjectId: string,
    channel: string | null,
  ): Promise<NotificationsResult<StoredNotificationPreference[]>>;
  upsertPreference(
    input: UpsertNotificationPreferenceInput,
  ): Promise<NotificationsResult<StoredNotificationPreference>>;

  isSuppressed(
    orgId: Uuid,
    channel: string,
    address: string,
  ): Promise<NotificationsResult<boolean>>;
  createSuppression(
    input: CreateNotificationSuppressionInput,
  ): Promise<NotificationsResult<StoredNotificationSuppression>>;

  /**
   * Failed notifications whose retry is due (status='failed', next_retry_at
   * set and in the past), oldest-due first — the async retry cron's drain
   * query (ES3). Mirrors the webhooks listRetryableDeliveries pattern.
   */
  listRetryableNotifications(
    limit: number,
  ): Promise<NotificationsResult<StoredNotification[]>>;
}
