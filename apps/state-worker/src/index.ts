import type { Env } from "./env.js";
import { route } from "./router.js";
import { runSweep } from "./sweep.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
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
        const summary = await runSweep(env);
        if (summary && (summary.requeued > 0 || summary.timedOut > 0)) {
          console.warn(
            `[scheduled] lease-sweep: ${summary.requeued} requeued, ${summary.timedOut} timed_out, ` +
              `${summary.runsCompleted} runs completed, ${summary.runsFailed} runs failed`,
          );
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
