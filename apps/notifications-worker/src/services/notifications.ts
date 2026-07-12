import type {
  EnqueueNotificationRequest,
  EnqueueNotificationResponse,
  GetNotificationResponse,
  NotificationProvider,
  NotificationDeliveryStatus,
  NotificationAttempt,
} from "@saas/contracts/notifications";
import { NOTIFICATION_EVENT_TYPES } from "@saas/contracts/notifications";
import type {
  NotificationChannelsRepository,
  NotificationsRepository,
  SlackGroupMessagesRepository,
  StoredNotification,
  StoredNotificationAttempt,
} from "@saas/db/notifications";
import type { Env } from "../env.js";
import { notificationPublicId, parseNotificationPublicId, parseOrgIdInput } from "../ids.js";
import { emitEvent } from "../events-client.js";
import { deliverAttempt } from "./dispatch.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_CATEGORIES = new Set(["invitation", "billing", "security", "support", "product"]);

/**
 * Validation outcome returned by validateEnqueueRequest. The handler converts
 * `errors` straight into an HTTP 422 with the same `fields` shape used by the
 * rest of the workers.
 */
export interface ValidatedEnqueue {
  ok: boolean;
  errors: Record<string, string[]>;
  value?: EnqueueNotificationRequest;
}

export function validateEnqueueRequest(body: unknown): ValidatedEnqueue {
  const errors: Record<string, string[]> = {};
  if (!body || typeof body !== "object") {
    return { ok: false, errors: { _root: ["Body must be a JSON object"] } };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.orgId !== "string" || b.orgId.length === 0) {
    errors.orgId = ["Required"];
  }
  if (typeof b.category !== "string" || !ALLOWED_CATEGORIES.has(b.category)) {
    errors.category = ["Must be one of invitation, billing, security, support, product"];
  }
  if (typeof b.templateKey !== "string" || b.templateKey.length === 0 || b.templateKey.length > 200) {
    errors.templateKey = ["Required and must be 1-200 chars"];
  }
  const recipient = b.recipient as Record<string, unknown> | undefined;
  if (!recipient || typeof recipient !== "object") {
    errors.recipient = ["Required"];
  } else {
    // ES3: email (address = email) or slack (address = chan_<hex> channel id).
    if (recipient.channel !== "email" && recipient.channel !== "slack") {
      errors["recipient.channel"] = ['Must be "email" or "slack"'];
    } else if (recipient.channel === "email") {
      if (typeof recipient.address !== "string" || !EMAIL_RE.test(recipient.address)) {
        errors["recipient.address"] = ["Must be a valid email address"];
      }
    } else {
      // slack: address is the configured channel's public id.
      if (typeof recipient.address !== "string" || !/^chan_[0-9a-f]{32}$/.test(recipient.address)) {
        errors["recipient.address"] = ["Must be a notification channel id (chan_...)"];
      }
    }
    if (recipient.subjectKind !== undefined && recipient.subjectKind !== "user" && recipient.subjectKind !== "organization") {
      errors["recipient.subjectKind"] = ['Must be "user" or "organization"'];
    }
    if (recipient.subjectId !== undefined && typeof recipient.subjectId !== "string") {
      errors["recipient.subjectId"] = ["Must be a string"];
    }
  }
  if (b.templateData !== undefined) {
    if (b.templateData === null || typeof b.templateData !== "object" || Array.isArray(b.templateData)) {
      errors.templateData = ["Must be an object of string/number/boolean/null values"];
    } else {
      for (const [k, v] of Object.entries(b.templateData as Record<string, unknown>)) {
        if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
          errors[`templateData.${k}`] = ["Must be string, number, boolean, or null"];
        }
      }
    }
  }
  if (b.idempotencyKey !== undefined && (typeof b.idempotencyKey !== "string" || b.idempotencyKey.length === 0 || b.idempotencyKey.length > 200)) {
    errors.idempotencyKey = ["Must be a string 1-200 chars"];
  }
  if (b.correlationId !== undefined && (typeof b.correlationId !== "string" || b.correlationId.length === 0 || b.correlationId.length > 200)) {
    errors.correlationId = ["Must be a string 1-200 chars"];
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, errors, value: b as unknown as EnqueueNotificationRequest };
}

function toAttempt(a: StoredNotificationAttempt): NotificationAttempt {
  return {
    id: a.id,
    notificationId: notificationPublicId(a.notificationId),
    attemptNumber: a.attemptNumber,
    status: a.status as NotificationAttempt["status"],
    attemptedAt: a.attemptedAt.toISOString(),
    errorReason: a.errorReason,
  };
}

