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
  StoredNotification,
  StoredNotificationAttempt,
} from "@saas/db/notifications";
import type { Uuid } from "@saas/db/ids";
import type { Env } from "../env.js";
import { notificationPublicId, parseNotificationPublicId, parseOrgIdInput } from "../ids.js";
import { emitEvent } from "../events-client.js";
import { deliverAttempt } from "./dispatch.js";
import { expandTeamRecipients, resolveTeamHandle } from "../team-expansion.js";

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
    const isTeam = recipient.subjectKind === "team";
    // ES3: email (address = email) or slack (address = chan_<hex> channel id).
    if (recipient.channel !== "email" && recipient.channel !== "slack") {
      errors["recipient.channel"] = ['Must be "email" or "slack"'];
    } else if (isTeam) {
      // teams-collaboration TC1: a team target is expanded to its members at
      // send time, so `address` is a free-form team label (not email-validated)
      // and only the email channel is supported.
      if (recipient.channel !== "email") {
        errors["recipient.channel"] = ['Team targets support only the "email" channel'];
      }
      if (typeof recipient.address !== "string" || recipient.address.length === 0) {
        errors["recipient.address"] = ["Required"];
      }
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
    if (
      recipient.subjectKind !== undefined &&
      recipient.subjectKind !== "user" &&
      recipient.subjectKind !== "organization" &&
      recipient.subjectKind !== "team"
    ) {
      errors["recipient.subjectKind"] = ['Must be "user", "organization", or "team"'];
    }
    if (isTeam && (typeof recipient.subjectId !== "string" || recipient.subjectId.length === 0)) {
      errors["recipient.subjectId"] = ["Required for a team target"];
    } else if (recipient.subjectId !== undefined && typeof recipient.subjectId !== "string") {
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
  const now = deps.now ? deps.now() : new Date();
  const genUuid = deps.generateUuid ?? (() => crypto.randomUUID());
  const emit = deps.emit ?? emitEvent;

  // notifications.org_id is a UUID column; decode the incoming org id (public
  // `org_<hex>` form or a bare UUID) into a branded Uuid before any repo call.
  const orgUuid = parseOrgIdInput(request.orgId);
  if (!orgUuid) {
    return { error: { code: "validation_error", status: 422, message: "Invalid org id" } };
  }

  // teams-collaboration TC1: a team target is not a delivery identity. Expand
  // it to its active members' emails (live, no backfill) and fan out — one
  // delivery per member, each subject to org suppression independently.
  if (request.recipient.subjectKind === "team") {
    return enqueueTeamFanOut(deps, request, orgUuid, now, genUuid, emit);
  }

  return deliverToRecipient(
    deps,
    request,
    orgUuid,
    {
      channel: request.recipient.channel,
      address: request.recipient.address,
      subjectKind: request.recipient.subjectKind ?? null,
      subjectId: request.recipient.subjectId ?? null,
    },
    request.idempotencyKey,
    now,
    genUuid,
    emit,
  );
}

/** Resolved delivery identity for a single send (single recipient or one team member). */
interface ResolvedRecipient {
  channel: EnqueueNotificationRequest["recipient"]["channel"];
  address: string;
  subjectKind: string | null;
  subjectId: string | null;
}

/**
 * Enqueue + synchronously send to exactly one address. Runs the idempotency
 * short-circuit, the suppression short-circuit, the row write, delivery attempt
 * 1, and the queued/sent/failed events. Shared by the single-recipient path and
 * each team-member fan-out leg (TC1).
 */
async function deliverToRecipient(
  deps: NotificationsServiceDeps,
  request: EnqueueNotificationRequest,
  orgUuid: Uuid,
  recipient: ResolvedRecipient,
  idempotencyKey: string | undefined,
  now: Date,
  genUuid: () => string,
  emit: NonNullable<NotificationsServiceDeps["emit"]>,
  opts?: { preferenceSkip?: boolean },
): Promise<{ outcome: EnqueueOutcome } | { error: { code: string; status: number; message: string } }> {
  const { repo, provider } = deps;

  // Idempotency check.
  if (idempotencyKey) {
    const existing = await repo.findNotificationByIdempotencyKey(orgUuid, idempotencyKey);
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

  // Suppression short-circuit. Two paths land here: an address-level org
  // suppression (bounce/complaint — the absolute ceiling) or a TC2 preference
  // opt-out (`preferenceSkip`). Either records a `suppressed` row (auditable,
  // never sent) rather than a live delivery.
  const addressSuppressed = await repo.isSuppressed(orgUuid, recipient.channel, recipient.address);
  const suppress = opts?.preferenceSkip === true || (addressSuppressed.ok && addressSuppressed.value);
  if (suppress) {
    const reason = opts?.preferenceSkip ? "preference opt-out" : "suppression";
    const id = genUuid();
    const create = await repo.createNotification({
      id,
      orgId: orgUuid,
      category: request.category,
      templateKey: request.templateKey,
      templateData: request.templateData ?? {},
      channel: recipient.channel,
      recipientAddress: recipient.address,
      recipientSubjectKind: recipient.subjectKind,
      recipientSubjectId: recipient.subjectId,
      status: "suppressed",
      idempotencyKey: idempotencyKey ?? null,
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
      description: `Notification ${notificationPublicId(create.value.id)} short-circuited by ${reason}`,
      payload: {
        orgId: request.orgId,
        category: request.category,
        templateKey: request.templateKey,
        recipient: { channel: recipient.channel, address: recipient.address },
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
    channel: recipient.channel,
    recipientAddress: recipient.address,
    recipientSubjectKind: recipient.subjectKind,
    recipientSubjectId: recipient.subjectId,
    status: "queued",
    idempotencyKey: idempotencyKey ?? null,
    correlationId: request.correlationId ?? null,
    queuedAt: now,
  });
  if (!created.ok) {
    if (created.error.kind === "conflict") {
      // Idempotency race: re-fetch.
      if (idempotencyKey) {
        const re = await repo.findNotificationByIdempotencyKey(orgUuid, idempotencyKey);
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

/**
 * Read one preference row's toggle for a category. Returns `null` when the row
 * (or the category key) is not configured — the cascade treats that as "defer
 * to the next level", not as an opt-out.
 */
async function categoryToggle(
  repo: NotificationsRepository,
  orgUuid: Uuid,
  subjectKind: "user" | "team" | "organization",
  subjectId: string,
  category: string,
  channel: string,
): Promise<boolean | null> {
  const list = await repo.listPreferences(orgUuid, subjectKind, subjectId, channel);
  if (!list.ok || list.value.length === 0) return null;
  // The (org, subjectKind, subjectId, channel) index is unique — at most one row.
  const categories = list.value[0]!.categories as Record<string, boolean | null | undefined>;
  const v = categories[category];
  return v === true || v === false ? v : null;
}

/**
 * teams-collaboration TC2: resolve whether a team member wants a category on a
 * channel, by the preference cascade — member-override → team-default →
 * org-default → opt-in default. The first level that has an explicit toggle
 * wins; an unset level defers downward. Org suppression is enforced separately
 * (in deliverToRecipient) as the absolute ceiling, so it is not part of this
 * opt-in/opt-out resolution.
 */
async function memberWantsCategory(
  repo: NotificationsRepository,
  orgUuid: Uuid,
  orgPublicId: string,
  teamId: string,
  memberSubjectId: string,
  category: string,
  channel: string,
): Promise<boolean> {
  const member = await categoryToggle(repo, orgUuid, "user", memberSubjectId, category, channel);
  if (member !== null) return member;
  const team = await categoryToggle(repo, orgUuid, "team", teamId, category, channel);
  if (team !== null) return team;
  const org = await categoryToggle(repo, orgUuid, "organization", orgPublicId, category, channel);
  if (org !== null) return org;
  return true; // no level configured ⇒ transactional opt-in default.
}

/**
 * Expand a team target to its active members and send one notification per
 * member (teams-collaboration TC1). Each leg records a per-member `user`
 * delivery row and is gated by org suppression independently, so org
 * suppression still wins per address. A per-member idempotency key
 * (`<base>:<subjectId>`) keeps re-sends idempotent while letting a roster grow
 * between sends. The aggregate response carries the first delivery as
 * `notification` and the full set as `deliveries`.
 *
 * teams-collaboration TC2: before each leg, the preference cascade
 * (member-override → team-default → org-default) decides whether the member
 * wants this category. An opted-out member is skipped — they leave no delivery
 * row and stay on the team. Org suppression remains the absolute ceiling
 * (checked in deliverToRecipient), independent of any team default.
 */
async function enqueueTeamFanOut(
  deps: NotificationsServiceDeps,
  request: EnqueueNotificationRequest,
  orgUuid: Uuid,
  now: Date,
  genUuid: () => string,
  emit: NonNullable<NotificationsServiceDeps["emit"]>,
): Promise<{ outcome: EnqueueOutcome } | { error: { code: string; status: number; message: string } }> {
  // TC2: the target may be a `team_<hex>` id or an `@handle` mention. Resolve a
  // handle to its team id first (unknown handle ⇒ 422, transport failure ⇒ 503).
  let teamId = request.recipient.subjectId!;
  if (!teamId.startsWith("team_")) {
    const resolved = await resolveTeamHandle(deps.env.MEMBERSHIP_WORKER, request.orgId, teamId, deps.requestId);
    if (!resolved.ok) {
      return resolved.reason === "not_found"
        ? { error: { code: "not_found", status: 422, message: "No team owns that handle" } }
        : { error: { code: "service_unavailable", status: 503, message: "Team handle resolution unavailable" } };
    }
    teamId = resolved.teamId;
  }
  const expansion = await expandTeamRecipients(deps.env.MEMBERSHIP_WORKER, deps.env.IDENTITY_WORKER, teamId, deps.requestId);
  if (!expansion.ok) {
    return { error: { code: "service_unavailable", status: 503, message: "Team roster resolution unavailable" } };
  }
  if (expansion.recipients.length === 0) {
    return { error: { code: "no_recipients", status: 422, message: "Team has no active members with a deliverable address" } };
  }

  const deliveries: NotificationDeliveryStatus[] = [];
  let lastError: { code: string; status: number; message: string } | undefined;
  for (const member of expansion.recipients) {
    // TC2 preference cascade: an opted-out member gets a `suppressed` row
    // (auditable, never sent) while remaining on the team. Org suppression is
    // enforced below in deliverToRecipient regardless of this decision.
    const wants = await memberWantsCategory(
      deps.repo,
      orgUuid,
      request.orgId,
      teamId,
      member.subjectId,
      request.category,
      "email",
    );
    const perMemberKey = request.idempotencyKey ? `${request.idempotencyKey}:${member.subjectId}` : undefined;
    const res = await deliverToRecipient(
      deps,
      request,
      orgUuid,
      { channel: "email", address: member.address, subjectKind: "user", subjectId: member.subjectId },
      perMemberKey,
      now,
      genUuid,
      emit,
      wants ? undefined : { preferenceSkip: true },
    );
    if ("error" in res) {
      lastError = res.error;
      continue;
    }
    deliveries.push(res.outcome.response.notification);
  }

  if (deliveries.length === 0) {
    return { error: lastError ?? { code: "internal_error", status: 500, message: "Failed to deliver to team" } };
  }

  return {
    outcome: {
      status: "created",
      response: { notification: deliveries[0]!, deliveries },
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
