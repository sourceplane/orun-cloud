import type { NotificationProvider } from "@saas/contracts/notifications";
import type { Env } from "../env.js";
import { createLocalDebugProvider } from "./local-debug.js";

/**
 * Resolve the configured NotificationProvider for this worker instance.
 *
 * V1 supports only "local-debug". Unknown values fall back to local-debug
 * with a console warning — the worker must always have a working adapter
 * to remain deployable.
 */
export function resolveProvider(env: Env): NotificationProvider {
  const name = (env.NOTIFICATIONS_PROVIDER ?? "local-debug").toLowerCase();
  switch (name) {
    case "local-debug":
      return createLocalDebugProvider();
    default:
      // Refuse to silently route to a real provider that does not exist.
      // Logging the name (not credentials) is safe.
      console.warn(`[notifications-worker] Unknown NOTIFICATIONS_PROVIDER=${name}; falling back to local-debug.`);
      return createLocalDebugProvider();
  }
}
