import type { Env } from "./env.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  // Lease sweep cron (OP2): re-queue lapsed job claims (attempt+1, bounded) or
  // mark them timed_out, derive run terminal status, and emit
  // state.run.completed|failed / state.job.failed into the event log
  // (design §4.2). Not attached while OP0 is dormant — there is no run
  // coordination to sweep yet, and (like IG0) we keep the cron off until the
  // behavior it drives lands. The `scheduled` handler is reinstated at OP2.
} satisfies ExportedHandler<Env>;