export function toDeliveryStatus(
  n: StoredNotification,
  attempts: StoredNotificationAttempt[],
): NotificationDeliveryStatus {
  return {
    id: notificationPublicId(n.id),
    orgId: n.orgId,
    category: n.category as NotificationDeliveryStatus["category"],
    templateKey: n.templateKey,
    status: n.status as NotificationDeliveryStatus["status"],
    recipient: {
      channel: n.channel as NotificationDeliveryStatus["recipient"]["channel"],
      address: n.recipientAddress,
    },
    providerMessageId: n.providerMessageId,
    queuedAt: n.queuedAt.toISOString(),
    sentAt: n.sentAt ? n.sentAt.toISOString() : null,
    failedAt: n.failedAt ? n.failedAt.toISOString() : null,
    lastError: n.lastError,
    attempts: attempts.map(toAttempt),
  };
}

/**
 * Pure-function dependencies for the notifications service. The router /
 * handlers inject these from env at request time; the tests inject fakes.
 */
export interface NotificationsServiceDeps {
  repo: NotificationsRepository;
  provider: NotificationProvider;
  env: Env;
  now?: (() => Date) | undefined;
  generateUuid?: (() => string) | undefined;
  emit?: typeof emitEvent | undefined;
  actorType: string;
  actorId: string;
  requestId: string;
  /** ES3: channel config store for slack delivery (undefined ⇒ slack disabled). */
  channelsRepo?: NotificationChannelsRepository | undefined;
  /** IH2: event-group ↔ Slack message identity store (slack_app chat.update). */
  slackGroupsRepo?: SlackGroupMessagesRepository | undefined;
  /** ES3: injectable fetch for the slack provider (tests). */
  fetchImpl?: typeof fetch | undefined;
}

export interface EnqueueOutcome {
  status: "created" | "idempotent_hit" | "suppressed";
  response: EnqueueNotificationResponse;
}

/**
 * Enqueue + (synchronously) attempt to send via the configured provider.
 *
 * V1 is intentionally request-time send: no Queues, no retry loop. The
 * `local-debug` provider always returns success, so the typical lifecycle is
 * queued -> sent within the same request.
 *
 * Suppression check runs BEFORE the row is created so we don't write any
 * dead rows for an already-suppressed recipient.
 */
