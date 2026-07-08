import type {
  NotificationProvider,
  ProviderSendContext,
} from "@saas/contracts/notifications";
import type {
  NotificationChannelsRepository,
  NotificationsRepository,
  StoredNotification,
} from "@saas/db/notifications";
import { asUuid, type Uuid } from "@saas/db/ids";
import { createEncryptionAdapter } from "../encryption.js";
import { createSlackWebhookProvider } from "../providers/slack-webhook.js";
import { parseChannelPublicId } from "../ids.js";

/**
 * Channel-aware send + retry dispatch (saas-event-streaming ES3). Shared by
 * the synchronous enqueue path (attempt 1) and the async retry cron
 * (attempts 2..N). The provider is resolved per-notification by channel:
 * `email` uses the injected email provider; `slack` resolves the configured
 * channel, decrypts its incoming-webhook URL, and builds a stateless Slack
 * provider for this one send.
 */

/** Bounded backoff ladder, identical to the webhooks drain: 30s·4^(n-1). */
export const MAX_NOTIFICATION_ATTEMPTS = 5;
export const RETRY_BASE_SECONDS = 30;

export function nextNotificationRetryAt(attemptNumber: number, now: Date): Date | null {
  if (attemptNumber >= MAX_NOTIFICATION_ATTEMPTS) return null;
  const delaySeconds = RETRY_BASE_SECONDS * Math.pow(4, attemptNumber - 1);
  return new Date(now.getTime() + delaySeconds * 1000);
}

export interface DispatchDeps {
  repo: NotificationsRepository;
  /** Provider for the `email` channel (cloudflare-email / local-debug). */
  emailProvider: NotificationProvider;
  /** Channel config store for `slack` (undefined ⇒ slack unavailable). */
  channelsRepo?: NotificationChannelsRepository | undefined;
  /** AES key for decrypting channel credentials (undefined ⇒ slack unavailable). */
  encryptionKey?: string | undefined;
  consoleBaseUrl?: string | undefined;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface ProviderResolution {
  ok: boolean;
  provider?: NotificationProvider;
  /** Terminal, bounded, non-secret reason when ok=false. */
  errorReason?: string;
}

export async function resolveSendProvider(
  deps: DispatchDeps,
  orgUuid: Uuid,
  channel: string,
  recipientAddress: string,
): Promise<ProviderResolution> {
  if (channel === "email") return { ok: true, provider: deps.emailProvider };
  if (channel === "slack") {
    if (!deps.channelsRepo || !deps.encryptionKey) {
      return { ok: false, errorReason: "slack_not_configured" };
    }
    const chanUuid = parseChannelPublicId(recipientAddress);
    if (!chanUuid) return { ok: false, errorReason: "invalid_channel_ref" };
    const cfg = await deps.channelsRepo.getChannelConfigForSend(orgUuid, asUuid(chanUuid));
    if (!cfg.ok) return { ok: false, errorReason: "channel_lookup_failed" };
    if (!cfg.value) return { ok: false, errorReason: "channel_not_found" };
    if (cfg.value.status !== "active") return { ok: false, errorReason: "channel_disabled" };
    const adapter = await createEncryptionAdapter(deps.encryptionKey);
    if (!adapter) return { ok: false, errorReason: "encryption_unavailable" };
    let webhookUrl: string;
    try {
      webhookUrl = await adapter.decrypt(JSON.parse(cfg.value.configCiphertext));
    } catch {
      return { ok: false, errorReason: "channel_decrypt_failed" };
    }
    return {
      ok: true,
      provider: createSlackWebhookProvider({
        webhookUrl,
        ...(deps.consoleBaseUrl ? { consoleBaseUrl: deps.consoleBaseUrl } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }),
    };
  }
  return { ok: false, errorReason: "unsupported_channel" };
}

export interface DeliverResult {
  ok: boolean;
  providerName: string;
  errorReason?: string | undefined;
  row: StoredNotification;
  /** True when no further retry is scheduled (success or exhausted/terminal). */
  terminal: boolean;
}

function sendContext(n: StoredNotification): ProviderSendContext {
  return {
    notificationId: n.id,
    orgId: n.orgId,
    category: n.category as ProviderSendContext["category"],
    templateKey: n.templateKey,
    templateData: (n.templateData as Record<string, string | number | boolean | null>) ?? {},
    recipient: {
      channel: n.channel as ProviderSendContext["recipient"]["channel"],
      address: n.recipientAddress,
      ...(n.recipientSubjectKind && n.recipientSubjectId
        ? {
            subjectKind: n.recipientSubjectKind as "user" | "organization",
            subjectId: n.recipientSubjectId,
          }
        : {}),
    },
  };
}

/**
 * Run one delivery attempt: resolve the provider, send, record the attempt,
 * and update the notification's status — scheduling the next retry on a
 * transient send failure, or clearing the schedule on success / a terminal
 * provider-config failure.
 */
export async function deliverAttempt(
  deps: DispatchDeps,
  notification: StoredNotification,
  orgUuid: Uuid,
  attemptNumber: number,
  now: Date,
  genUuid: () => string,
): Promise<DeliverResult> {
  const resolution = await resolveSendProvider(
    deps,
    orgUuid,
    notification.channel,
    notification.recipientAddress,
  );

  // Provider resolution failure is a terminal config error — no retry.
  if (!resolution.ok || !resolution.provider) {
    const reason = resolution.errorReason ?? "provider_unavailable";
    await deps.repo.recordAttempt({
      id: genUuid(),
      notificationId: notification.id,
      orgId: notification.orgId,
      attemptNumber,
      status: "failed",
      errorReason: reason,
      attemptedAt: now,
    });
    const updated = await deps.repo.markNotificationStatus({
      id: notification.id,
      orgId: notification.orgId,
      status: "failed",
      lastError: reason,
      failedAt: now,
      updatedAt: now,
      nextRetryAt: null,
      attemptCount: attemptNumber,
    });
    return {
      ok: false,
      providerName: "none",
      errorReason: reason,
      row: updated.ok ? updated.value : notification,
      terminal: true,
    };
  }

  const provider = resolution.provider;
  const sendResult = await provider.send(sendContext(notification));

  await deps.repo.recordAttempt({
    id: genUuid(),
    notificationId: notification.id,
    orgId: notification.orgId,
    attemptNumber,
    status: sendResult.ok ? "sent" : "failed",
    providerMessageId: sendResult.providerMessageId,
    errorReason: sendResult.ok ? null : sendResult.errorReason,
    attemptedAt: now,
  });

  if (sendResult.ok) {
    const updated = await deps.repo.markNotificationStatus({
      id: notification.id,
      orgId: notification.orgId,
      status: "sent",
      providerMessageId: sendResult.providerMessageId,
      lastError: null,
      sentAt: now,
      updatedAt: now,
      nextRetryAt: null,
      attemptCount: attemptNumber,
    });
    return {
      ok: true,
      providerName: provider.name,
      row: updated.ok ? updated.value : notification,
      terminal: true,
    };
  }

  const retryAt = nextNotificationRetryAt(attemptNumber, now);
  const updated = await deps.repo.markNotificationStatus({
    id: notification.id,
    orgId: notification.orgId,
    status: "failed",
    lastError: sendResult.errorReason,
    failedAt: now,
    updatedAt: now,
    nextRetryAt: retryAt,
    attemptCount: attemptNumber,
  });
  return {
    ok: false,
    providerName: provider.name,
    errorReason: sendResult.errorReason,
    row: updated.ok ? updated.value : notification,
    terminal: retryAt === null,
  };
}
