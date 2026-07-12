import type { Env } from "./env.js";
import { route } from "./router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import {
  createSlackGroupMessagesRepository,
  createNotificationsRepository,
  createNotificationChannelsRepository,
} from "@saas/db/notifications";
import { resolveProvider } from "./providers/index.js";
import { retryFailedNotifications } from "./services/retry.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  // Async retry drain (saas-event-streaming ES3): re-send failed notifications
  // whose next_retry_at is due, on the webhooks-style backoff ladder. The
  // synchronous enqueue send is attempt 1; this cron does attempts 2..N.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.PLATFORM_DB) {
      console.error("[scheduled] PLATFORM_DB binding missing; skipping notification retry drain");
      return;
    }
    const executor = createSqlExecutor(env.PLATFORM_DB);
    try {
      const summary = await retryFailedNotifications({
        repo: createNotificationsRepository(executor),
        emailProvider: resolveProvider(env),
        channelsRepo: createNotificationChannelsRepository(executor),
        slackGroupsRepo: createSlackGroupMessagesRepository(executor),
        integrationsBinding: env.INTEGRATIONS_WORKER,
        encryptionKey: env.SECRET_ENCRYPTION_KEY,
        consoleBaseUrl: env.CONSOLE_BASE_URL,
        env,
      });
      if (summary.errors > 0 || summary.exhausted > 0 || summary.sent > 0) {
        console.warn(
          `[scheduled] notification retry: scanned=${summary.scanned} sent=${summary.sent} failed=${summary.failed} exhausted=${summary.exhausted} errors=${summary.errors}`,
        );
      }
    } finally {
      await executor.dispose();
    }
  },
} satisfies ExportedHandler<Env>;

// perf(db): reverted to per-request DB client (task 0134 connection reuse rolled back).
