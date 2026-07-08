import {
  deliverAttempt,
  nextNotificationRetryAt,
  resolveSendProvider,
  MAX_NOTIFICATION_ATTEMPTS,
  type DispatchDeps,
} from "@notifications-worker/services/dispatch";
import { retryFailedNotifications } from "@notifications-worker/services/retry";
import type { Env } from "@notifications-worker/env";
import type {
  NotificationChannelsRepository,
  NotificationsRepository,
  StoredNotification,
} from "@saas/db/notifications";
import type { NotificationProvider, ProviderSendResult } from "@saas/contracts/notifications";
import { asUuid } from "@saas/db/ids";

const NOW = new Date("2026-07-05T10:00:00.000Z");
const ORG = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const CHAN = "chan_0123456789abcdef0123456789abcdef";
// AES-GCM key (64 hex chars) for the slack-resolution test.
const KEY = "0".repeat(64);

function notification(overrides?: Partial<StoredNotification>): StoredNotification {
  return {
    id: "ntf-1",
    orgId: ORG,
    category: "product",
    templateKey: "event.notification",
    templateData: { title: "hi" },
    channel: "email",
    recipientAddress: "ops@acme.test",
    recipientSubjectKind: null,
    recipientSubjectId: null,
    status: "queued",
    providerMessageId: null,
    lastError: null,
    idempotencyKey: null,
    correlationId: null,
    queuedAt: NOW,
    sentAt: null,
    failedAt: null,
    updatedAt: NOW,
    nextRetryAt: null,
    attemptCount: 0,
    ...overrides,
  };
}

interface RepoCalls {
  attempts: Array<{ attemptNumber: number; status: string }>;
  marks: Array<{ status: string; nextRetryAt: Date | null | undefined; attemptCount: number | undefined }>;
}

function fakeRepo(retryable: StoredNotification[] = []): {
  repo: NotificationsRepository;
  calls: RepoCalls;
} {
  const calls: RepoCalls = { attempts: [], marks: [] };
  const repo = {
    async recordAttempt(input: { attemptNumber: number; status: string }) {
      calls.attempts.push({ attemptNumber: input.attemptNumber, status: input.status });
      return { ok: true as const, value: {} };
    },
    async markNotificationStatus(input: { status: string; nextRetryAt?: Date | null; attemptCount?: number }) {
      calls.marks.push({ status: input.status, nextRetryAt: input.nextRetryAt, attemptCount: input.attemptCount });
      return { ok: true as const, value: notification({ status: input.status }) };
    },
    async listRetryableNotifications() {
      return { ok: true as const, value: retryable };
    },
  } as unknown as NotificationsRepository;
  return { repo, calls };
}

function provider(result: ProviderSendResult): NotificationProvider {
  return { name: "test-email", async send() { return result; } };
}

const OK: ProviderSendResult = { ok: true, providerMessageId: "m1" };
const FAIL: ProviderSendResult = { ok: false, providerMessageId: null, errorReason: "boom" };

describe("retry ladder", () => {
  it("schedules 30s·4^(n-1) then terminates at MAX_ATTEMPTS", () => {
    expect(nextNotificationRetryAt(1, NOW)!.getTime() - NOW.getTime()).toBe(30_000);
    expect(nextNotificationRetryAt(2, NOW)!.getTime() - NOW.getTime()).toBe(120_000);
    expect(nextNotificationRetryAt(MAX_NOTIFICATION_ATTEMPTS, NOW)).toBeNull();
  });
});

