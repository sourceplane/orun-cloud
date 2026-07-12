/**
 * Notifications V1 contract.
 *
 * Owner: apps/notifications-worker (bounded context: notifications).
 * Spec: specs/components/14-notifications.md.
 *
 * The contract intentionally exposes a tiny, internal-only surface:
 *
 *   - enqueue a transactional notification (the only V1 send shape),
 *   - read / update preferences for a user or organization,
 *   - read delivery status for a specific notification,
 *   - suppress further delivery to a recipient.
 *
 * Provider-specific identifiers and payloads MUST stay behind the
 * NotificationProvider adapter and MUST NOT leak through these types.
 * No secret material (tokens, magic-link codes, raw provider responses)
 * may travel on these shapes — call sites should pass a `templateKey`
 * and a bounded, redaction-safe `templateData` map only.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Notification channels that may carry a transactional notification.
 *
 * V1 shipped email only; saas-event-streaming ES3 adds `slack` (delivered via
 * a configured incoming-webhook channel). Further channels (sms, push,
 * in-app) can be added without breaking the contract.
 */
export type NotificationChannel = "email" | "slack";

/**
 * Configured delivery-channel kinds (ES3). A channel row holds an encrypted
 * config: `slack_incoming_webhook` stores a bearer webhook URL; `slack_app`
 * (saas-integration-hub IH2) stores a REFERENCE — `{connectionId,
 * channelExternalId, channelName}` — never a credential; the bot token stays
 * in integrations-worker custody and is fetched per send over the internal
 * service binding.
 */
export type NotificationChannelKind = "slack_incoming_webhook" | "slack_app";

/**
 * High-level routing category. Used for preferences and audit categorisation.
 * Mirrors the categories called out by spec 14 (invitation / billing /
 * security / support / product).
 */
export type NotificationCategory =
  | "invitation"
  | "billing"
  | "security"
  | "support"
  | "product";

/** Delivery lifecycle for a single notification record. */
export type NotificationStatus =
  | "queued"
  | "sent"
  | "failed"
  | "suppressed";

/**
 * Preference subject kind. A preference row is keyed either to a user
 * (e.g. user-level opt-out of product email) or an organization
 * (org-wide billing recipient overrides).
 */
export type NotificationSubjectKind = "user" | "organization";

// ---------------------------------------------------------------------------
// Recipient
// ---------------------------------------------------------------------------

/**
 * Recipient of a transactional notification.
 *
 * For V1 the only supported channel is email, so `address` is the canonical
 * lower-cased email address. `subjectKind` + `subjectId` are optional and
 * let the worker join back to the preference / suppression rows; when
 * omitted, preferences are not consulted (system-level notifications).
 */
export interface NotificationRecipient {
  channel: NotificationChannel;
  address: string;
  subjectKind?: NotificationSubjectKind;
  subjectId?: string;
}

// ---------------------------------------------------------------------------
// Enqueue request / response
// ---------------------------------------------------------------------------

/**
 * Request shape for POST /v1/notifications.
 *
 * `templateKey` is a stable, code-controlled identifier owned by the calling
 * worker (e.g. "invitation.created", "billing.receipt"). `templateData`
 * carries strictly redaction-safe substitutions — no tokens, no magic-link
 * codes, no API keys. The notifications worker is responsible for any
 * provider-side substitution; callers MUST NOT inline secret material.
 */
export interface EnqueueNotificationRequest {
  orgId: string;
  category: NotificationCategory;
  templateKey: string;
  templateData?: Record<string, string | number | boolean | null>;
  recipient: NotificationRecipient;
  /** Optional caller-provided idempotency key (must be unique per orgId). */
  idempotencyKey?: string;
  /** Optional correlation id for tracing back to the originating request. */
  correlationId?: string;
}

/** Single delivery attempt entry as seen at the API boundary. */
export interface NotificationAttempt {
  id: string;
  notificationId: string;
  attemptNumber: number;
  status: NotificationStatus;
  attemptedAt: string;
  /** Bounded error reason — never a raw provider payload. */
  errorReason: string | null;
}

