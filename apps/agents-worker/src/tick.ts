// The routine scheduler tick (saas-agents-fleet AF6, design §5): every cron
// beat, fire due routines through the ONE dispatch door and reconcile the
// park latch. The tick holds no execution semantics — it decides "due or
// not" and "two consecutive failures or not"; everything else is the same
// dispatch/session machinery a human click uses.

import type { AgentsDeps } from "./deps.js";
import type { ActorContext } from "./router.js";
import { dispatchRoutineFiring } from "./handlers/dispatch.js";
import { dueSince, parseCron } from "./cron.js";
import { ROUTINE_PARK_THRESHOLD } from "@saas/contracts/agents";

/** Forget slots older than this: a worker outage fires each routine at most
 * ONCE on recovery (predicates, not backlogs — design §5.3). */
const MISFIRE_LOOKBACK_MS = 60 * 60 * 1000;
const TICK_BATCH = 100;

/** The tick's synthetic actor — firings are attributed to the scheduler;
 * the routine row carries who authorized the standing order. */
const TICK_ACTOR: ActorContext = { subjectId: "agents-worker-routines", subjectType: "service" };

export interface TickSummary {
  examined: number;
  fired: number;
  refused: number;
  parked: number;
}

/**
 * routineTick — one scheduler pass. Ordering is deliberate: reconcile the
 * park latch FIRST so a routine that just failed twice never fires a third
 * time on the same tick that should have parked it.
 */
export async function routineTick(
  deps: AgentsDeps,
  requestId: string,
  now: () => Date = () => new Date(),
): Promise<TickSummary> {
  const t = now();
  const routines = await deps.repo.listLiveRoutines(TICK_BATCH);
  const summary: TickSummary = { examined: routines.length, fired: 0, refused: 0, parked: 0 };

  for (const routine of routines) {
    const scope = { orgId: routine.orgId };

    // The park latch: the two most recent firings both failed → parked until
    // a human resumes. Reads session rows — no stored execution state.
    const recent = await deps.repo.listRoutineSessions(scope, routine.publicId, ROUTINE_PARK_THRESHOLD);
    const failures = recent.filter((s) => s.state === "failed").length;
    if (recent.length >= ROUTINE_PARK_THRESHOLD && failures === ROUTINE_PARK_THRESHOLD) {
      const reason =
        typeof recent[0]!.sandbox.error === "string" && recent[0]!.sandbox.error
          ? `${ROUTINE_PARK_THRESHOLD} consecutive failures (last: ${recent[0]!.sandbox.error})`
          : `${ROUTINE_PARK_THRESHOLD} consecutive failures`;
      await deps.repo.updateRoutineState(scope, {
        publicId: routine.publicId,
        parked: true,
        parkedReason: reason,
        consecutiveFailures: failures,
      });
      summary.parked++;
      continue;
    }

    // Only cron triggers fire from the tick; event triggers ride the ES1
    // lane consumer when it lands (stored now, inert until then).
    if (routine.triggerKind !== "cron") continue;
    const expr = typeof routine.triggerConfig.cron === "string" ? routine.triggerConfig.cron : "";
    const spec = expr ? parseCron(expr) : null;
    if (!spec) continue; // unparseable configs are create-time-validated; never throw the tick

    const floor = new Date(t.getTime() - MISFIRE_LOOKBACK_MS);
    const from = routine.lastFiredAt && Date.parse(routine.lastFiredAt) > floor.getTime()
      ? new Date(routine.lastFiredAt)
      : floor;
    if (!dueSince(spec, from, t)) continue;

    // Fire through the ONE door — the same gate function the dispatch route
    // runs, entered below HTTP authorize (the standing order IS the
    // authorization; the sweep posture for internal maintenance paths).
    const res = await dispatchRoutineFiring(deps, routine.orgId, routine.publicId, TICK_ACTOR, requestId, now);
    if (res.status === 201) summary.fired++;
    else summary.refused++;
  }

  return summary;
}
