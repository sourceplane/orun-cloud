import type { Env } from "./env.js";
import { route } from "./router.js";

// Per-connection mint-serialization Durable Object (IH6 custody). Re-exported
// so the runtime can bind it (wrangler durable_objects → ConnectionMintLock).
export { ConnectionMintLock } from "./mint-lock-do.js";
import { drainInboundDeliveries } from "./drain.js";
import { runExpirySweep } from "./expiry-sweep.js";
import { runCloudflareHealth } from "./health-cloudflare.js";
import { runSupabaseHealth } from "./health-supabase.js";
import { runOrphanSweep } from "./orphan-sweep.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";

/** Daily off-peak slot for the orphan reconcile sweep (IH9) — the same gate
 *  style as events-worker's RETENTION_SWEEP_UTC_HOUR. */
const ORPHAN_SWEEP_UTC_HOUR = 4;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  // Integrations-maintenance cron, fanned out by phase (the state-worker
  // cron-slot discipline, risk R9): ONE trigger (crons: ["* * * * *"] in
  // wrangler.template.jsonc), each phase in its own try/catch so a failure
  // never breaks the later phases. Hour/minute gates derive from
  // controller.scheduledTime — never Date.now() — so a delayed invocation
  // still runs the slot it was scheduled for.
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.PLATFORM_DB) {
      return;
    }
    const executor = createSqlExecutor(env.PLATFORM_DB);
    const scheduledAt = new Date(controller.scheduledTime);
    const utcHour = scheduledAt.getUTCHours();
    const utcMinute = scheduledAt.getUTCMinutes();
    try {
      // Phase 1 — inbox drain (IG2): attribute received inbound deliveries to
      // connections, process provider lifecycle events, emit `scm.*`. Every tick.
      try {
        const summary = await drainInboundDeliveries(executor, env);
        if (summary.processed > 0) {
          console.warn(
            `[scheduled] drain: ${summary.emitted} emitted, ${summary.skipped} skipped, ${summary.retried} retried, ${summary.failed} failed`,
          );
        }
      } catch (err) {
        console.error(`[scheduled] drain failed: ${String(err)}`);
      }

      // Phase 2 — minted-credential expiry sweep (IH9): flip past-due pending
      // ledger rows to expired ("TTL is the backstop"). Every tick.
      try {
        const expired = await runExpirySweep(executor, { now: scheduledAt });
        if (expired.expired > 0) {
          console.warn(`[scheduled] expiry-sweep: ${expired.expired} mints expired`);
        }
      } catch (err) {
        console.error(`[scheduled] expiry-sweep failed: ${String(err)}`);
      }

      // Phases 3+4 — connection health (IH9 §5.2/§5.3): hourly, on the hour.
      if (utcMinute === 0) {
        try {
          const cf = await runCloudflareHealth(env, executor, { now: scheduledAt });
          if (cf.checked > 0 || cf.failures > 0) {
            console.warn(
              `[scheduled] cloudflare-health: ${cf.checked} checked, ${cf.invalid} invalid, ${cf.expiring} expiring, ${cf.failures} failures`,
            );
          }
        } catch (err) {
          console.error(`[scheduled] cloudflare-health failed: ${String(err)}`);
        }
        try {
          const sb = await runSupabaseHealth(env, executor, { now: scheduledAt });
          if (sb.checked > 0 || sb.failures > 0) {
            console.warn(
              `[scheduled] supabase-health: ${sb.checked} checked, ${sb.suspended} suspended, ${sb.refreshed} refreshed, ${sb.failures} failures`,
            );
          }
        } catch (err) {
          console.error(`[scheduled] supabase-health failed: ${String(err)}`);
        }
      }

      // Phase 5 — orphan-mint reconcile sweep (IH9): daily, off-peak.
      if (utcHour === ORPHAN_SWEEP_UTC_HOUR && utcMinute === 0) {
        try {
          const orphans = await runOrphanSweep(env, executor, { now: scheduledAt });
          if (orphans.accounts > 0 || orphans.failures > 0) {
            console.warn(
              `[scheduled] orphan-sweep: ${orphans.accounts} accounts, ${orphans.orphansRevoked} orphans revoked, ${orphans.ledgerReconciled} ledger reconciled, ${orphans.failures} failures`,
            );
          }
        } catch (err) {
          console.error(`[scheduled] orphan-sweep failed: ${String(err)}`);
        }
      }
    } finally {
      if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
        await (executor as unknown as { dispose: () => Promise<void> }).dispose();
      }
    }
  },
} satisfies ExportedHandler<Env>;
