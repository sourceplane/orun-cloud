// The track-record fold (saas-agents-fleet AF7, design §6.1) — a pure
// computed read over a profile's session rows and their relayed events. The
// record is evidence, not input: everything counted here comes from
// infrastructure facts (session states, human verdicts, cost samples) an
// agent cannot author about itself; agent-answered verdicts are excluded by
// actor kind. Nothing is stored; a rate is a claim anyone can re-run.

import type { AgentSession, SessionEvent } from "@saas/db/agents";
import type { AgentProfileRecord, AgentRunKind } from "@saas/contracts/agents";
import { isTerminal } from "@saas/db/agents";

/** Events are sampled from the most recent N sessions per profile — the
 * fold stays a bounded read at fleet scale. */
export const RECORD_EVENT_SAMPLE = 25;

function isHumanPrincipal(principal: string): boolean {
  // Service principals (sp_) and the runtime's own session identity never
  // count as trust; the record measures HUMAN verdicts only (§6.1).
  return !!principal && !principal.startsWith("sp_") && !principal.startsWith("as_");
}

/**
 * computeRecord folds a profile's sessions (+ sampled events) into its
 * record. `sessions` must already be the profile's own rows; the caller
 * supplies events for whichever recent sessions it sampled.
 */
export function computeRecord(
  profilePublicId: string,
  sessions: AgentSession[],
  eventsBySession: Map<string, SessionEvent[]>,
): AgentProfileRecord {
  const byKind: Partial<Record<AgentRunKind, number>> = {};
  let completed = 0;
  let failed = 0;
  let prProduced = 0;
  let verdictAsks = 0;
  let verdictGrants = 0;
  let steers = 0;
  let tokensObserved = 0;

  for (const s of sessions) {
    byKind[s.runKind] = (byKind[s.runKind] ?? 0) + 1;
    if (s.state === "completed") completed++;
    if (s.state === "failed") failed++;
    if (isTerminal(s.state) && s.prUrl) prProduced++;

    for (const e of eventsBySession.get(s.publicId) ?? []) {
      switch (e.kind) {
        case "approval_requested":
          verdictAsks++;
          break;
        case "approval_resolved": {
          const principal = typeof e.payload.principal === "string" ? e.payload.principal : "";
          if (isHumanPrincipal(principal) && e.payload.approved === true) verdictGrants++;
          // A non-human "verdict" neither grants nor denies trust — it is
          // excluded from the numerator; the ask still counts.
          break;
        }
        case "message_user":
          steers++;
          break;
        case "cost_sample": {
          const tokens = e.payload.tokens;
          if (typeof tokens === "number" && Number.isFinite(tokens)) tokensObserved += tokens;
          break;
        }
        default:
          break;
      }
    }
  }

  const finished = completed + failed;
  return {
    profileId: profilePublicId,
    sessions: sessions.length,
    byKind,
    completed,
    failed,
    completionRate: finished > 0 ? completed / finished : null,
    prProduced,
    verdictAsks,
    verdictGrants,
    grantRate: verdictAsks > 0 ? verdictGrants / verdictAsks : null,
    steers,
    tokensObserved,
  };
}
