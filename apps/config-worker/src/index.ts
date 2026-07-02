import type { Env } from "./env.js";
import { route } from "./router.js";
import { runRotationSweep } from "./rotation-sweep.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  // Config-maintenance cron (SEC7). The rotation/expiry reminder sweep surfaces
  // secrets whose rotation is overdue or which are expiring, emitting
  // secret.rotation_due / secret.expiring events (metadata only — never a value).
  // config-worker owns the secret data, so the sweep lives here.
  //
  // CRON-SLOT BUDGET: this is the SINGLE cron trigger config-worker registers
  // (wrangler.template.jsonc). Future config maintenance MUST coalesce into this
  // handler, fanning out by phase, rather than registering another slot.
  // Best-effort + safe-by-default: dormant without the DB binding, bounded batch,
  // never throws out of the scheduled handler.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const swept = await runRotationSweep(env);
          if (swept && swept.reminded > 0) {
            console.warn(
              `[scheduled] rotation-sweep: ${swept.reminded} reminded / ${swept.scanned} due`,
            );
          }
        } catch (err) {
          // A sweep failure must never break the cron.
          console.error(`[scheduled] rotation-sweep failed: ${String(err)}`);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

// perf(db): reverted to per-request DB client (task 0134 connection reuse rolled back).