export async function enqueueNotification(
  deps: NotificationsServiceDeps,
  request: EnqueueNotificationRequest,
): Promise<{ outcome: EnqueueOutcome } | { error: { code: string; status: number; message: string } }> {
  const { repo, provider } = deps;
  const now = deps.now ? deps.now() : new Date();
  const genUuid = deps.generateUuid ?? (() => crypto.randomUUID());
  const emit = deps.emit ?? emitEvent;

  // notifications.org_id is a UUID column; decode the incoming org id (public
  // `org_<hex>` form or a bare UUID) into a branded Uuid before any repo call.
  const orgUuid = parseOrgIdInput(request.orgId);
  if (!orgUuid) {
    return { error: { code: "validation_error", status: 422, message: "Invalid org id" } };
  }

  // Idempotency check.
  if (request.idempotencyKey) {
    const existing = await repo.findNotificationByIdempotencyKey(orgUuid, request.idempotencyKey);
    if (existing.ok) {
      const attempts = await repo.listAttempts(existing.value.id);
      return {
        outcome: {
          status: "idempotent_hit",
          response: {
            notification: toDeliveryStatus(existing.value, attempts.ok ? attempts.value : []),
          },
        },
      };
    }
  }

  // Suppression short-circuit.
  const suppressed = await repo.isSuppressed(orgUuid, request.recipient.channel, request.recipient.address);
  if (suppressed.ok && suppressed.value) {
    const id = genUuid();
    const create = await repo.createNotification({
      id,
      orgId: orgUuid,
      category: request.category,
      templateKey: request.templateKey,
      templateData: request.templateData ?? {},
      channel: request.recipient.channel,
      recipientAddress: request.recipient.address,
      recipientSubjectKind: request.recipient.subjectKind ?? null,
      recipientSubjectId: request.recipient.subjectId ?? null,
      status: "suppressed",
      idempotencyKey: request.idempotencyKey ?? null,
      correlationId: request.correlationId ?? null,
      queuedAt: now,
    });
    if (!create.ok) {
      return { error: { code: "internal_error", status: 500, message: "Failed to record suppressed notification" } };
    }
    await emit(deps.env, {
      type: NOTIFICATION_EVENT_TYPES.SUPPRESSED,
      notificationId: notificationPublicId(create.value.id),
      orgId: request.orgId,
      subjectKind: "notification",
      subjectId: notificationPublicId(create.value.id),
      actorType: deps.actorType,
      actorId: deps.actorId,
      requestId: deps.requestId,
      correlationId: request.correlationId ?? null,
      category: "notifications",
      description: `Notification ${notificationPublicId(create.value.id)} short-circuited by suppression`,
      payload: {
        orgId: request.orgId,
        category: request.category,
        templateKey: request.templateKey,
        recipient: { channel: request.recipient.channel, address: request.recipient.address },
      },
      occurredAt: now,
    });
    return {
      outcome: {
        status: "suppressed",
        response: { notification: toDeliveryStatus(create.value, []) },
      },
    };
  }

  // Create row in `queued` state.
  const id = genUuid();
  const created = await repo.createNotification({
    id,
    orgId: orgUuid,
    category: request.category,
    templateKey: request.templateKey,
    templateData: request.templateData ?? {},
    channel: request.recipient.channel,
    recipientAddress: request.recipient.address,
    recipientSubjectKind: request.recipient.subjectKind ?? null,
    recipientSubjectId: request.recipient.subjectId ?? null,
    status: "queued",
    idempotencyKey: request.idempotencyKey ?? null,
    correlationId: request.correlationId ?? null,
    queuedAt: now,
  });
  if (!created.ok) {
    if (created.error.kind === "conflict") {
      // Idempotency race: re-fetch.
      if (request.idempotencyKey) {
        const re = await repo.findNotificationByIdempotencyKey(orgUuid, request.idempotencyKey);
        if (re.ok) {
          const attempts = await repo.listAttempts(re.value.id);
          return {
            outcome: {
              status: "idempotent_hit",
              response: { notification: toDeliveryStatus(re.value, attempts.ok ? attempts.value : []) },
            },
          };
        }
      }
      return { error: { code: "conflict", status: 409, message: "Notification already exists" } };
    }
    return { error: { code: "internal_error", status: 500, message: "Failed to create notification" } };
  }
  const notification = created.value;

  await emit(deps.env, {
    type: NOTIFICATION_EVENT_TYPES.QUEUED,
    notificationId: notificationPublicId(notification.id),
    orgId: notification.orgId,
    subjectKind: "notification",
    subjectId: notificationPublicId(notification.id),
    actorType: deps.actorType,
    actorId: deps.actorId,
    requestId: deps.requestId,
    correlationId: request.correlationId ?? null,
    category: "notifications",
    description: `Notification ${notificationPublicId(notification.id)} queued`,
    payload: {
      orgId: notification.orgId,
      category: notification.category,
      templateKey: notification.templateKey,
      recipient: { channel: notification.channel, address: notification.recipientAddress },
    },
    occurredAt: now,
  });

  // Attempt 1 (synchronous fast path). Channel-aware provider resolution +
  // retry scheduling live in the shared dispatch layer (ES3); a transient
  // failure schedules next_retry_at for the async cron to pick up.
  const deliver = await deliverAttempt(
    {
      repo,
      emailProvider: provider,
      channelsRepo: deps.channelsRepo,
      encryptionKey: deps.env.SECRET_ENCRYPTION_KEY,
      consoleBaseUrl: deps.env.CONSOLE_BASE_URL,
      integrationsBinding: deps.env.INTEGRATIONS_WORKER,
      slackGroupsRepo: deps.slackGroupsRepo,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    },
    notification,
    orgUuid,
    1,
    now,
    genUuid,
  );

  const finalRow = deliver.row;

  await emit(deps.env, {
    type: deliver.ok ? NOTIFICATION_EVENT_TYPES.SENT : NOTIFICATION_EVENT_TYPES.FAILED,
    notificationId: notificationPublicId(finalRow.id),
    orgId: finalRow.orgId,
    subjectKind: "notification",
    subjectId: notificationPublicId(finalRow.id),
    actorType: deps.actorType,
    actorId: deps.actorId,
    requestId: deps.requestId,
    correlationId: request.correlationId ?? null,
    category: "notifications",
    description: deliver.ok
      ? `Notification ${notificationPublicId(finalRow.id)} sent via ${deliver.providerName}`
      : `Notification ${notificationPublicId(finalRow.id)} failed via ${deliver.providerName}`,
    payload: {
      orgId: finalRow.orgId,
      category: finalRow.category,
      templateKey: finalRow.templateKey,
      recipient: { channel: finalRow.channel, address: finalRow.recipientAddress },
      providerName: deliver.providerName,
      ...(deliver.ok ? {} : { errorReason: deliver.errorReason, willRetry: !deliver.terminal }),
    },
    occurredAt: now,
  });

  const attempts = await repo.listAttempts(finalRow.id);
  return {
    outcome: {
      status: "created",
      response: { notification: toDeliveryStatus(finalRow, attempts.ok ? attempts.value : []) },
    },
  };
}

export async function getNotificationByPublicId(
  repo: NotificationsRepository,
  publicId: string,
): Promise<{ response: GetNotificationResponse } | { error: { code: string; status: number; message: string } }> {
  const uuid = parseNotificationPublicId(publicId);
  if (!uuid) return { error: { code: "not_found", status: 404, message: "Notification not found" } };
  const got = await repo.getNotificationById(uuid);
  if (!got.ok) {
    if (got.error.kind === "not_found") return { error: { code: "not_found", status: 404, message: "Notification not found" } };
    return { error: { code: "internal_error", status: 500, message: "Failed to load notification" } };
  }
  const attempts = await repo.listAttempts(got.value.id);
  return { response: { notification: toDeliveryStatus(got.value, attempts.ok ? attempts.value : []) } };
}