/**
 * Public delivery-status shape for a single notification.
 *
 * The `providerMessageId` field is an opaque, provider-issued reference
 * returned by the adapter. It is exposed for operator traceability only
 * and must never contain credential material.
 */
export interface NotificationDeliveryStatus {
  id: string;
  orgId: string;
  category: NotificationCategory;
  templateKey: string;
  status: NotificationStatus;
  recipient: {
    channel: NotificationChannel;
    /** Lower-cased recipient address (e.g. email). */
    address: string;
  };
  providerMessageId: string | null;
  queuedAt: string;
  sentAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  attempts: NotificationAttempt[];
}

/** Response shape for POST /v1/notifications. */
export interface EnqueueNotificationResponse {
  notification: NotificationDeliveryStatus;
}

/** Response shape for GET /v1/notifications/:notificationId. */
export interface GetNotificationResponse {
  notification: NotificationDeliveryStatus;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/**
 * Per-category preference toggles.
 *
 * `null` means "not configured" — call sites should treat that as the
 * default (opt-in) for transactional categories. Marketing-style categories
 * are deliberately out-of-scope for V1.
 */
export interface NotificationCategoryPreferences {
  invitation?: boolean | null;
  billing?: boolean | null;
  security?: boolean | null;
  support?: boolean | null;
  product?: boolean | null;
}

export interface NotificationPreference {
  subjectKind: NotificationSubjectKind;
  subjectId: string;
  orgId: string;
  channel: NotificationChannel;
  categories: NotificationCategoryPreferences;
  updatedAt: string;
}

export interface GetNotificationPreferencesQuery {
  orgId: string;
  subjectKind: NotificationSubjectKind;
  subjectId: string;
  channel?: NotificationChannel;
}

export interface UpdateNotificationPreferencesRequest {
  orgId: string;
  subjectKind: NotificationSubjectKind;
  subjectId: string;
  channel: NotificationChannel;
  categories: NotificationCategoryPreferences;
}

export interface GetNotificationPreferencesResponse {
  preferences: NotificationPreference[];
}

export interface UpdateNotificationPreferencesResponse {
  preference: NotificationPreference;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

export type NotificationSuppressionReason =
  | "bounce"
  | "complaint"
  | "manual"
  | "unsubscribe";

export interface NotificationSuppression {
  orgId: string;
  channel: NotificationChannel;
  address: string;
  reason: NotificationSuppressionReason;
  createdAt: string;
}

export interface SuppressRecipientRequest {
  orgId: string;
  channel: NotificationChannel;
  reason: NotificationSuppressionReason;
}

export interface SuppressRecipientResponse {
  suppression: NotificationSuppression;
}

// ---------------------------------------------------------------------------
// Provider adapter seam
// ---------------------------------------------------------------------------

/**
 * Bounded send context handed to a NotificationProvider implementation.
 *
 * Implementations MUST NOT receive raw secret material here. Provider-side
 * credentials are pulled from the provider's own configuration (Secrets
 * Store binding for stage/prod, no-op for local-debug).
 */
export interface ProviderSendContext {
  notificationId: string;
  orgId: string;
  category: NotificationCategory;
  templateKey: string;
  templateData: Record<string, string | number | boolean | null>;
  recipient: NotificationRecipient;
}

/**
 * Result returned by a NotificationProvider after attempting a send.
 *
 * `providerMessageId` is the opaque id the provider issued for the message
 * (used purely for operator traceability). `errorReason` is a bounded
 * human-readable string — implementations MUST scrub any provider-specific
 * payload, credential, or token from this field.
 */
export type ProviderSendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; providerMessageId: string | null; errorReason: string };

/**
 * Provider extraction seam.
 *
 * V1 has exactly one implementation (local-debug) which records the
 * would-be send into the delivery table without contacting an external
 * service. A follow-up task will add a Resend / Postmark / SES adapter
 * behind this interface without touching any call site.
 */
export interface NotificationProvider {
  /** Stable identifier (e.g. "local-debug", "resend", "postmark"). */
  readonly name: string;
  send(ctx: ProviderSendContext): Promise<ProviderSendResult>;
}

// ---------------------------------------------------------------------------
// Internal service-binding contract sentinel
// ---------------------------------------------------------------------------

/**
 * Header sentinels for the internal-only V1 surface.
 *
 * The notifications worker MUST reject requests that arrive without these
 * headers — there is no public api-edge facade in V1. See spec 14
 * "Extraction Seam".
 */
export const NOTIFICATIONS_INTERNAL_ACTOR_HEADER = "x-internal-actor";
export const NOTIFICATIONS_INTERNAL_ACTOR_VALUES = [
  "identity-worker",
  "membership-worker",
  "billing-worker",
  "webhooks-worker",
  "events-worker",
  "policy-worker",
  "projects-worker",
  "config-worker",
  "metering-worker",
  "notifications-worker",
  // The public edge forwards end-user preference reads/updates over the
  // service binding with the subject pinned to the resolved session actor.
  "api-edge",
] as const;

export type NotificationsInternalActor =
  (typeof NOTIFICATIONS_INTERNAL_ACTOR_VALUES)[number];

// ---------------------------------------------------------------------------
// Audit event types
// ---------------------------------------------------------------------------

/**
 * Event type strings emitted on the events seam.
 *
 * Bodies MUST contain zero secret material — templateData substitutions
 * are deliberately not included in the envelope. Subscribers see only
 * non-secret routing metadata (orgId, category, templateKey, recipient
 * channel, recipient address).
 */
export const NOTIFICATION_EVENT_TYPES = {
  QUEUED: "notification.queued",
  SENT: "notification.sent",
  FAILED: "notification.failed",
  PREFERENCE_UPDATED: "notification.preference_updated",
  SUPPRESSED: "notification.suppressed",
} as const;

export type NotificationEventType =
  (typeof NOTIFICATION_EVENT_TYPES)[keyof typeof NOTIFICATION_EVENT_TYPES];

// ---------------------------------------------------------------------------
// Notification rules (saas-event-streaming ES2) — served by events-worker,
// forwarded through the api-edge notification-rules facade.
// ---------------------------------------------------------------------------

/** Rule lifecycle. A disabled rule matches nothing until re-enabled. */
export type NotificationRuleStatus = "enabled" | "disabled";

/** Delivery target kind attached to a rule. */
export type NotificationRuleTargetKind = "email" | "slack_channel";

/** Comparison operator for a rule attribute filter. */
export type NotificationRuleFilterOp = "eq" | "neq" | "in";

/**
 * A payload-attribute predicate (`{path, op, value}`). `path` is a dotted
 * payload path; `value` is a scalar (or an array of scalars for `in`).
 */
export interface NotificationRuleAttributeFilter {
  path: string;
  op: NotificationRuleFilterOp;
  value: unknown;
}

/** A single delivery target as seen at the API boundary (`toPublicTarget`). */
export interface PublicNotificationRuleTarget {
  id: string;
  kind: string;
  ref: string;
  enabled: boolean;
  createdAt: string;
}

/**
 * A notification rule as seen at the API boundary (`toPublicRule`). Internal
 * org/project UUIDs are projected to their public forms; `targets` is present
 * on single-rule reads and on list responses.
 */
export interface PublicNotificationRule {
  id: string;
  orgId: string;
  projectId: string | null;
  name: string;
  status: NotificationRuleStatus;
  eventTypes: string[];
  minSeverity: string;
  sources: string[] | null;
  attributeFilters: NotificationRuleAttributeFilter[] | null;
  throttleWindowSeconds: number;
  throttleMax: number;
  createdAt: string;
  updatedAt: string;
  targets?: PublicNotificationRuleTarget[];
}

/** A rule delivery target in a create/update request body. */
export interface NotificationRuleTargetInput {
  kind: NotificationRuleTargetKind;
  ref: string;
}

/** Request body for POST …/notification-rules. */
export interface CreateNotificationRuleRequest {
  name: string;
  projectId?: string | null;
  eventTypes: string[];
  minSeverity?: string;
  sources?: string[] | null;
  attributeFilters?: NotificationRuleAttributeFilter[] | null;
  throttleWindowSeconds?: number;
  throttleMax?: number;
  targets?: NotificationRuleTargetInput[];
}

/** Request body for PATCH …/notification-rules/:ruleId (all fields optional). */
export interface UpdateNotificationRuleRequest {
  name?: string;
  status?: NotificationRuleStatus;
  projectId?: string | null;
  eventTypes?: string[];
  minSeverity?: string;
  sources?: string[] | null;
  attributeFilters?: NotificationRuleAttributeFilter[] | null;
  throttleWindowSeconds?: number;
  throttleMax?: number;
}

/** Request body for POST …/notification-rules/:ruleId/test. */
export interface TestNotificationRuleRequest {
  type: string;
  source?: string;
  severity?: string;
  projectId?: string;
  payload?: Record<string, unknown>;
}

export interface ListNotificationRulesResponse {
  data: { notificationRules: PublicNotificationRule[] };
  meta: { requestId: string; cursor: string | null };
}

export interface GetNotificationRuleResponse {
  data: { notificationRule: PublicNotificationRule };
  meta: { requestId: string };
}

export interface CreateNotificationRuleResponse {
  data: { notificationRule: PublicNotificationRule };
  meta: { requestId: string };
}

export interface UpdateNotificationRuleResponse {
  data: { notificationRule: PublicNotificationRule };
  meta: { requestId: string };
}

export interface DeleteNotificationRuleResponse {
  data: { deleted: true };
  meta: { requestId: string };
}

/** Response for the dry-run test-fire endpoint (never sends anything). */
export interface TestNotificationRuleResponse {
  data: {
    matched: boolean;
    ruleStatus: NotificationRuleStatus;
    matchedTargets: PublicNotificationRuleTarget[];
  };
  meta: { requestId: string };
}

// ---------------------------------------------------------------------------
// Notification channels (saas-event-streaming ES3) — served by
// notifications-worker, forwarded through the api-edge notification-channels
// facade. The channel config (Slack webhook URL / ciphertext) is WRITE-ONLY:
// it is never returned on a read, so the public shapes below deliberately omit
// it.
// ---------------------------------------------------------------------------

/**
 * A configured delivery channel as seen at the API boundary
 * (`toPublicChannel`). NOTE: no `webhookUrl` / `config_ciphertext` — the
 * secret is write-only and never echoed back.
 */
export interface PublicNotificationChannel {
  id: string;
  orgId: string;
  kind: string;
  name: string;
  status: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Request body for POST …/notification-channels. `webhookUrl` is write-only
 * and required for `slack_incoming_webhook` (the default kind); the three
 * connection-reference fields are required for `slack_app` instead.
 */
export interface CreateNotificationChannelRequest {
  name: string;
  kind?: NotificationChannelKind;
  webhookUrl?: string;
  /** slack_app: public connection id (`int_…`) the channel posts through. */
  connectionId?: string;
  /** slack_app: Slack channel id (e.g. `C0123ABCDEF`) from the picker. */
  channelExternalId?: string;
  /** slack_app: human channel name at pick time (display only). */
  channelName?: string;
}

/** Request body for PATCH …/notification-channels/:channelId. */
export interface UpdateNotificationChannelRequest {
  name?: string;
  status?: "active" | "disabled";
  webhookUrl?: string;
}

export interface ListNotificationChannelsResponse {
  data: { notificationChannels: PublicNotificationChannel[] };
  meta: { requestId: string };
}

export interface CreateNotificationChannelResponse {
  data: { notificationChannel: PublicNotificationChannel };
  meta: { requestId: string };
}

export interface UpdateNotificationChannelResponse {
  data: { notificationChannel: PublicNotificationChannel };
  meta: { requestId: string };
}

export interface DeleteNotificationChannelResponse {
  data: { deleted: true };
  meta: { requestId: string };
}

/** Response for the channel test-send endpoint. */
export interface TestNotificationChannelResponse {
  data: { verified: true };
  meta: { requestId: string };
}
