import type {
  NotificationProvider,
  ProviderSendContext,
  ProviderSendResult,
} from "@saas/contracts/notifications";

/**
 * Local-debug provider.
 *
 * The only V1-shipped NotificationProvider. It does NOT contact any external
 * service. Each call returns a synthetic provider message id and reports
 * success; the worker is responsible for persisting that result through the
 * notifications repository.
 *
 * Safe for stage and prod under the explicit V1 carve-out in spec 14: real
 * provider integration (Resend / Postmark / SES) is a deliberate follow-up.
 *
 * The provider intentionally accepts no credential material via its
 * factory — there are no secrets to inject.
 */
export function createLocalDebugProvider(): NotificationProvider {
  return {
    name: "local-debug",
    async send(ctx: ProviderSendContext): Promise<ProviderSendResult> {
      // The synthetic id is deterministic-shaped so operators can identify
      // local-debug traffic in dashboards; it MUST NOT be treated as a
      // routable provider reference.
      const providerMessageId = `local-debug-${ctx.notificationId}`;
      return { ok: true, providerMessageId };
    },
  };
}
