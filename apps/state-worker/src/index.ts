import type { Env } from "./env.js";
import { route } from "./router.js";
import { runSweep } from "./sweep.js";
import { runScmDrain } from "./scm-bridge.js";
import { runRunWriteback } from "./run-writeback.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(request, env, ctx);
  },

  // Lease sweep cron (OP2 — design §4.2): re-queue lapsed job claims (attempt+1,
  // bounded) or mark them timed_out, derive run terminal status, and emit
  // state.run.completed|failed / state.job.failed into the event log. This is
  // what makes runs survive killed laptops.
  //
  // CRON-SLOT BUDGET (risk R9): this is the SINGLE cron trigger state-worker
  // registers (wrangler.template.jsonc). Future state maintenance (OP9
  // retention/GC) MUST coalesce into this same handler, fanning out by phase,
  // rather than registering another cron slot.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        // Phase 1 — lease sweep (OP2).
        const summary = await runSweep(env);
        if (summary && (summary.requeued > 0 || summary.timedOut > 0)) {
          console.warn(
            `[scheduled] lease-sweep: ${summary.requeued} requeued, ${summary.timedOut} timed_out, ` +
              `${summary.runsCompleted} runs completed, ${summary.runsFailed} runs failed`,
          );
        }
        // Phase 2 — scm.* → state.triggers drain (OV4 inbound bridge). Coalesced
        // into this same cron slot (risk R9), after the sweep.
        try {
          const drained = await runScmDrain(env);
          if (drained && drained.recorded > 0) {
            console.warn(
              `[scheduled] scm-drain: ${drained.recorded} recorded, ${drained.skipped} skipped, ` +
                `${drained.scanned} scanned`,
            );
          }
        } catch (err) {
          // A drain failure must never break the sweep phase or the cron.
          console.error(`[scheduled] scm-drain failed: ${String(err)}`);
        }
        // Phase 3 — run-result → GitHub write-back (OV5/IG9 outbound bridge).
        // Coalesced into this same cron slot (risk R9), after the scm drain.
        // Dormant (no-op) until the integrations-worker binding + GitHub App
        // (D1) exist; never breaks the prior phases or the cron.
        try {
          const posted = await runRunWriteback(env);
          if (posted && (posted.posted > 0 || posted.failed > 0)) {
            console.warn(
              `[scheduled] run-writeback: ${posted.posted} posted, ${posted.failed} failed, ` +
                `${posted.skipped} skipped, ${posted.scanned} scanned`,
            );
          }
        } catch (err) {
          console.error(`[scheduled] run-writeback failed: ${String(err)}`);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
