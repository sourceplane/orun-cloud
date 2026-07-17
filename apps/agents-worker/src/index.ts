// agents-worker — the agent-session control plane (saas-agents AG5–AG11).
//
// The runtime that runs an agent is the orun binary (orun/specs/orun-agents/);
// this worker HOSTS it: it provisions a sandbox, mints a session-scoped
// credential, relays the session's event stream, and dispatches. It holds no
// agent semantics, no tool policy, no task state — a client of the platform's
// public surfaces, its blast radius a service principal's.

import type { Env } from "./env.js";
import { route } from "./router.js";
import { buildDeps, ready } from "./deps.js";
import { sweepLapsedSessions } from "./sweep.js";
import { routineTick } from "./tick.js";

// The per-session attach relay DOs. Exported so the Workers runtime can
// instantiate the classes named in wrangler's durable_objects bindings:
// `AttachRelay` (saas-agents-native AN1 — the SDK relay, WS + hibernation)
// carries new sessions; `SessionRelay` (saas-agents-live AL6) drains old ones
// and is deleted one release after the cutover (AN lock 7).
export { AttachRelay } from "./attach-relay.js";
export { SessionRelay } from "./relay-do.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  // The lease sweep (design §4.3) + the routine scheduler tick (fleet AF6):
  // every beat reclaims lapsed sessions/orphans and fires due routines
  // through the dispatch gates. Skips silently when the worker is unbound
  // (the AG5 dormant posture deploys everywhere; the cron only bites where
  // wired).
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!ready(env)) return;
    const deps = buildDeps(env);
    ctx.waitUntil(
      (async () => {
        try {
          const summary = await sweepLapsedSessions(deps, `sweep_${Date.now()}`);
          if (summary.examined > 0) {
            console.warn(
              `[agents-sweep] examined=${summary.examined} reclaimed=${summary.reclaimed} destroyed=${summary.destroyed} destroyErrors=${summary.destroyErrors} orphaned=${summary.orphaned}`,
            );
          }
          const tick = await routineTick(deps, `tick_${Date.now()}`);
          if (tick.fired > 0 || tick.parked > 0 || tick.refused > 0) {
            console.warn(
              `[agents-routines] examined=${tick.examined} fired=${tick.fired} refused=${tick.refused} parked=${tick.parked}`,
            );
          }
        } finally {
          await deps.dispose();
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
