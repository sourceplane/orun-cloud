import type { NotificationsRepository } from "@saas/db/notifications";
import { asUuid } from "@saas/db/ids";
import type { Env } from "../env.js";
import { notificationPublicId } from "../ids.js";
import { NOTIFICATION_EVENT_TYPES } from "@saas/contracts/notifications";
import { emitEvent } from "../events-client.js";
import { deliverAttempt, type DispatchDeps } from "./dispatch.js";

const RETRY_BATCH = 100;

export interface RetryDeps extends DispatchDeps {
  repo: NotificationsRepository;
  env: Env;
  now?: () => Date;
  generateUuid?: () => string;
  emit?: typeof emitEvent;
}

export interface RetrySummary {
  scanned: number;
  sent: number;
  failed: number;
  exhausted: number;
  errors: number;
}

/**
 * Async retry drain (saas-event-streaming ES3). Picks up failed notifications
 * whose next_retry_at is due and re-attempts delivery on the backoff ladder.
 * Each row's attempt_count is monotone (attempt 1 was the synchronous enqueue
 * send), so the next attempt is attempt_count + 1. A terminal failure
 * (exhausted retries) or a success clears next_retry_at so the row is not
 * re-scanned. Mirrors webhooks-worker's retryFailedDeliveries.
 */
export async function retryFailedNotifications(deps: RetryDeps): Promise<RetrySummary> {
  const summary: RetrySummary = { scanned: 0, sent: 0, failed: 0, exhausted: 0, errors: 0 };
  const now = deps.now ? deps.now() : new Date();
  const genUuid = deps.generateUuid ?? (() => crypto.randomUUID());
  const emit = deps.emit ?? emitEvent;

  const due = await deps.repo.listRetryableNotifications(RETRY_BATCH);
  if (!due.ok) {
    summary.errors++;
    return summary;
  }

  for (const notification of due.value) {
    summary.scanned++;
    const orgUuid = asUuid(notification.orgId);
    const attemptNumber = notification.attemptCount + 1;

    let result;
    try {
      result = await deliverAttempt(deps, notification, orgUuid, attemptNumber, now, genUuid);
    } catch {
      summary.errors++;
      continue;
    }

    if (result.ok) {
      summary.sent++;
    } else if (result.terminal) {
      summary.exhausted++;
    } else {
      summary.failed++;
    }

    // Emit the terminal lifecycle event only (retries in flight stay quiet to
    // avoid a storm of notification.failed for the same row).
    if (result.ok || result.terminal) {
      await emit(deps.env, {
        type: result.ok ? NOTIFICATION_EVENT_TYPES.SENT : NOTIFICATION_EVENT_TYPES.FAILED,
        notificationId: notificationPublicId(result.row.id),
        orgId: result.row.orgId,
        subjectKind: "notification",
        subjectId: notificationPublicId(result.row.id),
        actorType: "system",
        actorId: "notifications-worker",
        requestId: genUuid(),
        correlationId: result.row.correlationId,
        category: "notifications",
        description: result.ok
          ? `Notification ${notificationPublicId(result.row.id)} sent via ${result.providerName} (retry ${attemptNumber})`
          : `Notification ${notificationPublicId(result.row.id)} failed permanently after ${attemptNumber} attempts`,
        payload: {
          orgId: result.row.orgId,
          category: result.row.category,
          templateKey: result.row.templateKey,
          recipient: { channel: result.row.channel, address: result.row.recipientAddress },
          providerName: result.providerName,
          attemptNumber,
          ...(result.ok ? {} : { errorReason: result.errorReason }),
        },
        occurredAt: now,
      });
    }
  }

  return summary;
}