describe("deliverAttempt", () => {
  it("success clears the retry schedule", async () => {
    const { repo, calls } = fakeRepo();
    const deps: DispatchDeps = { repo, emailProvider: provider(OK) };
    const result = await deliverAttempt(deps, notification(), asUuid(ORG), 1, NOW, () => "id");
    expect(result.ok).toBe(true);
    expect(result.terminal).toBe(true);
    expect(calls.marks[0]).toEqual({ status: "sent", nextRetryAt: null, attemptCount: 1 });
  });

  it("transient failure schedules a retry (non-terminal)", async () => {
    const { repo, calls } = fakeRepo();
    const deps: DispatchDeps = { repo, emailProvider: provider(FAIL) };
    const result = await deliverAttempt(deps, notification(), asUuid(ORG), 1, NOW, () => "id");
    expect(result.ok).toBe(false);
    expect(result.terminal).toBe(false);
    expect(calls.marks[0]!.status).toBe("failed");
    expect(calls.marks[0]!.nextRetryAt).not.toBeNull();
    expect(calls.marks[0]!.attemptCount).toBe(1);
  });

  it("exhausted attempts terminate without a further retry", async () => {
    const { repo, calls } = fakeRepo();
    const deps: DispatchDeps = { repo, emailProvider: provider(FAIL) };
    const result = await deliverAttempt(deps, notification(), asUuid(ORG), MAX_NOTIFICATION_ATTEMPTS, NOW, () => "id");
    expect(result.terminal).toBe(true);
    expect(calls.marks[0]!.nextRetryAt).toBeNull();
  });

  it("slack channel with no channel store is a terminal config failure (no retry)", async () => {
    const { repo, calls } = fakeRepo();
    const deps: DispatchDeps = { repo, emailProvider: provider(OK) };
    const result = await deliverAttempt(
      deps,
      notification({ channel: "slack", recipientAddress: CHAN }),
      asUuid(ORG),
      1,
      NOW,
      () => "id",
    );
    expect(result.ok).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.errorReason).toBe("slack_not_configured");
    expect(calls.marks[0]!.nextRetryAt).toBeNull();
  });
});

describe("resolveSendProvider (slack)", () => {
  it("decrypts the channel config and builds a slack provider", async () => {
    // Encrypt a URL with the same adapter the resolver uses.
    const { createEncryptionAdapter } = await import("@notifications-worker/encryption");
    const adapter = (await createEncryptionAdapter(KEY))!;
    const envelope = await adapter.encrypt("https://hooks.slack.com/services/T/B/x");

    const channelsRepo = {
      async getChannelConfigForSend() {
        return {
          ok: true as const,
          value: { id: "c", orgId: ORG, kind: "slack_incoming_webhook", status: "active", configCiphertext: JSON.stringify(envelope) },
        };
      },
    } as unknown as NotificationChannelsRepository;

    const { repo } = fakeRepo();
    const resolution = await resolveSendProvider(
      { repo, emailProvider: provider(OK), channelsRepo, encryptionKey: KEY },
      asUuid(ORG),
      "slack",
      CHAN,
    );
    expect(resolution.ok).toBe(true);
    expect(resolution.provider?.name).toBe("slack-incoming-webhook");
  });

  it("a disabled channel resolves to a terminal reason", async () => {
    const channelsRepo = {
      async getChannelConfigForSend() {
        return { ok: true as const, value: { id: "c", orgId: ORG, kind: "slack_incoming_webhook", status: "disabled", configCiphertext: "x" } };
      },
    } as unknown as NotificationChannelsRepository;
    const { repo } = fakeRepo();
    const resolution = await resolveSendProvider(
      { repo, emailProvider: provider(OK), channelsRepo, encryptionKey: KEY },
      asUuid(ORG),
      "slack",
      CHAN,
    );
    expect(resolution.ok).toBe(false);
    expect(resolution.errorReason).toBe("channel_disabled");
  });
});

describe("retryFailedNotifications drain", () => {
  const env = { ENVIRONMENT: "test" } as unknown as Env;

  it("re-sends due rows and counts outcomes; emits only terminal lifecycle events", async () => {
    const due = notification({ status: "failed", nextRetryAt: NOW, attemptCount: 1 });
    const { repo, calls } = fakeRepo([due]);
    const emitted: string[] = [];
    const summary = await retryFailedNotifications({
      repo,
      emailProvider: provider(OK),
      env,
      now: () => NOW,
      generateUuid: () => "id",
      emit: (async (_e: unknown, input: { type: string }) => {
        emitted.push(input.type);
      }) as never,
    });
    expect(summary.scanned).toBe(1);
    expect(summary.sent).toBe(1);
    // Attempt number is attempt_count + 1.
    expect(calls.attempts[0]!.attemptNumber).toBe(2);
    expect(emitted).toEqual(["notification.sent"]);
  });

  it("does not emit for a still-retrying row", async () => {
    const due = notification({ status: "failed", nextRetryAt: NOW, attemptCount: 1 });
    const { repo } = fakeRepo([due]);
    const emitted: string[] = [];
    await retryFailedNotifications({
      repo,
      emailProvider: provider(FAIL),
      env,
      now: () => NOW,
      generateUuid: () => "id",
      emit: (async (_e: unknown, input: { type: string }) => {
        emitted.push(input.type);
      }) as never,
    });
    // attempt 2 failed but retries remain → no terminal event.
    expect(emitted).toEqual([]);
  });
});
